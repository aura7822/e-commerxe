import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ConflictException, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as argon2 from 'argon2';

import { AuthService } from './auth.service';
import { User, UserRole, AuthProvider } from '../users/entities/user.entity';
import { RedisService } from './redis/redis.service';
import { EmailService } from './email/email.service';
import { AuditService } from '../admin/admin.service';

// ── Mock factories ────────────────────────────────────────────────────────────

const mockUserRepo = () => ({
  findOne: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
  update: jest.fn(),
});

const mockJwtService = () => ({
  sign: jest.fn().mockReturnValue('signed.jwt.token'),
  verify: jest.fn(),
});

const mockConfigService = () => ({
  get: jest.fn((key: string) => {
    const config: Record<string, unknown> = {
      JWT_PRIVATE_KEY_PATH: '/tmp/test-private.pem',
      JWT_PUBLIC_KEY_PATH: '/tmp/test-public.pem',
      JWT_ACCESS_TTL: 900,
      JWT_REFRESH_TTL: 604800,
      JWT_REFRESH_SECRET: 'test_refresh_secret_32chars_long!!',
      TURNSTILE_SECRET_KEY: 'test_turnstile_key',
      APP_URL: 'http://localhost:3000',
    };
    return config[key];
  }),
});

const mockRedisService = () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined),
  rpush: jest.fn().mockResolvedValue(undefined),
});

const mockEmailService = () => ({
  sendVerification: jest.fn().mockResolvedValue(undefined),
  sendLockoutNotification: jest.fn().mockResolvedValue(undefined),
  sendPasswordReset: jest.fn().mockResolvedValue(undefined),
});

const mockAuditService = () => ({
  log: jest.fn().mockResolvedValue(undefined),
});

const mockDataSource = () => ({
  transaction: jest.fn((cb: (em: unknown) => Promise<unknown>) => cb({})),
});

// ── Helper to build a mock User ──────────────────────────────────────────────

