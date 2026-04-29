import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';
import { Business } from '../../businesses/entities/business.entity';

export enum EventType {
  VIEW = 'view',
  CLICK = 'click',
  CTA = 'cta',
}

@Entity('analytics_events', {
  // PostgreSQL monthly range partitioning (set up in migration)
  // PARTITION BY RANGE (timestamp)
})
@Index(['business_id', 'event_type'])
@Index(['tenant_id'])
@Index(['timestamp'])
export class AnalyticsEvent {
  @PrimaryGeneratedColumn('uuid')
  event_id: string;

  @Column()
  @Index()
  tenant_id: string;

  @Column()
  @Index()
  business_id: string;

  @ManyToOne(() => Business, (b) => b.analytics_events, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'business_id' })
  business: Business;

  @Column({ type: 'enum', enum: EventType })
  event_type: EventType;

  /**
   * Timestamp is the partition key — do not rename.
   * Range partitions created monthly by cron job.
   */
  @CreateDateColumn({ type: 'timestamptz', name: 'timestamp' })
  timestamp: Date;

  /**
   * SHA-256 of anonymized IP (last octet zeroed).
   * Example: sha256("192.168.1.0")
   */
  @Column({ length: 64 })
  ip_hash: string;

  /** Session hash — derived from IP + user-agent + date (not stored raw) */
  @Column({ length: 64 })
  session_id: string;

  /** Referring domain only (no path or query) */
  @Column({ nullable: true, length: 200 })
  referrer: string | null;

  /** Which CTA was clicked (for event_type = 'cta') */
  @Column({ nullable: true, length: 100 })
  cta_label: string | null;
}
