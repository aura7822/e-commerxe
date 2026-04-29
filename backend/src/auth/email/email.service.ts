import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly appUrl: string;

  constructor(private readonly config: ConfigService) {
    this.from = this.config.get<string>('SMTP_FROM')!;
    this.appUrl = this.config.get<string>('APP_URL')!;

    this.transporter = nodemailer.createTransport({
      host: this.config.get<string>('SMTP_HOST'),
      port: this.config.get<number>('SMTP_PORT'),
      secure: false,
      auth: {
        user: this.config.get<string>('SMTP_USER'),
        pass: this.config.get<string>('SMTP_PASS'),
      },
    });
  }

  async sendVerification(email: string, token: string): Promise<void> {
    const link = `${this.appUrl}/api/v1/auth/verify-email?token=${token}`;
    await this.send({
      to: email,
      subject: 'Verify your E-CommerXE account',
      html: this.template('Verify Your Email', `
        <p>Thanks for signing up! Click the button below to verify your email address.</p>
        <p>This link expires in <strong>24 hours</strong>.</p>
        ${this.button('Verify Email', link)}
        <p style="color:#666;font-size:12px">If you didn't create an account, ignore this email.</p>
      `),
    });
  }

  async sendPasswordReset(email: string, token: string): Promise<void> {
    const link = `${this.config.get('FRONTEND_URL')}/reset-password?token=${token}`;
    await this.send({
      to: email,
      subject: 'Reset your E-CommerXE password',
      html: this.template('Password Reset', `
        <p>We received a request to reset your password.</p>
        <p>This link expires in <strong>15 minutes</strong>.</p>
        ${this.button('Reset Password', link)}
        <p style="color:#666;font-size:12px">If you didn't request a reset, you can safely ignore this.</p>
      `),
    });
  }

  async sendLockoutNotification(email: string, lockoutMinutes: number): Promise<void> {
    await this.send({
      to: email,
      subject: 'E-CommerXE: Account temporarily locked',
      html: this.template('Account Locked', `
        <p>Your account has been temporarily locked for <strong>${lockoutMinutes} minutes</strong> due to too many failed login attempts.</p>
        <p>If this wasn't you, please <a href="${this.appUrl}/api/v1/auth/password-reset">reset your password</a> immediately.</p>
      `),
    });
  }

  async sendBusinessApproved(email: string, businessName: string, slug: string): Promise<void> {
    const link = `${this.config.get('FRONTEND_URL')}/biz/${slug}`;
    await this.send({
      to: email,
      subject: `Your business "${businessName}" is now live!`,
      html: this.template('Business Approved 🎉', `
        <p>Great news! <strong>${businessName}</strong> has been approved and is now visible to customers.</p>
        ${this.button('View Your Business', link)}
      `),
    });
  }

  async sendDeletionScheduled(email: string, scheduledAt: Date): Promise<void> {
    await this.send({
      to: email,
      subject: 'E-CommerXE: Account deletion scheduled',
      html: this.template('Account Deletion Scheduled', `
        <p>Your account deletion has been scheduled for <strong>${scheduledAt.toDateString()}</strong>.</p>
        <p>All your data will be permanently deleted on that date.</p>
        <p>If you changed your mind, contact support before that date to cancel.</p>
      `),
    });
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  private async send(options: {
    to: string;
    subject: string;
    html: string;
  }): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.from,
        ...options,
      });
    } catch (err) {
      // Log but never throw — email failures must not break API responses
      this.logger.error(`Failed to send email to ${options.to}`, err);
    }
  }

  private template(heading: string, body: string): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
      </head>
      <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0b0e13;margin:0;padding:40px 20px">
        <div style="max-width:520px;margin:0 auto;background:#13171f;border:1px solid rgba(255,255,255,0.07);border-radius:14px;overflow:hidden">
          <div style="background:#f5a623;padding:20px 32px">
            <span style="font-size:22px;font-weight:800;color:#000;letter-spacing:-0.5px">E-CommerXE</span>
          </div>
          <div style="padding:32px">
            <h2 style="color:#e8eaf0;margin:0 0 16px;font-size:20px">${heading}</h2>
            <div style="color:#7a8097;line-height:1.7;font-size:15px">${body}</div>
          </div>
          <div style="padding:20px 32px;border-top:1px solid rgba(255,255,255,0.07);color:#4a4f60;font-size:12px">
            © ${new Date().getFullYear()} E-CommerXE. All rights reserved.
          </div>
        </div>
      </body>
      </html>
    `;
  }

  private button(label: string, href: string): string {
    return `
      <p style="margin:24px 0">
        <a href="${href}"
           style="background:#f5a623;color:#000;text-decoration:none;font-weight:700;
                  padding:12px 24px;border-radius:50px;display:inline-block;font-size:14px">
          ${label}
        </a>
      </p>
    `;
  }
}
