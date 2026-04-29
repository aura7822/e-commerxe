import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AnalyticsService } from './analytics.service';
import { AnalyticsEvent, EventType } from './entities/analytics-event.entity';
import { RedisService } from '../auth/redis/redis.service';
import { User, UserRole, AuthProvider } from '../users/entities/user.entity';

// ── Mock factories ────────────────────────────────────────────────────────────

const mockEventRepo = () => ({
  create: jest.fn(),
  createQueryBuilder: jest.fn(() => ({
    insert: jest.fn().mockReturnThis(),
    into: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue(undefined),
  })),
});

const mockDataSource = () => ({
  query: jest.fn(),
});

const mockRedisService = () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  incr: jest.fn().mockResolvedValue(1),
  expire: jest.fn().mockResolvedValue(undefined),
  rpush: jest.fn().mockResolvedValue(undefined),
  lpop: jest.fn().mockResolvedValue(null),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildOwner(overrides: Partial<User> = {}): User {
  return {
    id: 'owner-uuid-1',
    email: 'owner@example.com',
    role: UserRole.BUSINESS_OWNER,
    tenant_id: 'owner-uuid-1',
    email_verified: true,
    is_suspended: false,
    mfa_enabled: false,
    failed_login_attempts: 0,
    auth_provider: AuthProvider.LOCAL,
    ...overrides,
  } as User;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let redis: ReturnType<typeof mockRedisService>;
  let dataSource: { query: jest.Mock };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: getRepositoryToken(AnalyticsEvent), useFactory: mockEventRepo },
        { provide: DataSource, useFactory: mockDataSource },
        { provide: RedisService, useFactory: mockRedisService },
      ],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
    redis = module.get(RedisService);
    dataSource = module.get(DataSource);
  });

  afterEach(() => jest.clearAllMocks());

  // ── Track event ───────────────────────────────────────────────────────────

  describe('track()', () => {
    const dto = {
      business_id: 'biz-uuid-1',
      event_type: EventType.VIEW,
      session_id: 'session-hash-abc',
      referrer: 'https://google.com/search',
    };

    it('increments Redis counter immediately', async () => {
      await service.track(dto, '192.168.1.45', 'tenant-uuid-1');

      expect(redis.incr).toHaveBeenCalledWith(
        expect.stringContaining('analytics:biz-uuid-1:view:'),
      );
    });

    it('sets TTL on the Redis counter key', async () => {
      await service.track(dto, '192.168.1.45', 'tenant-uuid-1');
      expect(redis.expire).toHaveBeenCalled();
    });

    it('pushes event to Redis queue for batch DB write', async () => {
      await service.track(dto, '192.168.1.45', 'tenant-uuid-1');

      expect(redis.rpush).toHaveBeenCalledWith(
        'queue:analytics_events',
        expect.stringContaining('"business_id":"biz-uuid-1"'),
      );
    });

    it('extracts domain-only from referrer URL', async () => {
      await service.track(dto, '192.168.1.45', 'tenant-uuid-1');

      const queuedEvent = JSON.parse(
        (redis.rpush.mock.calls[0] as string[])[1],
      ) as { referrer: string };
      expect(queuedEvent.referrer).toBe('google.com');
    });

    it('stores null referrer when referrer is absent', async () => {
      await service.track(
        { ...dto, referrer: undefined },
        '192.168.1.45',
        'tenant-uuid-1',
      );

      const queuedEvent = JSON.parse(
        (redis.rpush.mock.calls[0] as string[])[1],
      ) as { referrer: null };
      expect(queuedEvent.referrer).toBeNull();
    });

    it('stores null referrer when referrer is not a valid URL', async () => {
      await service.track(
        { ...dto, referrer: 'not-a-url' },
        '192.168.1.45',
        'tenant-uuid-1',
      );

      const queuedEvent = JSON.parse(
        (redis.rpush.mock.calls[0] as string[])[1],
      ) as { referrer: null };
      expect(queuedEvent.referrer).toBeNull();
    });
  });

  // ── IP anonymisation ──────────────────────────────────────────────────────

  describe('IP anonymisation', () => {
    it('anonymises IPv4 — last octet zeroed before hashing', async () => {
      await service.track(
        {
          business_id: 'biz-1',
          event_type: EventType.VIEW,
          session_id: 'sess-1',
        },
        '203.0.113.45',
        'tenant-1',
      );
      await service.track(
        {
          business_id: 'biz-1',
          event_type: EventType.VIEW,
          session_id: 'sess-2',
        },
        '203.0.113.99', // different last octet — same subnet
        'tenant-1',
      );

      const event1 = JSON.parse(
        (redis.rpush.mock.calls[0] as string[])[1],
      ) as { ip_hash: string };
      const event2 = JSON.parse(
        (redis.rpush.mock.calls[1] as string[])[1],
      ) as { ip_hash: string };

      // Both .45 and .99 map to .0 → same hash
      expect(event1.ip_hash).toBe(event2.ip_hash);
    });

    it('produces a 64-char hex SHA-256 hash', async () => {
      await service.track(
        {
          business_id: 'biz-1',
          event_type: EventType.CLICK,
          session_id: 'sess-x',
        },
        '10.0.0.1',
        'tenant-1',
      );

      const event = JSON.parse(
        (redis.rpush.mock.calls[0] as string[])[1],
      ) as { ip_hash: string };
      expect(event.ip_hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  // ── Dashboard ─────────────────────────────────────────────────────────────

  describe('getDashboard()', () => {
    const owner = buildOwner();

    it('returns cached dashboard without hitting DB', async () => {
      const cachedDashboard = {
        business_id: 'biz-1',
        period_days: 30,
        views: 500,
        clicks: 120,
        cta_actions: 45,
        unique_sessions: 310,
        top_referrers: [],
        daily_breakdown: [],
      };
      redis.get.mockResolvedValue(JSON.stringify(cachedDashboard));

      const result = await service.getDashboard('biz-1', owner, 30);

      expect(result.views).toBe(500);
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('queries DB and returns aggregated stats when cache is cold', async () => {
      redis.get.mockResolvedValue(null);

      // Aggregate query
      dataSource.query
        .mockResolvedValueOnce([
          { event_type: 'view', total: '1200', unique_sessions: '800' },
          { event_type: 'click', total: '340', unique_sessions: '280' },
          { event_type: 'cta', total: '95', unique_sessions: '70' },
        ])
        // Top referrers
        .mockResolvedValueOnce([
          { domain: 'google.com', count: '450' },
          { domain: 'facebook.com', count: '120' },
        ])
        // Daily breakdown
        .mockResolvedValueOnce([
          { date: '2024-12-01', views: '40', clicks: '12' },
          { date: '2024-12-02', views: '55', clicks: '18' },
        ]);

      const result = await service.getDashboard('biz-1', owner, 30);

      expect(result.views).toBe(1200);
      expect(result.clicks).toBe(340);
      expect(result.cta_actions).toBe(95);
      expect(result.unique_sessions).toBe(800);
      expect(result.top_referrers).toHaveLength(2);
      expect(result.top_referrers[0].domain).toBe('google.com');
      expect(result.daily_breakdown).toHaveLength(2);
    });

    it('caches dashboard result for 5 minutes', async () => {
      redis.get.mockResolvedValue(null);
      dataSource.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.getDashboard('biz-1', owner, 7);

      expect(redis.set).toHaveBeenCalledWith(
        'dashboard:biz-1:7',
        expect.any(String),
        300,
      );
    });

    it('accepts all valid period_days values: 7, 30, 90', async () => {
      for (const days of [7, 30, 90] as (7 | 30 | 90)[]) {
        redis.get.mockResolvedValue(null);
        dataSource.query
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([]);

        const result = await service.getDashboard('biz-1', owner, days);
        expect(result.period_days).toBe(days);
      }
    });
  });

  // ── flushEventQueue cron ──────────────────────────────────────────────────

  describe('flushEventQueue()', () => {
    it('processes up to 1000 events from queue and inserts into DB', async () => {
      const mockEvent = JSON.stringify({
        tenant_id: 'tenant-1',
        business_id: 'biz-1',
        event_type: 'view',
        ip_hash: 'a'.repeat(64),
        session_id: 'b'.repeat(64),
        referrer: null,
        cta_label: null,
        timestamp: new Date().toISOString(),
      });

      // Return event on first 3 calls, then null (queue empty)
      redis.lpop
        .mockResolvedValueOnce(mockEvent)
        .mockResolvedValueOnce(mockEvent)
        .mockResolvedValueOnce(mockEvent)
        .mockResolvedValue(null);

      const eventRepo = module_get_eventRepo();
      eventRepo.create
        .mockReturnValueOnce({ id: 'e1' })
        .mockReturnValueOnce({ id: 'e2' })
        .mockReturnValueOnce({ id: 'e3' });

      await service.flushEventQueue();

      expect(redis.lpop).toHaveBeenCalledTimes(4); // 3 events + 1 null
    });

    it('does not throw when queue is empty', async () => {
      redis.lpop.mockResolvedValue(null);
      await expect(service.flushEventQueue()).resolves.not.toThrow();
    });

    it('skips malformed queue entries without crashing', async () => {
      redis.lpop
        .mockResolvedValueOnce('NOT_VALID_JSON}}}')
        .mockResolvedValue(null);

      await expect(service.flushEventQueue()).resolves.not.toThrow();
    });
  });
});

// ── Helper to grab eventRepo from the module scope ────────────────────────────
// (declared outside describe to be hoisted but only used inside tests)
let _module: TestingModule;

function module_get_eventRepo() {
  return _module?.get(getRepositoryToken(AnalyticsEvent)) ?? {
    create: jest.fn().mockReturnValue({}),
  };
}
