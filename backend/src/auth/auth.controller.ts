import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiCookieAuth,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '@nestjs/passport';

import { AuthService } from './auth.service';
import {
  RegisterDto,
  LoginDto,
  PasswordResetRequestDto,
  PasswordResetConfirmDto,
  MfaEnableDto,
  VerifyEmailDto,
  AuthTokensResponse,
  MfaSetupResponse,
} from './dto/auth.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { hashIp } from '../common/utils/ip.util';

@ApiTags('Authentication')
@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ─── Register ────────────────────────────────────────────────────────────

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({ summary: 'Register with email & password' })
  @ApiResponse({ status: 201, description: 'Registration email sent' })
  @ApiResponse({ status: 409, description: 'Email already in use' })
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    const ipHash = hashIp(req.ip ?? '');
    return this.authService.register(dto, ipHash);
  }

  // ─── Verify Email ─────────────────────────────────────────────────────────

  @Get('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify email with token from link' })
  async verifyEmail(
    @Query() dto: VerifyEmailDto,
  ): Promise<{ message: string }> {
    return this.authService.verifyEmail(dto.token);
  }

  // ─── Login ───────────────────────────────────────────────────────────────

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Login with email & password (+ optional MFA code)' })
  @ApiResponse({ status: 200, type: AuthTokensResponse })
  @ApiResponse({ status: 401, description: 'Invalid credentials or MFA required' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthTokensResponse | { requires_mfa: boolean }> {
    const ipHash = hashIp(req.ip ?? '');
    const userAgent = req.headers['user-agent'] ?? '';

    const result = await this.authService.login(dto, ipHash, userAgent);

    if ('requires_mfa' in result) return result;

    // Set refresh token as HTTP-only, Secure, SameSite=Strict cookie
    const internalResult = result as AuthTokensResponse & { _refresh_token_internal?: string };
    if (internalResult._refresh_token_internal) {
      res.cookie('refresh_token', internalResult._refresh_token_internal, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        path: '/api/v1/auth',
      });
      delete internalResult._refresh_token_internal;
    }

    return result;
  }

  // ─── Refresh Token ───────────────────────────────────────────────────────

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Rotate access token using refresh cookie' })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthTokensResponse> {
    const refreshToken = (req.cookies as Record<string, string>)?.['refresh_token'];
    if (!refreshToken) {
      throw new Error('No refresh token provided');
    }

    const result = await this.authService.refreshTokens(refreshToken);

    const internalResult = result as AuthTokensResponse & { _refresh_token_internal?: string };
    if (internalResult._refresh_token_internal) {
      res.cookie('refresh_token', internalResult._refresh_token_internal, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: '/api/v1/auth',
      });
      delete internalResult._refresh_token_internal;
    }

    return result;
  }

  // ─── Logout ──────────────────────────────────────────────────────────────

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout and revoke tokens' })
  async logout(
    @Req() req: Request & { user: User & { jti: string; exp: number } },
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const refreshToken = (req.cookies as Record<string, string>)?.['refresh_token'];
    await this.authService.logout(req.user.jti, req.user.exp, refreshToken);
    res.clearCookie('refresh_token', { path: '/api/v1/auth' });
  }

  // ─── Google OAuth ─────────────────────────────────────────────────────────

  @Get('google')
  @UseGuards(AuthGuard('google'))
  @ApiOperation({ summary: 'Initiate Google OAuth 2.0 login' })
  googleAuth(): void {
    // Passport redirects to Google
  }

  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  @ApiOperation({ summary: 'Google OAuth callback' })
  async googleCallback(
    @Req() req: Request & { user: import('./strategies/google.strategy').GoogleProfile },
    @Res() res: Response,
  ): Promise<void> {
    const tokens = await this.authService.loginWithGoogle(req.user);
    const frontendUrl = process.env.FRONTEND_URL!;

    const internalResult = tokens as AuthTokensResponse & { _refresh_token_internal?: string };
    if (internalResult._refresh_token_internal) {
      res.cookie('refresh_token', internalResult._refresh_token_internal, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: '/api/v1/auth',
      });
      delete internalResult._refresh_token_internal;
    }

    // Redirect to frontend with access token as query param (short-lived)
    res.redirect(`${frontendUrl}/auth/callback?token=${tokens.access_token}`);
  }

  // ─── Password Reset ──────────────────────────────────────────────────────

  @Post('password-reset')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } }) // 3/hour per IP
  @ApiOperation({ summary: 'Request password reset email' })
  async requestReset(
    @Body() dto: PasswordResetRequestDto,
  ): Promise<{ message: string }> {
    return this.authService.requestPasswordReset(dto.email);
  }

  @Post('password-reset/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm password reset with token' })
  async confirmReset(
    @Body() dto: PasswordResetConfirmDto,
  ): Promise<{ message: string }> {
    return this.authService.confirmPasswordReset(dto.token, dto.new_password);
  }

  // ─── MFA ─────────────────────────────────────────────────────────────────

  @Post('mfa/enable')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Initiate MFA setup — returns QR code' })
  @ApiResponse({ status: 200, type: MfaSetupResponse })
  async setupMfa(@CurrentUser() user: User): Promise<MfaSetupResponse> {
    return this.authService.setupMfa(user.id);
  }

  @Post('mfa/confirm')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Confirm MFA setup with TOTP code' })
  async confirmMfa(
    @CurrentUser() user: User,
    @Body() dto: MfaEnableDto,
  ): Promise<{ message: string }> {
    return this.authService.confirmMfa(user.id, dto.totp_code);
  }
}
