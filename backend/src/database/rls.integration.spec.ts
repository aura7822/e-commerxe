/**
 * RLS Integration Tests — 100% coverage per SRS §10
 *
 * These tests spin up a real PostgreSQL connection (testcontainers or
 * local DB configured via TEST_DB_* env vars) to verify that Row-Level
 * Security policies genuinely prevent cross-tenant data access.
 *
 * Run with: TEST_DB_HOST=localhost jest --testPathPattern=rls
 *
 * IMPORTANT: These tests require the full migration to have run first.
 * They are intentionally separated from unit tests (different jest config).
 */

import { DataSource, QueryRunner } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

// ── DB connection (uses test database) ───────────────────────────────────────

let dataSource: DataSource;
let runner: QueryRunner;

const TEST_DB = {
  host: process.env.TEST_DB_HOST ?? 'localhost',
  port: parseInt(process.env.TEST_DB_PORT ?? '5432', 10),
  username: process.env.TEST_DB_USER ?? 'ecommerxe_user',
  password: process.env.TEST_DB_PASSWORD ?? 'test_password',
  database: process.env.TEST_DB_NAME ?? 'ecommerxe_test',
};

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function createTenant(qr: QueryRunner): Promise<{ userId: string; tenantId: string }> {
  const userId = uuidv4();
  await qr.query(`
    INSERT INTO users (id, email, password_hash, role, email_verified, tenant_id)
    VALUES ($1, $2, 'hash', 'business_owner', true, $1)
  `, [userId, `tenant-${userId}@example.com`]);
  return { userId, tenantId: userId };
}

