import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToOne,
  OneToMany,
  ManyToMany,
  JoinTable,
  Index,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { BusinessCard } from './business-card.entity';
import { MediaFile } from '../../media/entities/media-file.entity';
import { Category } from './category.entity';
import { AnalyticsEvent } from '../../analytics/entities/analytics-event.entity';

export enum BusinessStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  FLAGGED = 'flagged',
  SUSPENDED = 'suspended',
}

@Entity('businesses')
@Index(['tenant_id'])
@Index(['slug'], { unique: true, where: '"deleted_at" IS NULL' })
@Index(['owner_id'])
export class Business {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  owner_id: string;

  @ManyToOne(() => User, (user) => user.businesses, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'owner_id' })
  owner: User;

  /**
   * Tenant ID — equals owner_id for business owners.
   * Used by PostgreSQL Row-Level Security.
   */
  @Column()
  @Index()
  tenant_id: string;

  @Column({ length: 200 })
  name: string;

  @Column({ unique: true, length: 120 })
  @Index()
  slug: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'enum', enum: BusinessStatus, default: BusinessStatus.PENDING })
  status: BusinessStatus;

  @Column({ default: false })
  verified: boolean;

  @Column({ nullable: true })
  phone: string | null;

  @Column({ nullable: true })
  email: string | null;

  @Column({ nullable: true })
  website_url: string | null;

  @Column({ nullable: true })
  location: string | null;

  @Column({ nullable: true })
  logo_url: string | null;

  @Column({ nullable: true })
  banner_url: string | null;

  /**
   * Full-text search vector — maintained by PostgreSQL trigger.
   * GIN index applied in migration.
   */
  @Column({
    type: 'tsvector',
    nullable: true,
    select: false,
    generatedType: 'STORED',
    asExpression: `to_tsvector('english', coalesce(name,'') || ' ' || coalesce(description,''))`,
  })
  search_vector: string;

  @ManyToMany(() => Category, (cat) => cat.businesses, { eager: true })
  @JoinTable({
    name: 'business_categories',
    joinColumn: { name: 'business_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'category_id', referencedColumnName: 'id' },
  })
  categories: Category[];

  @OneToOne(() => BusinessCard, (card) => card.business, { cascade: true })
  card: BusinessCard;

  @OneToMany(() => MediaFile, (mf) => mf.business, { cascade: true })
  media_files: MediaFile[];

  @OneToMany(() => AnalyticsEvent, (ev) => ev.business)
  analytics_events: AnalyticsEvent[];

  /** Soft-delete: set to timestamp on delete, cleared on restore */
  @Column({ nullable: true, type: 'timestamptz' })
  @Index()
  deleted_at: Date | null;

  /** When deletion becomes permanent (30 days after soft-delete) */
  @Column({ nullable: true, type: 'timestamptz' })
  permanent_deletion_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  readonly created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
