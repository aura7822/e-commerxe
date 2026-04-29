import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash } from 'crypto';

import { AnalyticsEvent, EventType } from './entities/analytics-event.entity';
import { RedisService } from '../auth/redis/redis.service';
import { User } from '../users/entities/user.entity';

export interface TrackEventDto {
  business_id: string;
  event_type: EventType;
  session_id: string;       // opaque hash from frontend
  referrer?: string;        // domain only (no path)
  cta_label?: string;
}

export interface DashboardStats {
  business_id: string;
  period_days: 7 | 30 | 90;
  views: number;
  clicks: number;
  cta_actions: number;
  unique_sessions: number;
  top_referrers: Array<{ domain: string; count: number }>;
  daily_breakdown: Array<{ date: string; views: number; clicks: number }>;
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    @InjectRepository(AnalyticsEvent)
    private readonly eventRepo: Repository<AnalyticsEvent>,
    private readonly dataSource: DataSource,
    private readonly redis: RedisService,
  ) {}

  // ─── Track Event ─────────────────────────────────────────────────────────

  /**
   * Fast path: increment Redis counter immediately.
   * Slow path: persist to PostgreSQL in batches every hour (via cron).
   * IP is anonymized — last octet zeroed before hashing.
   */
  async track(dto: TrackEventDto, rawIp: string, tenantId: string): Promise<void> {
    const ipHash = this.anonymizeIp(rawIp);
    const referrer = this.extractDomain(dto.referrer);

    // ── Redis real-time counters ─────────────────────────────────────
    const dateKey = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    await Promise.all([
      this.redis.incr(`analytics:${dto.business_id}:${dto.event_type}:${dateKey}`),
      this.redis.expire(`analytics:${dto.business_id}:${dto.event_type}:${dateKey}`, 7 * 24 * 3600),
      // Queue for batch DB write
      this.redis.rpush(
        'queue:analytics_events',
        JSON.stringify({
          tenant_id: tenantId,
          business_id: dto.business_id,
          event_type: dto.event_type,
          ip_hash: ipHash,
          session_id: dto.session_id,
          referrer,
          cta_label: dto.cta_label ?? null,
          timestamp: new Date().toISOString(),
        }),
      ),
    ]);
  }

  // ─── Dashboard ───────────────────────────────────────────────────────────

  async getDashboard(
    businessId: string,
    owner: User,
    days: 7 | 30 | 90 = 30,
  ): Promise<DashboardStats> {
    const cacheKey = `dashboard:${businessId}:${days}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as DashboardStats;

    // Aggregate from PostgreSQL (read replica in production)
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [aggregates, topReferrers, dailyBreakdown] = await Promise.all([
      // Total counts by type
      this.dataSource.query(
        `
        SELECT
          event_type,
          COUNT(*) AS total,
          COUNT(DISTINCT session_id) AS unique_sessions
        FROM analytics_events
        WHERE business_id = $1
          AND tenant_id = $2
          AND timestamp >= $3
        GROUP BY event_type
        `,
        [businessId, owner.tenant_id!, since],
      ),

      // Top referrers
      this.dataSource.query(
        `
        SELECT referrer AS domain, COUNT(*) AS count
        FROM analytics_events
        WHERE business_id = $1
          AND tenant_id = $2
          AND timestamp >= $3
          AND referrer IS NOT NULL
        GROUP BY referrer
        ORDER BY count DESC
        LIMIT 10
        `,
        [businessId, owner.tenant_id!, since],
      ),

      // Daily breakdown
      this.dataSource.query(
        `
        SELECT
          DATE(timestamp) AS date,
          COUNT(*) FILTER (WHERE event_type = 'view')  AS views,
          COUNT(*) FILTER (WHERE event_type = 'click') AS clicks
        FROM analytics_events
        WHERE business_id = $1
          AND tenant_id = $2
          AND timestamp >= $3
        GROUP BY DATE(timestamp)
        ORDER BY date ASC
        `,
        [businessId, owner.tenant_id!, since],
      ),
    ]);

    const byType = (type: string): { total: number; unique_sessions: number } =>
      aggregates.find((r: { event_type: string }) => r.event_type === type) ?? { total: 0, unique_sessions: 0 };

    const stats: DashboardStats = {
      business_id: businessId,
      period_days: days,
      views: Number(byType('view').total),
      clicks: Number(byType('click').total),
      cta_actions: Number(byType('cta').total),
      unique_sessions: Number(byType('view').unique_sessions),
      top_referrers: topReferrers.map((r: { domain: string; count: string }) => ({
        domain: r.domain,
        count: Number(r.count),
      })),
      daily_breakdown: dailyBreakdown.map((r: { date: string; views: string; clicks: string }) => ({
        date: r.date,
        views: Number(r.views),
        clicks: Number(r.clicks),
      })),
    };

    await this.redis.set(cacheKey, JSON.stringify(stats), 300); // 5-min cache
    return stats;
  }

  // ─── Cron: Batch flush Redis queue → PostgreSQL ──────────────────────────

  @Cron(CronExpression.EVERY_HOUR)
  async flushEventQueue(): Promise<void> {
    const batchSize = 1000;
    const events: AnalyticsEvent[] = [];

    for (let i = 0; i < batchSize; i++) {
      const raw = await this.redis.lpop('queue:analytics_events');
      if (!raw) break;

      try {
        const data = JSON.parse(raw) as {
          tenant_id: string;
          business_id: string;
          event_type: EventType;
          ip_hash: string;
          session_id: string;
          referrer: string | null;
          cta_label: string | null;
          timestamp: string;
        };
        events.push(
          this.eventRepo.create({
            ...data,
            timestamp: new Date(data.timestamp),
          }),
        );
      } catch (err) {
        this.logger.error('Failed to parse analytics event from queue', err);
      }
    }

    if (events.length > 0) {
      await this.eventRepo
        .createQueryBuilder()
        .insert()
        .into(AnalyticsEvent)
        .values(events)
        .execute();
      this.logger.log(`Flushed ${events.length} analytics events to DB`);
    }
  }

  // ─── Cron: Create next month's partition ────────────────────────────────

  @Cron('0 0 20 * *') // 20th of every month
  async createNextMonthPartition(): Promise<void> {
    const next = new Date();
    next.setMonth(next.getMonth() + 1);
    const year = next.getFullYear();
    const month = String(next.getMonth() + 1).padStart(2, '0');
    const nextMonth = new Date(year, next.getMonth() + 1, 1);

    const tableName = `analytics_events_y${year}_m${month}`;
    const from = `${year}-${month}-01`;
    const to = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}-01`;

    try {
      await this.dataSource.query(`
        CREATE TABLE IF NOT EXISTS ${tableName} PARTITION OF analytics_events
        FOR VALUES FROM ('${from}') TO ('${to}')
      `);
      this.logger.log(`Created partition ${tableName}`);
    } catch (err) {
      this.logger.error(`Failed to create partition ${tableName}`, err);
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private anonymizeIp(ip: string): string {
    // Zero the last octet (IPv4) or last group (IPv6)
    const anonymized = ip.replace(/(\d+)$/, '0').replace(/:[0-9a-f]+$/, ':0');
    return createHash('sha256').update(anonymized).digest('hex');
  }

  private extractDomain(referrer?: string): string | null {
    if (!referrer) return null;
    try {
      return new URL(referrer).hostname;
    } catch {
      return null;
    }
  }
}
