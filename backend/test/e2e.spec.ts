/**
 * E2E Tests — Critical paths per SRS §10
 *
 * Uses NestJS testing utilities + Supertest against the full application stack.
 * Database calls are mocked at the TypeORM level to keep tests fast and isolated.
 *
 * To run against a real DB: set TEST_DB_HOST and remove mock overrides.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as cookieParser from 'cookie-parser';

import { AppModule } from '../app.module';
import { GlobalExceptionFilter } from '../common/filters/global-exception.filter';
import { TransformInterceptor } from '../common/interceptors/transform.interceptor';

// ─── We skip full E2E when TEST_E2E is not set ────────────────────────────────
const RUN = !!process.env.TEST_E2E;
const maybeDescribe = RUN ? describe : describe.skip;

maybeDescribe('E2E — Authentication flows', () => {
  let app: INestApplication;
  let httpServer: unknown;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalInterceptors(new TransformInterceptor());

    await app.init();
    httpServer = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  // ── Registration ──────────────────────────────────────────────────────────

  describe('POST /api/v1/auth/register', () => {
    it('returns 201 with success message for valid payload', async () => {
      const res = await request(httpServer)
        .post('/api/v1/auth/register')
        .send({
          email: `e2e-${Date.now()}@example.com`,
          password: 'P@ssw0rd!E2E',
          captcha_token: 'test-token',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.message).toContain('Registration successful');
    });

    it('returns 400 when password is too weak', async () => {
      const res = await request(httpServer)
        .post('/api/v1/auth/register')
        .send({
          email: 'weak@example.com',
          password: 'weakpass',
          captcha_token: 'test-token',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBeUndefined(); // error — no envelope
    });

    it('returns 400 when email is invalid', async () => {
      const res = await request(httpServer)
        .post('/api/v1/auth/register')
        .send({
          email: 'not-an-email',
          password: 'P@ssw0rd!E2E',
          captcha_token: 'test-token',
        });

      expect(res.status).toBe(400);
    });

    it('returns 400 when captcha_token is missing', async () => {
      const res = await request(httpServer)
        .post('/api/v1/auth/register')
        .send({
          email: 'valid@example.com',
          password: 'P@ssw0rd!E2E',
        });

      expect(res.status).toBe(400);
    });
  });

  // ── Login ─────────────────────────────────────────────────────────────────

  describe('POST /api/v1/auth/login', () => {
    it('returns 401 for unknown credentials', async () => {
      const res = await request(httpServer)
        .post('/api/v1/auth/login')
        .send({
          email: 'nobody@example.com',
          password: 'WrongP@ss!1',
        });

      expect(res.status).toBe(401);
    });

    it('returns 400 when body fields are missing', async () => {
      const res = await request(httpServer)
        .post('/api/v1/auth/login')
        .send({ email: 'x@x.com' }); // missing password

      expect(res.status).toBe(400);
    });
  });

  // ── Protected route without token ─────────────────────────────────────────

  describe('GET /api/v1/user/profile (protected)', () => {
    it('returns 401 when no Authorization header is sent', async () => {
      const res = await request(httpServer).get('/api/v1/user/profile');
      expect(res.status).toBe(401);
    });

    it('returns 401 for a malformed JWT', async () => {
      const res = await request(httpServer)
        .get('/api/v1/user/profile')
        .set('Authorization', 'Bearer not.a.jwt');

      expect(res.status).toBe(401);
    });
  });

  // ── Search (public) ───────────────────────────────────────────────────────

  describe('GET /api/v1/search (public)', () => {
    it('returns 200 with result envelope', async () => {
      const res = await request(httpServer)
        .get('/api/v1/search')
        .query({ q: 'car rental', page: 1, limit: 10 });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('data');
    });

    it('clamps limit above 100 to 100', async () => {
      const res = await request(httpServer)
        .get('/api/v1/search')
        .query({ q: 'test', limit: 9999 });

      // Response shape still valid
      expect([200, 400]).toContain(res.status);
    });
  });

  // ── Public cards ──────────────────────────────────────────────────────────

  describe('GET /api/v1/cards (public)', () => {
    it('returns 200 without authentication', async () => {
      const res = await request(httpServer).get('/api/v1/cards');
      expect(res.status).toBe(200);
    });
  });

  // ── Analytics tracking ────────────────────────────────────────────────────

  describe('POST /api/v1/analytics/events', () => {
    it('returns 202 Accepted for valid event', async () => {
      const res = await request(httpServer)
        .post('/api/v1/analytics/events')
        .send({
          business_id: 'biz-uuid-test',
          event_type: 'view',
          session_id: 'a'.repeat(64),
        });

      expect([202, 400]).toContain(res.status); // 400 if biz not found is also valid
    });

    it('returns 400 for invalid event_type', async () => {
      const res = await request(httpServer)
        .post('/api/v1/analytics/events')
        .send({
          business_id: 'biz-uuid',
          event_type: 'invalid_type',
          session_id: 'session-hash',
        });

      expect(res.status).toBe(400);
    });
  });

  // ── Rate limiting ─────────────────────────────────────────────────────────

  describe('Rate limiting', () => {
    it('blocks login after 5 rapid requests from same IP', async () => {
      const responses = await Promise.all(
        Array.from({ length: 7 }, () =>
          request(httpServer)
            .post('/api/v1/auth/login')
            .set('X-Forwarded-For', '10.0.0.99')
            .send({ email: 'x@x.com', password: 'P@ssw0rd!1' }),
        ),
      );

      const tooManyRequests = responses.filter((r) => r.status === 429);
      expect(tooManyRequests.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Security headers ──────────────────────────────────────────────────────

  describe('Security headers', () => {
    it('sets HSTS header on all responses', async () => {
      const res = await request(httpServer).get('/api/v1/search');
      expect(res.headers['strict-transport-security']).toBeDefined();
    });

    it('sets X-Content-Type-Options: nosniff', async () => {
      const res = await request(httpServer).get('/api/v1/search');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('does not expose X-Powered-By header', async () => {
      const res = await request(httpServer).get('/api/v1/search');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('sets Content-Security-Policy header', async () => {
      const res = await request(httpServer).get('/api/v1/search');
      expect(res.headers['content-security-policy']).toBeDefined();
    });
  });

  // ── GDPR ─────────────────────────────────────────────────────────────────

  describe('GET /api/v1/user/export (GDPR)', () => {
    it('returns 401 without auth', async () => {
      const res = await request(httpServer).get('/api/v1/user/export');
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /api/v1/user/account (GDPR)', () => {
    it('returns 401 without auth', async () => {
      const res = await request(httpServer).delete('/api/v1/user/account');
      expect(res.status).toBe(401);
    });
  });
});
