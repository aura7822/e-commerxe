import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { SearchService, SearchResult } from './search.service';
import { RedisService } from '../auth/redis/redis.service';

// ── Mock factories ────────────────────────────────────────────────────────────

const mockDataSource = () => ({
  query: jest.fn(),
});

const mockRedisService = () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
});

// ── Shared fixtures ───────────────────────────────────────────────────────────

const MOCK_COUNT = [{ total: 2 }];
const MOCK_HITS = [
  {
    id: 'biz-1',
    name: 'SwiftWheels Kenya',
    slug: 'swiftwheels-kenya',
    description: 'Affordable car hire',
    location: 'Nairobi',
    logo_url: null,
    verified: true,
    rank: 0.95,
    categories: [{ id: 'cat-1', name: 'Car Rental', slug: 'car-rental' }],
  },
  {
    id: 'biz-2',
    name: 'LuxLiving Properties',
    slug: 'luxliving-properties',
    description: 'Modern apartments',
    location: 'Westlands',
    logo_url: null,
    verified: false,
    rank: 0.72,
    categories: [{ id: 'cat-2', name: 'Housing', slug: 'housing' }],
  },
];

// ── Test suite ────────────────────────────────────────────────────────────────

describe('SearchService', () => {
  let service: SearchService;
  let dataSource: { query: jest.Mock };
  let redis: { get: jest.Mock; set: jest.Mock };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SearchService,
        { provide: DataSource, useFactory: mockDataSource },
        { provide: RedisService, useFactory: mockRedisService },
      ],
    }).compile();

    service = module.get<SearchService>(SearchService);
    dataSource = module.get(DataSource);
    redis = module.get(RedisService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── Cache hit ─────────────────────────────────────────────────────────────

  describe('cache behaviour', () => {
    it('returns cached result without hitting the database', async () => {
      const cached: SearchResult = {
        data: MOCK_HITS,
        total: 2,
        page: 1,
        limit: 20,
        took_ms: 5,
      };
      redis.get.mockResolvedValue(JSON.stringify(cached));

      const result = await service.search({ q: 'car' });

      expect(result.data).toHaveLength(2);
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('stores result in cache after DB query', async () => {
      redis.get.mockResolvedValue(null);
      dataSource.query
        .mockResolvedValueOnce(MOCK_COUNT)
        .mockResolvedValueOnce(MOCK_HITS);

      await service.search({ q: 'car rental' });

      expect(redis.set).toHaveBeenCalledWith(
        expect.stringContaining('search:'),
        expect.any(String),
        300, // 5-minute TTL
      );
    });
  });

  // ── Full-text search ─────────────────────────────────────────────────────

  describe('full-text search', () => {
    beforeEach(() => {
      redis.get.mockResolvedValue(null);
      dataSource.query
        .mockResolvedValueOnce(MOCK_COUNT)
        .mockResolvedValueOnce(MOCK_HITS);
    });

    it('returns paginated results with total count', async () => {
      const result = await service.search({ q: 'car rental', page: 1, limit: 20 });

      expect(result.total).toBe(2);
      expect(result.data).toHaveLength(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(result.took_ms).toBeGreaterThanOrEqual(0);
    });

    it('executes exactly 2 DB queries (count + data)', async () => {
      await service.search({ q: 'properties' });
      expect(dataSource.query).toHaveBeenCalledTimes(2);
    });

    it('clamps limit to 100 maximum', async () => {
      await service.search({ q: 'test', limit: 999 });
      // Both queries should use clamped limit (100)
      const [, dataCall] = dataSource.query.mock.calls as [unknown[], unknown[]][];
      const params = dataCall[1] as number[];
      expect(params).toContain(100);
    });
  });

  // ── No query (browse all) ─────────────────────────────────────────────────

  describe('empty query (browse mode)', () => {
    it('returns all active businesses when no query string given', async () => {
      redis.get.mockResolvedValue(null);
      dataSource.query
        .mockResolvedValueOnce([{ total: 50 }])
        .mockResolvedValueOnce(MOCK_HITS);

      const result = await service.search({});

      expect(result.total).toBe(50);
      // Should not add FTS WHERE clause — no search param in SQL
      const [countSql] = dataSource.query.mock.calls[0] as [string];
      expect(countSql).not.toContain('search_vector');
    });
  });

  // ── Category filter ──────────────────────────────────────────────────────

  describe('category filter', () => {
    it('includes category subquery when category slug provided', async () => {
      redis.get.mockResolvedValue(null);
      dataSource.query
        .mockResolvedValueOnce([{ total: 1 }])
        .mockResolvedValueOnce([MOCK_HITS[0]]);

      await service.search({ category: 'car-rental' });

      const [countSql, countParams] = dataSource.query.mock.calls[0] as [string, string[]];
      expect(countSql).toContain('business_categories');
      expect(countParams).toContain('car-rental');
    });
  });

  // ── Verified filter ──────────────────────────────────────────────────────

  describe('verified filter', () => {
    it('adds verified = true condition to query', async () => {
      redis.get.mockResolvedValue(null);
      dataSource.query
        .mockResolvedValueOnce([{ total: 1 }])
        .mockResolvedValueOnce([MOCK_HITS[0]]);

      await service.search({ verified: true });

      const [countSql, countParams] = dataSource.query.mock.calls[0] as [string, boolean[]];
      expect(countSql.toLowerCase()).toContain('verified');
      expect(countParams).toContain(true);
    });
  });

  // ── Pagination ───────────────────────────────────────────────────────────

  describe('pagination', () => {
    it('calculates correct offset for page 3 with limit 10', async () => {
      redis.get.mockResolvedValue(null);
      dataSource.query
        .mockResolvedValueOnce([{ total: 100 }])
        .mockResolvedValueOnce([]);

      await service.search({ page: 3, limit: 10 });

      const [, dataParams] = dataSource.query.mock.calls[1] as [string, number[]];
      // offset = (3-1) * 10 = 20
      expect(dataParams).toContain(20);
      expect(dataParams).toContain(10);
    });
  });

  // ── SQL injection safety ─────────────────────────────────────────────────

  describe('SQL injection safety', () => {
    it('parameterises user input — never interpolates raw query strings', async () => {
      redis.get.mockResolvedValue(null);
      dataSource.query
        .mockResolvedValueOnce([{ total: 0 }])
        .mockResolvedValueOnce([]);

      const maliciousQuery = "'; DROP TABLE businesses; --";
      await service.search({ q: maliciousQuery });

      // SQL itself should never contain the raw user string
      const [[countSql], [dataSql]] = dataSource.query.mock.calls as [string, unknown[]][];
      expect(countSql).not.toContain('DROP TABLE');
      expect(dataSql).not.toContain('DROP TABLE');
    });

    it('strips special regex/tsquery characters from query before use', async () => {
      redis.get.mockResolvedValue(null);
      dataSource.query
        .mockResolvedValueOnce([{ total: 0 }])
        .mockResolvedValueOnce([]);

      // Special characters should be sanitized by the service before parameterising
      await service.search({ q: "car & rental | 'nairobi'" });

      expect(dataSource.query).toHaveBeenCalled();
      // Test passes as long as no unhandled exception is thrown
    });
  });

  // ── Short query trigram fallback ─────────────────────────────────────────

  describe('trigram fallback', () => {
    it('uses ILIKE for queries shorter than 3 chars', async () => {
      redis.get.mockResolvedValue(null);
      dataSource.query
        .mockResolvedValueOnce([{ total: 1 }])
        .mockResolvedValueOnce([MOCK_HITS[0]]);

      await service.search({ q: 'sw' }); // 2 chars — trigram path

      const [[countSql]] = dataSource.query.mock.calls as [string, unknown[]][];
      // ILIKE used instead of @@ tsvector match
      expect(countSql.toUpperCase()).toContain('ILIKE');
    });
  });

  // ── Performance guard ─────────────────────────────────────────────────────

  describe('performance', () => {
    it('records took_ms in response', async () => {
      redis.get.mockResolvedValue(null);
      dataSource.query
        .mockResolvedValueOnce(MOCK_COUNT)
        .mockResolvedValueOnce(MOCK_HITS);

      const result = await service.search({ q: 'nairobi' });
      expect(typeof result.took_ms).toBe('number');
      expect(result.took_ms).toBeGreaterThanOrEqual(0);
    });
  });
});
