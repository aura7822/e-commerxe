import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as sharp from 'sharp';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { extname } from 'path';

import { MediaFile, MediaFileType, MediaMimeType, MediaVariants } from './entities/media-file.entity';
import { Business } from '../businesses/entities/business.entity';
import { User } from '../users/entities/user.entity';
import { AuditService } from '../admin/audit.service';
import { AuditAction } from '../admin/entities/audit-log.entity';
import { RedisService } from '../auth/redis/redis.service';

/** Allowed MIME types — validated via magic bytes, NOT file extension */
const ALLOWED_MIME_TYPES: Record<string, MediaMimeType> = {
  'image/jpeg': MediaMimeType.JPG,
  'image/png':  MediaMimeType.PNG,
  'image/webp': MediaMimeType.WEBP,
  'image/avif': MediaMimeType.AVIF,
};

/** Magic byte signatures for each type */
const MAGIC_BYTES: Record<string, number[][]> = {
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/png':  [[0x89, 0x50, 0x4e, 0x47]],
  'image/webp': [[0x52, 0x49, 0x46, 0x46]], // RIFF....WEBP
  'image/avif': [], // AVIF validated by sharp parse
};

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_FILES_PER_BUSINESS = 20;
const UPLOAD_RATE_LIMIT_KEY = (userId: string) => `upload_rate:${userId}`;
const UPLOAD_RATE_LIMIT = 10;   // requests
const UPLOAD_RATE_WINDOW = 60;  // seconds

interface ProcessedImage {
  buffer: Buffer;
  width: number;
  height: number;
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly cdnUrl: string;

  constructor(
    @InjectRepository(MediaFile) private readonly mediaRepo: Repository<MediaFile>,
    @InjectRepository(Business) private readonly bizRepo: Repository<Business>,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {
    this.bucket = this.config.get<string>('R2_BUCKET_NAME')!;
    this.cdnUrl = this.config.get<string>('CDN_URL')!;

    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${this.config.get('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: this.config.get<string>('R2_ACCESS_KEY_ID')!,
        secretAccessKey: this.config.get<string>('R2_SECRET_ACCESS_KEY')!,
      },
    });
  }

  // ─── Upload ──────────────────────────────────────────────────────────────

  async upload(
    file: Express.Multer.File,
    businessId: string,
    fileType: MediaFileType,
    owner: User,
  ): Promise<MediaFile> {
    // ── Rate limiting (10 uploads/min per user) ──────────────────────
    await this.checkUploadRateLimit(owner.id);

    // ── Business ownership check ─────────────────────────────────────
    const business = await this.bizRepo.findOne({
      where: { id: businessId, owner_id: owner.id },
    });
    if (!business) throw new ForbiddenException('Business not found or access denied');

    // ── Max file count ───────────────────────────────────────────────
    const fileCount = await this.mediaRepo.count({ where: { business_id: businessId } });
    if (fileCount >= MAX_FILES_PER_BUSINESS) {
      throw new BadRequestException(`Maximum ${MAX_FILES_PER_BUSINESS} files allowed per business`);
    }

    // ── Size check ───────────────────────────────────────────────────
    if (file.size > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException('File exceeds the maximum size of 10 MB');
    }

    // ── Magic byte validation ────────────────────────────────────────
    const detectedMime = this.detectMimeType(file.buffer);
    if (!detectedMime) {
      throw new BadRequestException('Unsupported file type. Allowed: JPG, PNG, WebP, AVIF');
    }

    // ── EXIF strip + resize via Sharp ────────────────────────────────
    let sharpInstance: sharp.Sharp;
    try {
      sharpInstance = sharp(file.buffer).withMetadata(false); // strips EXIF
      await sharpInstance.metadata(); // validates it's a real image
    } catch {
      throw new BadRequestException('Invalid or corrupt image file');
    }

    // ── Process variants ─────────────────────────────────────────────
    const variants = await this.processVariants(sharpInstance, fileType);

    // ── Upload all variants to R2 ────────────────────────────────────
    const fileId = uuidv4();
    const basePath = `${owner.tenant_id}/${businessId}/${fileId}`;

    const [thumbnailKey, smallKey, mediumKey, originalKey] = await Promise.all([
      this.uploadToR2(`${basePath}/thumbnail.webp`, variants.thumbnail.buffer, 'image/webp'),
      this.uploadToR2(`${basePath}/small.webp`, variants.small.buffer, 'image/webp'),
      this.uploadToR2(`${basePath}/medium.webp`, variants.medium.buffer, 'image/webp'),
      this.uploadToR2(`${basePath}/original${extname(file.originalname)}`, file.buffer, file.mimetype),
    ]);

    const variantUrls: MediaVariants = {
      thumbnail: `${this.cdnUrl}/${thumbnailKey}`,
      small: `${this.cdnUrl}/${smallKey}`,
      medium: `${this.cdnUrl}/${mediumKey}`,
      original: `${this.cdnUrl}/${originalKey}`,
    };

    // Banner variant for banner type
    if (fileType === MediaFileType.BANNER) {
      const bannerKey = await this.uploadToR2(
        `${basePath}/banner.webp`,
        variants.banner!.buffer,
        'image/webp',
      );
      variantUrls.banner = `${this.cdnUrl}/${bannerKey}`;
    }

    const mediaFile = this.mediaRepo.create({
      business_id: businessId,
      tenant_id: owner.tenant_id!,
      file_type: fileType,
      mime_type: ALLOWED_MIME_TYPES[detectedMime],
      storage_key: originalKey,
      cdn_url: variantUrls.medium,
      variants: variantUrls,
      size_bytes: file.size,
      malware_scanned: false, // queued for async ClamAV scan
      malware_clean: false,
      original_filename: file.originalname.substring(0, 255),
    });

    const saved = await this.mediaRepo.save(mediaFile);

    // Queue malware scan (async — doesn't block response)
    await this.queueMalwareScan(saved.id, originalKey);

    await this.audit.log({
      actor_id: owner.id,
      action: AuditAction.MEDIA_UPLOADED,
      resource_id: saved.id,
      resource_type: 'media_file',
      metadata: { business_id: businessId, file_type: fileType, size_bytes: file.size },
    });

    this.logger.log(`Media uploaded: ${saved.id} for business ${businessId}`);
    return saved;
  }