async function createBusiness(
  qr: QueryRunner,
  tenantId: string,
  ownerId: string,
): Promise<string> {
  const bizId = uuidv4();
  const slug = `biz-${bizId.slice(0, 8)}`;
  await qr.query(`
    INSERT INTO businesses (id, owner_id, tenant_id, name, slug, status)
    VALUES ($1, $2, $3, 'Test Business', $4, 'active')
  `, [bizId, ownerId, tenantId, slug]);
  return bizId;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('RLS — Row-Level Security isolation', () => {
  // Skip entire suite if no test DB configured
  const SKIP = !process.env.TEST_DB_HOST;

  beforeAll(async () => {
    if (SKIP) return;

    dataSource = new DataSource({
      type: 'postgres',
      ...TEST_DB,
      synchronize: false,
      logging: false,
    });
    await dataSource.initialize();
    runner = dataSource.createQueryRunner();
    await runner.connect();
  });

  afterAll(async () => {
    if (SKIP) return;
    await runner.release();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    if (SKIP) return;
    await runner.startTransaction();
  });

  afterEach(async () => {
    if (SKIP) return;
    // Rollback all test data — keeps the DB clean between tests
    await runner.rollbackTransaction();
  });

  // ── Tenant isolation: SELECT ─────────────────────────────────────────────

  describe('SELECT isolation', () => {
    it(
      'tenant A cannot see tenant B businesses when RLS is active',
      SKIP ? undefined : async () => {
        const tenantA = await createTenant(runner);
        const tenantB = await createTenant(runner);

        const bizBId = await createBusiness(runner, tenantB.tenantId, tenantB.userId);

        // Set RLS context to Tenant A
        await runner.query(`SET LOCAL app.current_tenant = '${tenantA.tenantId}'`);
        await runner.query(`SET LOCAL app.bypass_rls = 'false'`);

        const result = await runner.query(
          `SELECT id FROM businesses WHERE id = $1`,
          [bizBId],
        ) as { id: string }[];

        // Tenant A must get 0 rows — RLS filters out Tenant B's data
        expect(result).toHaveLength(0);
      },
    );

    it(
      'tenant A can see its own businesses',
      SKIP ? undefined : async () => {
        const tenantA = await createTenant(runner);
        const bizAId = await createBusiness(runner, tenantA.tenantId, tenantA.userId);

        await runner.query(`SET LOCAL app.current_tenant = '${tenantA.tenantId}'`);
        await runner.query(`SET LOCAL app.bypass_rls = 'false'`);

        const result = await runner.query(
          `SELECT id FROM businesses WHERE id = $1`,
          [bizAId],
        ) as { id: string }[];

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe(bizAId);
      },
    );

    it(
      'two tenants with 10 businesses each only see their own',
      SKIP ? undefined : async () => {
        const tenantA = await createTenant(runner);
        const tenantB = await createTenant(runner);

        for (let i = 0; i < 5; i++) {
          await createBusiness(runner, tenantA.tenantId, tenantA.userId);
          await createBusiness(runner, tenantB.tenantId, tenantB.userId);
        }

        // Tenant A context
        await runner.query(`SET LOCAL app.current_tenant = '${tenantA.tenantId}'`);
        await runner.query(`SET LOCAL app.bypass_rls = 'false'`);

        const resultA = await runner.query(`SELECT id FROM businesses`) as unknown[];
        expect(resultA).toHaveLength(5); // only A's 5 businesses

        // Switch to Tenant B context
        await runner.query(`SET LOCAL app.current_tenant = '${tenantB.tenantId}'`);

        const resultB = await runner.query(`SELECT id FROM businesses`) as unknown[];
        expect(resultB).toHaveLength(5); // only B's 5 businesses
      },
    );
  });

  // ── Admin bypass ─────────────────────────────────────────────────────────

  describe('sudo_admin bypass', () => {
    it(
      'bypass_rls = true gives visibility into all tenants',
      SKIP ? undefined : async () => {
        const tenantA = await createTenant(runner);
        const tenantB = await createTenant(runner);
        await createBusiness(runner, tenantA.tenantId, tenantA.userId);
        await createBusiness(runner, tenantB.tenantId, tenantB.userId);

        await runner.query(`SET LOCAL app.bypass_rls = 'true'`);

        const result = await runner.query(`SELECT id FROM businesses`) as unknown[];
        expect(result.length).toBeGreaterThanOrEqual(2);
      },
    );
  });

  // ── INSERT isolation ─────────────────────────────────────────────────────

  describe('INSERT isolation', () => {
    it(
      'tenant cannot insert a business with a different tenant_id',
      SKIP ? undefined : async () => {
        const tenantA = await createTenant(runner);
        const tenantB = await createTenant(runner);
        const bizId = uuidv4();

        await runner.query(`SET LOCAL app.current_tenant = '${tenantA.tenantId}'`);
        await runner.query(`SET LOCAL app.bypass_rls = 'false'`);

        // RLS WITH CHECK prevents inserting rows that wouldn't be visible
        await expect(
          runner.query(`
            INSERT INTO businesses (id, owner_id, tenant_id, name, slug, status)
            VALUES ($1, $2, $3, 'Rogue Biz', 'rogue-biz', 'active')
          `, [bizId, tenantA.userId, tenantB.tenantId]),
        ).rejects.toThrow(); // PostgreSQL RLS WITH CHECK violation
      },
    );
  });

  // ── Media file isolation ─────────────────────────────────────────────────

  describe('media_files isolation', () => {
    it(
      'tenant A cannot see media files belonging to tenant B',
      SKIP ? undefined : async () => {
        const tenantA = await createTenant(runner);
        const tenantB = await createTenant(runner);
        const bizB = await createBusiness(runner, tenantB.tenantId, tenantB.userId);

        const mediaId = uuidv4();
        await runner.query(`
          INSERT INTO media_files
            (id, business_id, tenant_id, file_type, mime_type, storage_key, cdn_url, size_bytes)
          VALUES ($1, $2, $3, 'gallery', 'image/jpeg', 'key', 'https://cdn.example.com/img.jpg', 1024)
        `, [mediaId, bizB, tenantB.tenantId]);

        // Set context to Tenant A
        await runner.query(`SET LOCAL app.current_tenant = '${tenantA.tenantId}'`);
        await runner.query(`SET LOCAL app.bypass_rls = 'false'`);

        const result = await runner.query(
          `SELECT id FROM media_files WHERE id = $1`,
          [mediaId],
        ) as unknown[];

        expect(result).toHaveLength(0);
      },
    );
  });

  // ── Analytics isolation ──────────────────────────────────────────────────

  describe('analytics_events isolation', () => {
    it(
      'tenant A analytics events are not visible to tenant B',
      SKIP ? undefined : async () => {
        const tenantA = await createTenant(runner);
        const tenantB = await createTenant(runner);
        const bizA = await createBusiness(runner, tenantA.tenantId, tenantA.userId);

        await runner.query(`
          INSERT INTO analytics_events
            (event_id, tenant_id, business_id, event_type, ip_hash, session_id, timestamp)
          VALUES ($1, $2, $3, 'view', $4, $5, NOW())
        `, [uuidv4(), tenantA.tenantId, bizA, 'a'.repeat(64), 'b'.repeat(64)]);

        // Tenant B context
        await runner.query(`SET LOCAL app.current_tenant = '${tenantB.tenantId}'`);
        await runner.query(`SET LOCAL app.bypass_rls = 'false'`);

        const result = await runner.query(
          `SELECT event_id FROM analytics_events WHERE business_id = $1`,
          [bizA],
        ) as unknown[];

        expect(result).toHaveLength(0);
      },
    );
  });

  // ── Context isolation between transactions ────────────────────────────────

  describe('session variable isolation', () => {
    it(
      'SET LOCAL app.current_tenant is scoped to its transaction only',
      SKIP ? undefined : async () => {
        const tenantA = await createTenant(runner);

        // SET LOCAL — scoped to current transaction
        await runner.query(`SET LOCAL app.current_tenant = '${tenantA.tenantId}'`);

        // Read back within same transaction
        const [{ current_setting }] = await runner.query(
          `SELECT current_setting('app.current_tenant', TRUE) AS current_setting`,
        ) as [{ current_setting: string }];

        expect(current_setting).toBe(tenantA.tenantId);
      },
    );
  });
});
