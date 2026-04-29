import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { Exclude } from 'class-transformer';
import { Business } from '../../businesses/entities/business.entity';

export enum UserRole {
  SUDO_ADMIN = 'sudo_admin',
  BUSINESS_OWNER = 'business_owner',
  VISITOR = 'visitor',
}

export enum AuthProvider {
  LOCAL = 'local',
  GOOGLE = 'google',
}

@Entity('users')
@Index(['email'], { unique: true })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true, length: 255 })
  email: string;

  @Column({ nullable: true, select: false })
  @Exclude()
  password_hash: string | null;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.VISITOR })
  role: UserRole;

  @Column({ type: 'enum', enum: AuthProvider, default: AuthProvider.LOCAL })
  auth_provider: AuthProvider;

  @Column({ nullable: true })
  google_id: string | null;

  @Column({ default: false })
  email_verified: boolean;

  @Column({ nullable: true, select: false })
  @Exclude()
  email_verification_token: string | null;

  @Column({ nullable: true, type: 'timestamptz' })
  email_verification_expires: Date | null;

  @Column({ nullable: true, select: false })
  @Exclude()
  mfa_secret: string | null;

  @Column({ default: false })
  mfa_enabled: boolean;

  @Column({ nullable: true })
  display_name: string | null;

  @Column({ nullable: true })
  avatar_url: string | null;

  @Column({ default: false })
  is_suspended: boolean;

  @Column({ default: 0 })
  failed_login_attempts: number;

  @Column({ nullable: true, type: 'timestamptz' })
  lockout_until: Date | null;

  @Column({ nullable: true, type: 'timestamptz' })
  last_login_at: Date | null;

  /** Tenant ID for RLS — same as user ID for owners, set per-request */
  @Column({ nullable: true })
  @Index()
  tenant_id: string | null;

  @Column({ nullable: true, type: 'timestamptz' })
  deletion_requested_at: Date | null;

  @Column({ nullable: true, type: 'timestamptz' })
  deletion_scheduled_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @OneToMany(() => Business, (business) => business.owner)
  businesses: Business[];

  // Derived helpers (not persisted)
  get isLocked(): boolean {
    return this.lockout_until !== null && this.lockout_until > new Date();
  }
}