  // ─── Delete ──────────────────────────────────────────────────────────────

  async delete(fileId: string, owner: User): Promise<void> {
    const file = await this.mediaRepo.findOne({
      where: { id: fileId, tenant_id: owner.tenant_id! },
    });
    if (!file) throw new ForbiddenException('File not found or access denied');

    // Delete all variants from R2
    const basePath = file.storage_key.replace(/\/original.*$/, '');
    await Promise.allSettled([
      this.deleteFromR2(`${basePath}/thumbnail.webp`),
      this.deleteFromR2(`${basePath}/small.webp`),
      this.deleteFromR2(`${basePath}/medium.webp`),
      this.deleteFromR2(`${basePath}/banner.webp`),
      this.deleteFromR2(file.storage_key),
    ]);

    await this.mediaRepo.remove(file);

    await this.audit.log({
      actor_id: owner.id,
      action: AuditAction.MEDIA_DELETED,
      resource_id: fileId,
      resource_type: 'media_file',
    });
  }

  // ─── Presigned upload URL (direct browser → R2 upload flow) ─────────────

  async getPresignedUploadUrl(
    businessId: string,
    filename: string,
    owner: User,
  ): Promise<{ url: string; key: string; expires_in: number }> {
    const key = `${owner.tenant_id}/${businessId}/${uuidv4()}/${filename}`;
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: 'application/octet-stream',
    });
    const url = await getSignedUrl(this.s3, command, { expiresIn: 900 }); // 15 min
    return { url, key, expires_in: 900 };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private detectMimeType(buffer: Buffer): string | null {
    const header = Array.from(buffer.slice(0, 12));

    if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg';
    if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47) return 'image/png';
    if (
      header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
    ) return 'image/webp';

    // AVIF — ftyp box check
    const ftyp = buffer.toString('ascii', 4, 8);
    if (ftyp === 'ftyp') return 'image/avif';

    return null;
  }

  private async processVariants(
    instance: sharp.Sharp,
    fileType: MediaFileType,
  ): Promise<{
    thumbnail: ProcessedImage;
    small: ProcessedImage;
    medium: ProcessedImage;
    banner?: ProcessedImage;
  }> {
    const [thumbnail, small, medium] = await Promise.all([
      instance.clone().resize(150, 150, { fit: 'cover' }).webp({ quality: 80 }).toBuffer({ resolveWithObject: true }),
      instance.clone().resize(400, 400, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true }),
      instance.clone().resize(800, 800, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer({ resolveWithObject: true }),
    ]);

    const result: Awaited<ReturnType<typeof this.processVariants>> = {
      thumbnail: { buffer: thumbnail.data, width: thumbnail.info.width, height: thumbnail.info.height },
      small:     { buffer: small.data,     width: small.info.width,     height: small.info.height },
      medium:    { buffer: medium.data,    width: medium.info.width,    height: medium.info.height },
    };

    if (fileType === MediaFileType.BANNER) {
      const banner = await instance.clone().resize(1200, 400, { fit: 'cover' }).webp({ quality: 85 }).toBuffer({ resolveWithObject: true });
      result.banner = { buffer: banner.data, width: banner.info.width, height: banner.info.height };
    }

    return result;
  }

  private async uploadToR2(key: string, body: Buffer, contentType: string): Promise<string> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ServerSideEncryption: 'AES256', // SSE encryption at rest
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return key;
  }

  private async deleteFromR2(key: string): Promise<void> {
    try {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      this.logger.warn(`Failed to delete R2 object ${key}: ${err}`);
    }
  }

  private async checkUploadRateLimit(userId: string): Promise<void> {
    const key = UPLOAD_RATE_LIMIT_KEY(userId);
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, UPLOAD_RATE_WINDOW);
    if (count > UPLOAD_RATE_LIMIT) {
      throw new BadRequestException('Upload rate limit exceeded — max 10 uploads per minute');
    }
  }

  private async queueMalwareScan(fileId: string, storageKey: string): Promise<void> {
    // Push to Redis queue — consumed by a separate ClamAV worker process
    await this.redis.rpush('queue:malware_scan', JSON.stringify({ fileId, storageKey }));
  }
}
