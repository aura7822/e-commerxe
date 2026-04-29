import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, IsNull, Not } from 'typeorm';
import { DataSource } from 'typeorm';

import { User } from '../users/entities/user.entity';
import { Business } from '../businesses/entities/business.entity';
import { AuditService } from '../admin/audit.service';
import { AuditAction } from '../admin/entities/audit-log.entity';

@Injectable()
export class CleanupJobsService {
  private readonly logger = new Logger(CleanupJobsService.name);

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Business) private readonly bizRepo: Repository<Business>,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /**
   * Runs daily at 02:00 UTC.
   * Hard-deletes businesses whose 30-day recovery grace has expired.
   */
  @Cron('0 2 * * *')
  async purgeExpiredSoftDeletedBusinesses(): Promise<void> {
    const now = new Date();
    const expired = await this.bizRepo.find({
      where: {
        deleted_at: Not(IsNull()),
        permanent_deletion_at: LessThan(now),
      },
      select: ['id', 'owner_id'],
    });

    if (expired.length === 0) return;

    this.logger.log(`Purging ${expired.length} expired soft-deleted businesses`);

    for (const biz of expired) {
      await this.bizRepo.delete(biz.id); // cascades to cards, media, analytics
      await this.audit.log({
        action: AuditAction.BUSINESS_DELETED,
        resource_id: biz.id,
        resource_type: 'business',
        metadata: { reason: 'grace_period_expired', actor: 'system' },
      });
    }
  }

  /**
   * Runs daily at 03:00 UTC.
   * Hard-deletes user accounts whose 30-day GDPR deletion grace has expired.
   */
  @Cron('0 3 * * *')
  async purgeScheduledUserDeletions(): Promise<void> {
    const now = new Date();
    const users = await this.userRepo.find({
      where: {
        deletion_scheduled_at: LessThan(now),
        deletion_requested_at: Not(IsNull()),
      },
      select: ['id', 'email'],
    });

    if (users.length === 0) return;

    this.logger.log(`Hard-deleting ${users.length} scheduled user accounts`);

    for (const user of users) {
      await this.userRepo.delete(user.id);
      await this.audit.log({
        action: AuditAction.USER_DELETED,
        resource_id: user.id,
        resource_type: 'user',
        metadata: { reason: 'gdpr_scheduled_deletion', actor: 'system' },
      });
      this.logger.log(`Hard-deleted user ${user.id}`);
    }
  }

  /**
   * Runs on the 20th of each month at 00:00 UTC.
   * Pre-creates next month's analytics_events partition.
   * (Also handled in AnalyticsService — this is the fallback job.)
   */
  @Cron('0 0 20 * *')
  async createNextAnalyticsPartition(): Promise<void> {
    const next = new Date();
    next.setMonth(next.getMonth() + 1);
    const year = next.getFullYear();
    const month = String(next.getMonth() + 1).padStart(2, '0');
    const afterNext = new Date(year, next.getMonth() + 1, 1);
    const tableName = `analytics_events_y${year}_m${month}`;
    const from = `${year}-${month}-01`;
    const to = `${afterNext.getFullYear()}-${String(afterNext.getMonth() + 1).padStart(2, '0')}-01`;

    try {
      await this.dataSource.query(`
        CREATE TABLE IF NOT EXISTS ${tableName}
        PARTITION OF analytics_events
        FOR VALUES FROM ('${from}') TO ('${to}')
      `);
      this.logger.log(`Partition ${tableName} ensured`);
    } catch (err) {
      this.logger.error(`Failed to create partition ${tableName}`, err);
    }
  }

  /**
   * Runs every hour — vacuum expired email verification tokens.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async cleanExpiredVerificationTokens(): Promise<void> {
    const result = await this.userRepo
      .createQueryBuilder()
      .update(User)
      .set({ email_verification_token: null, email_verification_expires: null })
      .where('email_verification_expires < :now', { now: new Date() })
      .andWhere('email_verified = false')
      .execute();

    if (result.affected && result.affected > 0) {
      this.logger.debug(`Cleared ${result.affected} expired verification tokens`);
    }
  }
}
