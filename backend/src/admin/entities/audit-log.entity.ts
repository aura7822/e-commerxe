import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum AuditAction {
  USER_REGISTER = 'user.register',
  USER_LOGIN = 'user.login',
  USER_LOGOUT = 'user.logout',
  USER_PASSWORD_RESET = 'user.password_reset',
  USER_MFA_ENABLE = 'user.mfa_enable',
  USER_SUSPENDED = 'user.suspended',
  USER_DELETED = 'user.deleted',
  BUSINESS_CREATED = 'business.created',
  BUSINESS_UPDATED = 'business.updated',
  BUSINESS_DELETED = 'business.deleted',
  BUSINESS_APPROVED = 'business.approved',
  BUSINESS_FLAGGED = 'business.flagged',
  MEDIA_UPLOADED = 'media.uploaded',
  MEDIA_DELETED = 'media.deleted',
  ADMIN_ROLE_CHANGE = 'admin.role_change',
}

/**
 * Append-only audit log table.
 * NEVER delete rows. TRUNCATE is denied via PostgreSQL rule in migration.
 */
@Entity('audit_logs')
@Index(['actor_id'])
@Index(['resource_id'])
@Index(['action'])
@Index(['created_at'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Who performed the action (user_id or 'system') */
  @Column({ nullable: true })
  actor_id: string | null;

  @Column({ type: 'enum', enum: AuditAction })
  action: AuditAction;

  /** Affected entity (business_id, user_id, etc.) */
  @Column({ nullable: true })
  resource_id: string | null;

  /** Resource type for context */
  @Column({ nullable: true })
  resource_type: string | null;

  /** Snapshot of changed fields (before/after) */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  /** Anonymized IP */
  @Column({ nullable: true, length: 64 })
  ip_hash: string | null;

  @Column({ nullable: true })
  user_agent: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  readonly created_at: Date;
}
