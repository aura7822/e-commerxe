import {
  IsEmail,
  IsString,
  MinLength,
  MaxLength,
  IsOptional,
  Matches,
  IsNotEmpty,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class RegisterDto {
  @ApiProperty({ example: 'owner@example.com' })
  @IsEmail({}, { message: 'Provide a valid email address' })
  @Transform(({ value }: { value: string }) => value.toLowerCase().trim())
  email: string;

  @ApiProperty({ example: 'P@ssw0rd!2024', minLength: 8 })
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(72, { message: 'Password must not exceed 72 characters' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&]).+$/, {
    message:
      'Password must contain uppercase, lowercase, number, and special character',
  })
  password: string;

  @ApiPropertyOptional({ example: 'John Doe' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  display_name?: string;

  /** Cloudflare Turnstile token — validated server-side */
  @ApiProperty({ description: 'Cloudflare Turnstile CAPTCHA token' })
  @IsString()
  @IsNotEmpty()
  captcha_token: string;
}

export class LoginDto {
  @ApiProperty({ example: 'owner@example.com' })
  @IsEmail()
  @Transform(({ value }: { value: string }) => value.toLowerCase().trim())
  email: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  password: string;

  @ApiPropertyOptional({ description: 'TOTP code if MFA enabled' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'MFA code must be 6 digits' })
  mfa_code?: string;
}

export class RefreshTokenDto {
  @ApiProperty({ description: 'Refresh token from HTTP-only cookie' })
  @IsString()
  @IsNotEmpty()
  refresh_token: string;
}

export class PasswordResetRequestDto {
  @ApiProperty({ example: 'owner@example.com' })
  @IsEmail()
  @Transform(({ value }: { value: string }) => value.toLowerCase().trim())
  email: string;
}

export class PasswordResetConfirmDto {
  @ApiProperty({ description: 'Signed reset token from email link' })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({ example: 'NewP@ssw0rd!2024' })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&]).+$/, {
    message: 'Password must contain uppercase, lowercase, number, and special character',
  })
  new_password: string;
}

export class MfaEnableDto {
  @ApiProperty({ description: '6-digit TOTP code to confirm MFA setup' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'TOTP code must be 6 digits' })
  totp_code: string;
}

export class VerifyEmailDto {
  @ApiProperty({ description: 'Email verification token from link' })
  @IsString()
  @IsNotEmpty()
  token: string;
}

// ─── Response shapes ────────────────────────────────────────────────────────

export class AuthTokensResponse {
  @ApiProperty()
  access_token: string;

  @ApiProperty({ description: 'Expiry in seconds' })
  expires_in: number;

  @ApiProperty({ enum: ['Bearer'] })
  token_type: 'Bearer';
}

export class MfaSetupResponse {
  @ApiProperty({ description: 'TOTP provisioning URI for QR code' })
  otpauth_url: string;

  @ApiProperty({ description: 'Base64 QR code PNG' })
  qr_code: string;
}
