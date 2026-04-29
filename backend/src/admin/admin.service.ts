import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, ILike } from 'typeorm';

import { AuditLog, AuditAction } from './entities/audit-log.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { Business, BusinessStatus } from '../businesses/entities/business.entity';

// ─── Audit Service ───────────────────────────────────────────────────────────

interface AuditLogParams {
  actor_id?: string | null;
  action: AuditAction;
  resource_id?: string;
  resource_type?: string;
  metadata?: Record<string, unknown>;
  ip_hash?: string;
  user_agent?: string;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditRepo: Repository<AuditLog>,
  ) {}

  async log(params: AuditLogParams): Promise<void> {
    try {
      const entry = this.auditRepo.create({
        actor_id: params.actor_id ?? null,
        action: params.action,
        resource_id: params.resource_id ?? null,
        resource_type: params.resource_type ?? null,
        metadata: params.metadata ?? null,
        ip_hash: params.ip_hash ?? null,
        user_agent: params.user_agent ?? null,
      });
      await this.auditRepo.save(entry);
    } catch (err) {
      // Audit failures must never crash the main flow
      this.logger.error('Failed to write audit log', err);
    }
  }

  async findAll(page = 1, limit = 50, action?: AuditAction) {
    const [data, total] = await this.auditRepo.findAndCount({
      where: action ? { action } : {},
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data, total, page, limit };
  }
}

// ─── Admin Service ───────────────────────────────────────────────────────────

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Business) private readonly bizRepo: Repository<Business>,
    @InjectRepository(AuditLog) private readonly auditRepo: Repository<AuditLog>,
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
  ) {}

  // ─── Users ───────────────────────────────────────────────────────────────

  async listUsers(page = 1, limit = 50, search?: string) {
    const where = search ? { email: ILike(`%${search}%`) } : {};
    const [data, total] = await this.userRepo.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
      select: [
        'id', 'email', 'role', 'email_verified', 'is_suspended',
        'created_at', 'last_login_at', 'auth_provider',
      ],
    });
    return { data, total, page, limit };
  }

  async suspendUser(targetId: string, adminId: string): Promise<void> {
    const user = await this.userRepo.findOne({ where: { id: targetId } });
    if (!user) throw new NotFoundException('User not found');

    await this.userRepo.update(targetId, { is_suspended: true });
    await this.auditService.log({
      actor_id: adminId,
      action: AuditAction.USER_SUSPENDED,
      resource_id: targetId,
      resource_type: 'user',
    });
  }

  async activateUser(targetId: string, adminId: string): Promise<void> {
    await this.userRepo.update(targetId, { is_suspended: false });
    await this.auditService.log({
      actor_id: adminId,
      action: AuditAction.USER_SUSPENDED,
      resource_id: targetId,
      resource_type: 'user',
      metadata: { action: 'reactivated' },
    });
  }

  async changeRole(
    targetId: string,
    newRole: UserRole,
    adminId: string,
  ): Promise<void> {
    const user = await this.userRepo.findOne({
      where: { id: targetId },
      select: ['id', 'role'],
    });
    if (!user) throw new NotFoundException('User not found');

    await this.userRepo.update(targetId, { role: newRole });
    await this.auditService.log({
      actor_id: adminId,
      action: AuditAction.ADMIN_ROLE_CHANGE,
      resource_id: targetId,
      resource_type: 'user',
      metadata: { from: user.role, to: newRole },
    });
  }

  async deleteUserAccount(targetId: string, adminId: string): Promise<void> {
    const user = await this.userRepo.findOne({ where: { id: targetId } });
    if (!user) throw new NotFoundException('User not found');

    // Schedule hard deletion after 30-day GDPR grace
    const scheduledAt = new Date();
    scheduledAt.setDate(scheduledAt.getDate() + 30);
    await this.userRepo.update(targetId, {
      deletion_requested_at: new Date(),
      deletion_scheduled_at: scheduledAt,
      is_suspended: true,
    });
    await this.auditService.log({
      actor_id: adminId,
      action: AuditAction.USER_DELETED,
      resource_id: targetId,
      resource_type: 'user',
      metadata: { scheduled_at: scheduledAt },
    });
  }

  // ─── Businesses ──────────────────────────────────────────────────────────

  async listPendingBusinesses(page = 1, limit = 50) {
    const [data, total] = await this.bizRepo.findAndCount({
      where: { status: BusinessStatus.PENDING },
      relations: ['owner', 'categories'],
      order: { created_at: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data, total, page, limit };
  }

  async listAllBusinesses(page = 1, limit = 50) {
    const [data, total] = await this.bizRepo.findAndCount({
      relations: ['owner', 'categories'],
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data, total, page, limit };
  }

  // ─── System metrics ──────────────────────────────────────────────────────

  async getSystemMetrics() {
    const [totalUsers, totalBusinesses, pendingBusinesses, activeBusinesses] =
      await Promise.all([
        this.userRepo.count(),
        this.bizRepo.count(),
        this.bizRepo.count({ where: { status: BusinessStatus.PENDING } }),
        this.bizRepo.count({ where: { status: BusinessStatus.ACTIVE } }),
      ]);

    return {
      users: { total: totalUsers },
      businesses: {
        total: totalBusinesses,
        pending: pendingBusinesses,
        active: activeBusinesses,
      },
    };
  }
}
