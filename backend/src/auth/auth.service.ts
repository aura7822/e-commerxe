import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync } from 'fs';
import { createHash, randomBytes } from 'crypto';

import { User, UserRole, AuthProvider } from '../../users/entities/user.entity';
import { RedisService } from '../redis/redis.service';
import { EmailService } from '../email/email.service';
import { AuditService } from '../../admin/audit.service';
import { AuditAction } from '../../admin/entities/audit-log.entity';
import {
  RegisterDto,
  LoginDto,
  AuthTokensResponse,
  MfaSetupResponse,
} from './dto/auth.dto';
import { GoogleProfile } from './strategies/google.strategy';
import { JwtPayload } from './strategies/jwt.strategy';

/** Argon2id parameters — OWASP recommended */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MB
  timeCost: 3,
  parallelism: 4,
};

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly privateKey: string;

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
    private readonly dataSource: DataSource,
  ) {
    this.privateKey = readFileSync(
      this.config.get<string>('JWT_PRIVATE_KEY_PATH')!,
      'utf-8',
    );
  }

  // ─── Registration ────────────────────────────────────────────────────────

  async register(dto: RegisterDto, ipHash: string): Promise<{ message: string }> {
    // Verify Cloudflare Turnstile captcha
    await this.verifyCaptcha(dto.captcha_token, ipHash);

    const existing = await this.userRepo.findOne({ where: { email: dto.email } });
    if (existing) {
      // Timing-safe: don't reveal whether email exists
      await argon2.hash(dto.password, ARGON2_OPTIONS);
      throw new ConflictException('Registration failed — please check your details');
    }

    const passwordHash = await argon2.hash(dto.password, ARGON2_OPTIONS);
    const verificationToken = randomBytes(32).toString('hex');
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    const user = this.userRepo.create({
      email: dto.email,
      password_hash: passwordHash,
      display_name: dto.display_name ?? null,
      role: UserRole.BUSINESS_OWNER,
      auth_provider: AuthProvider.LOCAL,
      email_verified: false,
      email_verification_token: verificationToken,
      email_verification_expires: verificationExpires,
    });
    // tenant_id = own user ID
    const saved = await this.userRepo.save(user);
    saved.tenant_id = saved.id;
    await this.userRepo.save(saved);

    await this.email.sendVerification(saved.email, verificationToken);

    await this.audit.log({
      actor_id: saved.id,
      action: AuditAction.USER_REGISTER,
      resource_id: saved.id,
      resource_type: 'user',
      ip_hash: ipHash,
    });

    this.logger.log(`New user registered: ${saved.id}`);
    return { message: 'Registration successful. Check your email to verify your account.' };
  }

  // ─── Email Verification ──────────────────────────────────────────────────

  async verifyEmail(token: string): Promise<{ message: string }> {
    const user = await this.userRepo.findOne({
      where: { email_verification_token: token },
      select: ['id', 'email_verification_token', 'email_verification_expires', 'email_verified'],
    });

    if (!user) throw new BadRequestException('Invalid or expired verification link');
    if (user.email_verified) return { message: 'Email already verified' };
    if (user.email_verification_expires! < new Date()) {
      throw new BadRequestException('Verification link has expired — request a new one');
    }

    await this.userRepo.update(user.id, {
      email_verified: true,
      email_verification_token: null,
      email_verification_expires: null,
      role: UserRole.BUSINESS_OWNER,
    });

    return { message: 'Email verified successfully. You can now log in.' };
  }

  // ─── Login ───────────────────────────────────────────────────────────────

  async login(
    dto: LoginDto,
    ipHash: string,
    userAgent: string,
  ): Promise<AuthTokensResponse & { requires_mfa?: boolean }> {
    const user = await this.userRepo.findOne({
      where: { email: dto.email },
      select: [
        'id', 'email', 'password_hash', 'role', 'tenant_id',
        'email_verified', 'is_suspended', 'failed_login_attempts',
        'lockout_until', 'mfa_enabled', 'mfa_secret', 'auth_provider',
      ],
    });

    // ── Lockout check ────────────────────────────────────────────────
    if (user?.isLocked) {
      throw new ForbiddenException(
        `Account locked due to too many failed attempts. Try again after ${LOCKOUT_MINUTES} minutes.`,
      );
    }

    // ── Credential verification ──────────────────────────────────────
    const isValid =
      user &&
      user.password_hash &&
      (await argon2.verify(user.password_hash, dto.password, ARGON2_OPTIONS));

    if (!isValid) {
      if (user) {
        const attempts = user.failed_login_attempts + 1;
        const update: Partial<User> =
          attempts >= MAX_LOGIN_ATTEMPTS
            ? {
                failed_login_attempts: attempts,
                lockout_until: new Date(Date.now() + LOCKOUT_MINUTES * 60_000),
              }
            : { failed_login_attempts: attempts };

        await this.userRepo.update(user.id, update);

        if (attempts >= MAX_LOGIN_ATTEMPTS) {
          await this.email.sendLockoutNotification(user.email, LOCKOUT_MINUTES);
        }
      }
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.email_verified) {
      throw new UnauthorizedException('Please verify your email before logging in');
    }

    if (user.is_suspended) {
      throw new ForbiddenException('Your account has been suspended');
    }

    // ── MFA check ────────────────────────────────────────────────────
    if (user.mfa_enabled) {
      if (!dto.mfa_code) {
        // Signal to the client that MFA is required
        return { requires_mfa: true } as any;
      }
      const valid = authenticator.verify({
        token: dto.mfa_code,
        secret: user.mfa_secret!,
      });
      if (!valid) throw new UnauthorizedException('Invalid MFA code');
    }

    // ── Reset failed attempts on success ─────────────────────────────
    await this.userRepo.update(user.id, {
      failed_login_attempts: 0,
      lockout_until: null,
      last_login_at: new Date(),
    });

    const tokens = await this.generateTokens(user);

    await this.audit.log({
      actor_id: user.id,
      action: AuditAction.USER_LOGIN,
      resource_id: user.id,
      resource_type: 'user',
      ip_hash: ipHash,
      metadata: { user_agent: userAgent },
    });

    return tokens;
  }

  // ─── Google OAuth ────────────────────────────────────────────────────────

  async loginWithGoogle(profile: GoogleProfile): Promise<AuthTokensResponse> {
    let user = await this.userRepo.findOne({
      where: [{ google_id: profile.googleId }, { email: profile.email }],
    });

    if (!user) {
      user = this.userRepo.create({
        email: profile.email,
        google_id: profile.googleId,
        display_name: profile.displayName,
        avatar_url: profile.avatarUrl,
        auth_provider: AuthProvider.GOOGLE,
        email_verified: true,
        role: UserRole.BUSINESS_OWNER,
      });
      const saved = await this.userRepo.save(user);
      saved.tenant_id = saved.id;
      user = await this.userRepo.save(saved);

      await this.audit.log({
        actor_id: user.id,
        action: AuditAction.USER_REGISTER,
        resource_id: user.id,
        resource_type: 'user',
        metadata: { provider: 'google' },
      });
    } else if (!user.google_id) {
      // Link Google to existing local account
      await this.userRepo.update(user.id, {
        google_id: profile.googleId,
        avatar_url: profile.avatarUrl ?? user.avatar_url,
        email_verified: true,
      });
    }

    return this.generateTokens(user);
  }

  // ─── Token Refresh ───────────────────────────────────────────────────────

  async refreshTokens(refreshToken: string): Promise<AuthTokensResponse> {
    // Verify refresh token (HMAC HS256 for refresh, RS256 for access)
    let payload: { sub: string; jti: string };
    try {
      payload = this.jwtService.verify(refreshToken, {
        secret: this.config.get<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Check if refresh token was already rotated (replay detection)
    const isRevoked = await this.redis.get(`rt_revoked:${payload.jti}`);
    if (isRevoked) throw new UnauthorizedException('Refresh token reuse detected');

    // Revoke used refresh token
    const refreshTtl = this.config.get<number>('JWT_REFRESH_TTL')!;
    await this.redis.set(`rt_revoked:${payload.jti}`, '1', refreshTtl);

    const user = await this.userRepo.findOne({
      where: { id: payload.sub },
      select: ['id', 'email', 'role', 'tenant_id', 'is_suspended', 'email_verified'],
    });

    if (!user || user.is_suspended) {
      throw new UnauthorizedException('User not found or suspended');
    }

    return this.generateTokens(user);
  }

  // ─── Logout ──────────────────────────────────────────────────────────────

  async logout(jti: string, exp: number, refreshToken?: string): Promise<void> {
    const ttl = Math.max(0, exp - Math.floor(Date.now() / 1000));
    // Blacklist access token JTI until it naturally expires
    await this.redis.set(`blacklist:${jti}`, '1', ttl);

    // Optionally revoke refresh token too
    if (refreshToken) {
      try {
        const rtPayload = this.jwtService.verify<{ jti: string; exp: number }>(
          refreshToken,
          { secret: this.config.get<string>('JWT_REFRESH_SECRET') },
        );
        const rtTtl = Math.max(0, rtPayload.exp - Math.floor(Date.now() / 1000));
        await this.redis.set(`rt_revoked:${rtPayload.jti}`, '1', rtTtl);
      } catch {
        // Ignore — expired refresh token is already harmless
      }
    }
  }

  // ─── Password Reset ──────────────────────────────────────────────────────

  async requestPasswordReset(email: string): Promise<{ message: string }> {
    // Always return same message — don't reveal if email exists
    const message = 'If that email is registered, a reset link has been sent.';

    const user = await this.userRepo.findOne({ where: { email } });
    if (!user) return { message };

    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const ttl = 15 * 60; // 15 minutes

    await this.redis.set(`pwd_reset:${tokenHash}`, user.id, ttl);
    await this.email.sendPasswordReset(email, token);

    return { message };
  }

  async confirmPasswordReset(
    token: string,
    newPassword: string,
  ): Promise<{ message: string }> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const userId = await this.redis.get(`pwd_reset:${tokenHash}`);

    if (!userId) {
      throw new BadRequestException('Reset link is invalid or has expired');
    }

    const passwordHash = await argon2.hash(newPassword, ARGON2_OPTIONS);
    await this.userRepo.update(userId, { password_hash: passwordHash });

    // Consume token — prevent reuse
    await this.redis.del(`pwd_reset:${tokenHash}`);

    await this.audit.log({
      actor_id: userId,
      action: AuditAction.USER_PASSWORD_RESET,
      resource_id: userId,
      resource_type: 'user',
    });

    return { message: 'Password reset successfully. You can now log in.' };
  }

  // ─── MFA (TOTP) ──────────────────────────────────────────────────────────

  async setupMfa(userId: string): Promise<MfaSetupResponse> {
    const user = await this.userRepo.findOneOrFail({ where: { id: userId } });
    if (user.mfa_enabled) {
      throw new ConflictException('MFA is already enabled');
    }

    const secret = authenticator.generateSecret(32);
    const appName = 'E-CommerXE';
    const otpauthUrl = authenticator.keyuri(user.email, appName, secret);

    // Store secret temporarily until user confirms
    await this.redis.set(`mfa_pending:${userId}`, secret, 600); // 10 min

    const qrCode = await QRCode.toDataURL(otpauthUrl);
    return { otpauth_url: otpauthUrl, qr_code: qrCode };
  }

  async confirmMfa(userId: string, totpCode: string): Promise<{ message: string }> {
    const pendingSecret = await this.redis.get(`mfa_pending:${userId}`);
    if (!pendingSecret) {
      throw new BadRequestException('MFA setup session expired — start again');
    }

    const isValid = authenticator.verify({ token: totpCode, secret: pendingSecret });
    if (!isValid) throw new BadRequestException('Invalid TOTP code');

    await this.userRepo.update(userId, {
      mfa_secret: pendingSecret,
      mfa_enabled: true,
    });
    await this.redis.del(`mfa_pending:${userId}`);

    await this.audit.log({
      actor_id: userId,
      action: AuditAction.USER_MFA_ENABLE,
      resource_id: userId,
      resource_type: 'user',
    });

    return { message: 'MFA enabled successfully' };
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  private async generateTokens(user: User): Promise<AuthTokensResponse> {
    const jti = uuidv4();
    const accessTtl = this.config.get<number>('JWT_ACCESS_TTL')!;
    const refreshTtl = this.config.get<number>('JWT_REFRESH_TTL')!;

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      tenant_id: user.tenant_id!,
      jti,
    };

    // Access token — RS256 asymmetric
    const access_token = this.jwtService.sign(payload, {
      algorithm: 'RS256',
      privateKey: this.privateKey,
      expiresIn: accessTtl,
    });

    // Refresh token — HS256 symmetric (stored in HTTP-only cookie by controller)
    const refreshJti = uuidv4();
    const refresh_token = this.jwtService.sign(
      { sub: user.id, jti: refreshJti },
      {
        secret: this.config.get<string>('JWT_REFRESH_SECRET'),
        expiresIn: refreshTtl,
      },
    );

    // Store refresh token JTI in Redis for rotation tracking
    await this.redis.set(`rt_active:${user.id}:${refreshJti}`, '1', refreshTtl);

    return {
      access_token,
      expires_in: accessTtl,
      token_type: 'Bearer',
      // refresh_token sent as HTTP-only cookie by controller
      ...(refresh_token && { _refresh_token_internal: refresh_token }),
    } as AuthTokensResponse;
  }

  private async verifyCaptcha(token: string, ip: string): Promise<void> {
    const secret = this.config.get<string>('TURNSTILE_SECRET_KEY')!;
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }).toString(),
    });
    const data = (await res.json()) as { success: boolean };
    if (!data.success) {
      throw new ForbiddenException('CAPTCHA verification failed');
    }
  }
}
