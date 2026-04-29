import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { User } from './entities/user.entity';
import { Business } from '../businesses/entities/business.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { AuditService } from '../admin/audit.service';
import { AuditAction } from '../admin/entities/audit-log.entity';
import { EmailService } from '../auth/email/email.service';

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Jane Doe' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  display_name?: string;

  @ApiPropertyOptional({ example: 'https://example.com/avatar.jpg' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatar_url?: string;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Business) private readonly bizRepo: Repository<Business>,
    @InjectRepository(MediaFile) private readonly mediaRepo: Repository<MediaFile>,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly email: EmailService,
  ) {}

  // ─── Profile ─────────────────────────────────────────────────────────────

  async getProfile(userId: string): Promise<User> {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: [
        'id', 'email', 'role', 'display_name', 'avatar_url',
        'email_verified', 'mfa_enabled', 'auth_provider',
        'created_at', 'last_login_at',
      ],
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<User> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    await this.userRepo.update(userId, {
      ...(dto.display_name !== undefined && { display_name: dto.display_name }),
      ...(dto.avatar_url !== undefined && { avatar_url: dto.avatar_url }),
    });

    await this.audit.log({
      actor_id: userId,
      action: AuditAction.USER_REGISTER, // re-using closest action; extend enum in prod
      resource_id: userId,
      resource_type: 'user',
      metadata: { update: dto },
    });

    return this.getProfile(userId);
  }

  // ─── GDPR: Data Export ───────────────────────────────────────────────────

  /**
   * FR-004: Assembles a full GDPR data export for the requesting user.
   * Returns a JSON-serialisable object. The controller streams it as a
   * downloadable .json file.
   */
  async exportData(userId: string): Promise<Record<string, unknown>> {
    const [user, businesses, media] = await Promise.all([
      this.userRepo.findOne({
        where: { id: userId },
        select: [
          'id', 'email', 'display_name', 'role', 'auth_provider',
          'email_verified', 'mfa_enabled', 'created_at', 'last_login_at',
        ],
      }),
      this.bizRepo.find({
        where: { owner_id: userId },
        relations: ['categories', 'card'],
        withDeleted: true,
      }),
      this.mediaRepo.find({ where: { tenant_id: userId } }),
    ]);

    if (!user) throw new NotFoundException('User not found');

    return {
      exported_at: new Date().toISOString(),
      profile: user,
      businesses: businesses.map((b) => ({
        id: b.id,
        name: b.name,
        slug: b.slug,
        status: b.status,
        description: b.description,
        categories: b.categories,
        created_at: b.created_at,
        updated_at: b.updated_at,
        deleted_at: b.deleted_at,
      })),
      media_files: media.map((m) => ({
        id: m.id,
        file_type: m.file_type,
        cdn_url: m.cdn_url,
        size_bytes: m.size_bytes,
        created_at: m.created_at,
      })),
      note: 'Analytics events are anonymised and cannot be linked back to you.',
    };
  }

  // ─── GDPR: Account Deletion ──────────────────────────────────────────────

  /**
   * FR-005: Self-requested account deletion with 30-day grace period.
   * Hard deletion is executed by the scheduled cleanup job.
   */
  async requestDeletion(userId: string): Promise<{ message: string; scheduled_at: Date }> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    if (user.deletion_requested_at) {
      throw new BadRequestException('Account deletion is already scheduled');
    }

    const scheduledAt = new Date();
    scheduledAt.setDate(scheduledAt.getDate() + 30);

    await this.userRepo.update(userId, {
      deletion_requested_at: new Date(),
      deletion_scheduled_at: scheduledAt,
    });

    await this.email.sendDeletionScheduled(user.email, scheduledAt);

    await this.audit.log({
      actor_id: userId,
      action: AuditAction.USER_DELETED,
      resource_id: userId,
      resource_type: 'user',
      metadata: { scheduled_at: scheduledAt, initiated_by: 'self' },
    });

    return {
      message: `Account will be permanently deleted on ${scheduledAt.toDateString()}. Contact support to cancel.`,
      scheduled_at: scheduledAt,
    };
  }

  /** Cancel a pending self-deletion (within the 30-day grace) */
  async cancelDeletion(userId: string): Promise<{ message: string }> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (!user.deletion_requested_at) {
      throw new BadRequestException('No pending deletion to cancel');
    }

    await this.userRepo.update(userId, {
      deletion_requested_at: null,
      deletion_scheduled_at: null,
    });

    return { message: 'Account deletion cancelled successfully.' };
  }
}
