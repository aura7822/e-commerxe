import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { Business } from './business.entity';

export interface SeoMetadata {
  title: string;
  description: string;
  keywords: string[];
  og_image?: string;
  schema_type: 'LocalBusiness' | 'Store' | 'Restaurant' | 'AutoDealer';
}

export interface CtaButton {
  label: string;
  url: string;
  type: 'phone' | 'email' | 'website' | 'whatsapp' | 'custom';
}

@Entity('business_cards')
export class BusinessCard {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  business_id: string;

  @OneToOne(() => Business, (b) => b.card, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'business_id' })
  business: Business;

  /**
   * SEO-friendly slug — immutable after creation.
   * Changes stored in slug_redirects table.
   */
  @Column({ unique: true, length: 120 })
  @Index({ unique: true })
  slug: string;

  /** 1–5 templates defined in frontend */
  @Column({ default: 1 })
  template_id: number;

  @Column({ type: 'jsonb', nullable: true })
  seo_metadata: SeoMetadata | null;

  @Column({ type: 'jsonb', nullable: true })
  cta_buttons: CtaButton[] | null;

  @Column({ type: 'text', nullable: true })
  custom_css: string | null;

  @Column({ default: true })
  is_published: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}

/** Stores old slug → new slug for 301 redirects */
@Entity('slug_redirects')
@Index(['old_slug'])
export class SlugRedirect {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  old_slug: string;

  @Column()
  new_slug: string;

  @Column()
  business_id: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
