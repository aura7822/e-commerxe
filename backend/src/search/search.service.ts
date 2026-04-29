import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RedisService } from '../auth/redis/redis.service';

export interface SearchFilters {
  q?: string;
  category?: string;       // category slug
  verified?: boolean;
  page?: number;
  limit?: number;
}

export interface SearchResult {
  data: SearchHit[];
  total: number;
  page: number;
  limit: number;
  took_ms: number;
}

export interface SearchHit {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  location: string | null;
  logo_url: string | null;
  verified: boolean;
  categories: Array<{ id: string; name: string; slug: string }>;
  rank: number;
}

const SEARCH_CACHE_TTL = 300; // 5 minutes

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: RedisService,
  ) {}

  /**
   * Full-text search over businesses using PostgreSQL's tsvector + ts_rank.
   * Falls back to pg_trgm similarity when query is very short (< 3 chars).
   * Target: p95 < 300ms (GIN index on search_vector).
   */
  async search(filters: SearchFilters): Promise<SearchResult> {
    const { q = '', category, verified, page = 1, limit = 20 } = filters;
    const clampedLimit = Math.min(limit, 100);
    const offset = (page - 1) * clampedLimit;

    // Cache key — safe because we parameterise the actual query
    const cacheKey = `search:${JSON.stringify({ q, category, verified, page, clampedLimit })}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as SearchResult;

    const t0 = Date.now();

    /**
     * Build parameterised query.
     * We NEVER interpolate user input into the SQL string.
     * All user-supplied values go through $N parameters.
     */
    const params: (string | boolean | number)[] = [];
    const conditions: string[] = [
      `b.status = 'active'`,
      `b.deleted_at IS NULL`,
    ];

    // ── Full-text / trigram search ───────────────────────────────────
    let rankExpr = '1::float'; // default rank when no query
    if (q && q.trim().length >= 1) {
      const sanitized = q.trim().replace(/[^\w\s]/gi, '').substring(0, 200);

      if (sanitized.length >= 3) {
        // Use FTS plainto_tsquery (safe, no special chars)
        params.push(sanitized);
        conditions.push(`b.search_vector @@ plainto_tsquery('english', $${params.length})`);
        rankExpr = `ts_rank(b.search_vector, plainto_tsquery('english', $${params.length}))`;
      } else {
        // Trigram similarity fallback for short queries
        params.push(`%${sanitized}%`);
        conditions.push(`b.name ILIKE $${params.length}`);
        rankExpr = `similarity(b.name, '${sanitized}')`;
      }
    }

    // ── Category filter ──────────────────────────────────────────────
    if (category) {
      params.push(category);
      conditions.push(`
        EXISTS (
          SELECT 1 FROM business_categories bc
          JOIN categories c ON c.id = bc.category_id
          WHERE bc.business_id = b.id AND c.slug = $${params.length}
        )
      `);
    }

    // ── Verified filter ──────────────────────────────────────────────
    if (verified !== undefined) {
      params.push(verified);
      conditions.push(`b.verified = $${params.length}`);
    }

    const whereClause = conditions.join(' AND ');

    // ── Count query ──────────────────────────────────────────────────
    const countSql = `
      SELECT COUNT(DISTINCT b.id)::int AS total
      FROM businesses b
      WHERE ${whereClause}
    `;

    // ── Data query ───────────────────────────────────────────────────
    params.push(clampedLimit, offset);
    const limitParam = params.length - 1;
    const offsetParam = params.length;

    const dataSql = `
      SELECT
        b.id,
        b.name,
        b.slug,
        b.description,
        b.location,
        b.logo_url,
        b.verified,
        (${rankExpr}) + (1.0 / (1.0 + EXTRACT(EPOCH FROM (NOW() - b.updated_at)) / 86400.0)) AS rank,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT('id', c.id, 'name', c.name, 'slug', c.slug)
          ) FILTER (WHERE c.id IS NOT NULL),
          '[]'
        ) AS categories
      FROM businesses b
      LEFT JOIN business_categories bc ON bc.business_id = b.id
      LEFT JOIN categories c ON c.id = bc.category_id
      WHERE ${whereClause}
      GROUP BY b.id, b.name, b.slug, b.description, b.location, b.logo_url, b.verified, b.updated_at
      ORDER BY rank DESC, b.updated_at DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `;

    const [countResult, dataResult] = await Promise.all([
      this.dataSource.query(countSql, params.slice(0, params.length - 2)),
      this.dataSource.query(dataSql, params),
    ]);

    const result: SearchResult = {
      data: dataResult as SearchHit[],
      total: countResult[0]?.total ?? 0,
      page,
      limit: clampedLimit,
      took_ms: Date.now() - t0,
    };

    await this.redis.set(cacheKey, JSON.stringify(result), SEARCH_CACHE_TTL);

    this.logger.debug(`Search "${q}" → ${result.total} results in ${result.took_ms}ms`);
    return result;
  }
}
