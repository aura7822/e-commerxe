import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { Business } from '../../businesses/entities/business.entity';

export enum MediaFileType {
  LOGO = 'logo',
  BANNER = 'banner',
  GALLERY = 'gallery',
}

export enum MediaMimeType {
  JPG = 'image/jpeg',
  PNG = 'image/png',
  WEBP = 'image/webp',
  AVIF = 'image/avif',
}

export interface MediaVariants {
  thumbnail: string; // 150x150
  small: string;     // 400x400
  medium: string;    // 800x800
  banner?: string;   // 1200x400 (banner only)
  original: string;
}

@Entity('media_files')
@Index(['business_id'])
@Index(['tenant_id'])
export class MediaFile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  business_id: string;

  @ManyToOne(() => Business, (b) => b.media_files, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'business_id' })
  business: Business;

  /** Tenant ID mirrors owner for RLS enforcement */
  @Column()
  tenant_id: string;

  @Column({ type: 'enum', enum: MediaFileType })
  file_type: MediaFileType;

  @Column({ type: 'enum', enum: MediaMimeType })
  mime_type: MediaMimeType;

  /** R2 object key (never exposed publicly) */
  @Column({ select: false })
  storage_key: string;

  /** Public CDN URL */
  @Column()
  cdn_url: string;

  /** All processed size variants */
  @Column({ type: 'jsonb', nullable: true })
  variants: MediaVariants | null;

  @Column({ type: 'int' })
  size_bytes: number;

  @Column({ default: false })
  malware_scanned: boolean;

  @Column({ default: false })
  malware_clean: boolean;

  @Column({ nullable: true })
  original_filename: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