function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-uuid-1',
    email: 'owner@example.com',
    password_hash: null,
    role: UserRole.BUSINESS_OWNER,
    auth_provider: AuthProvider.LOCAL,
    google_id: null,
    email_verified: true,
    email_verification_token: null,
    email_verification_expires: null,
    mfa_secret: null,
    mfa_enabled: false,
    display_name: 'Test Owner',
    avatar_url: null,
    is_suspended: false,
    failed_login_attempts: 0,
    lockout_until: null,
    last_login_at: null,
    tenant_id: 'user-uuid-1',
    deletion_requested_at: null,
    deletion_scheduled_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    businesses: [],
    isLocked: false,
    ...overrides,
  } as User;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('AuthService', () => {
  let service: AuthService;
  let userRepo: ReturnType<typeof mockUserRepo>;
  let redis: ReturnType<typeof mockRedisService>;
  let emailSvc: ReturnType<typeof mockEmailService>;

  beforeEach(async () => {
    // Mock readFileSync to avoid needing real key files in test env
    jest.mock('fs', () => ({
      readFileSync: jest.fn().mockReturnValue('mock-key-content'),
    }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useFactory: mockUserRepo },
        { provide: JwtService, useFactory: mockJwtService },
        { provide: ConfigService, useFactory: mockConfigService },
        { provide: RedisService, useFactory: mockRedisService },
        { provide: EmailService, useFactory: mockEmailService },
        { provide: AuditService, useFactory: mockAuditService },
        { provide: DataSource, useFactory: mockDataSource },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    userRepo = module.get(getRepositoryToken(User));
    redis = module.get(RedisService);
    emailSvc = module.get(EmailService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── Registration ────────────────────────────────────────────────────────

  describe('register()', () => {
    const dto = {
      email: 'new@example.com',
      password: 'P@ssw0rd!2024',
      captcha_token: 'valid-captcha',
    };

    it('creates a new user and sends verification email', async () => {
      // Mock captcha verification
      global.fetch = jest.fn().mockResolvedValue({
        json: async () => ({ success: true }),
      }) as jest.Mock;

      userRepo.findOne.mockResolvedValue(null); // no existing user
      const mockUser = buildUser({ id: 'new-user-id', email: dto.email, email_verified: false });
      userRepo.create.mockReturnValue(mockUser);
      userRepo.save.mockResolvedValue({ ...mockUser, id: 'new-user-id' });

      const result = await service.register(dto, 'hashed-ip');

      expect(result.message).toContain('Registration successful');
      expect(emailSvc.sendVerification).toHaveBeenCalledWith(
        dto.email,
        expect.any(String),
      );
    });

    it('throws ConflictException when email already exists (timing-safe)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        json: async () => ({ success: true }),
      }) as jest.Mock;

      const existingUser = buildUser();
      userRepo.findOne.mockResolvedValue(existingUser);

      await expect(service.register(dto, 'hashed-ip')).rejects.toThrow(
        ConflictException,
      );
    });

    it('throws ForbiddenException when captcha fails', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        json: async () => ({ success: false }),
      }) as jest.Mock;

      await expect(service.register(dto, 'hashed-ip')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // ── Login ───────────────────────────────────────────────────────────────

  describe('login()', () => {
    it('returns tokens on valid credentials', async () => {
      const hash = await argon2.hash('P@ssw0rd!2024');
      const user = buildUser({ password_hash: hash });
      userRepo.findOne.mockResolvedValue(user);
      userRepo.update.mockResolvedValue(undefined);
      redis.get.mockResolvedValue(null); // not blacklisted

      const result = await service.login(
        { email: 'owner@example.com', password: 'P@ssw0rd!2024' },
        'hashed-ip',
        'test-agent',
      );

      expect(result).toHaveProperty('access_token');
      expect(result).toHaveProperty('token_type', 'Bearer');
    });

    it('throws UnauthorizedException on wrong password', async () => {
      const hash = await argon2.hash('CorrectPassword!1');
      const user = buildUser({ password_hash: hash });
      userRepo.findOne.mockResolvedValue(user);
      userRepo.update.mockResolvedValue(undefined);

      await expect(
        service.login(
          { email: 'owner@example.com', password: 'WrongPassword!1' },
          'hashed-ip',
          'test-agent',
        ),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws ForbiddenException when account is locked', async () => {
      const user = buildUser({
        lockout_until: new Date(Date.now() + 60_000),
        isLocked: true,
      });
      userRepo.findOne.mockResolvedValue(user);

      await expect(
        service.login(
          { email: 'owner@example.com', password: 'anything' },
          'hashed-ip',
          'test-agent',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws UnauthorizedException when email not verified', async () => {
      const hash = await argon2.hash('P@ssw0rd!2024');
      const user = buildUser({ password_hash: hash, email_verified: false });
      userRepo.findOne.mockResolvedValue(user);
      userRepo.update.mockResolvedValue(undefined);

      await expect(
        service.login(
          { email: 'owner@example.com', password: 'P@ssw0rd!2024' },
          'hashed-ip',
          'test-agent',
        ),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('signals MFA required when mfa_enabled and no code provided', async () => {
      const hash = await argon2.hash('P@ssw0rd!2024');
      const user = buildUser({ password_hash: hash, mfa_enabled: true, mfa_secret: 'secret' });
      userRepo.findOne.mockResolvedValue(user);
      userRepo.update.mockResolvedValue(undefined);

      const result = await service.login(
        { email: 'owner@example.com', password: 'P@ssw0rd!2024' },
        'hashed-ip',
        'test-agent',
      );

      expect(result).toHaveProperty('requires_mfa', true);
    });
  });

  // ── Logout ──────────────────────────────────────────────────────────────

  describe('logout()', () => {
    it('blacklists the JTI in Redis', async () => {
      await service.logout('test-jti', Math.floor(Date.now() / 1000) + 900);
      expect(redis.set).toHaveBeenCalledWith(
        'blacklist:test-jti',
        '1',
        expect.any(Number),
      );
    });
  });

  // ── Password Reset ──────────────────────────────────────────────────────

  describe('requestPasswordReset()', () => {
    it('always returns generic message (timing-safe — no user found)', async () => {
      userRepo.findOne.mockResolvedValue(null);
      const result = await service.requestPasswordReset('unknown@example.com');
      expect(result.message).toContain('If that email is registered');
    });

    it('sends reset email when user exists', async () => {
      const user = buildUser();
      userRepo.findOne.mockResolvedValue(user);

      await service.requestPasswordReset('owner@example.com');
      expect(emailSvc.sendPasswordReset).toHaveBeenCalledWith(
        'owner@example.com',
        expect.any(String),
      );
    });
  });
});
