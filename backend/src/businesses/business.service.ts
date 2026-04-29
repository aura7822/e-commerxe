import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, IsNull, Not } from 'typeorm';
import slugify from 'slugify';

import { Business, BusinessStatus } from './entities/business.entity';
import { BusinessCard, SlugRedirect } from './entities/business-card.entity';
import { Category } from './entities/category.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { AuditService } from '../admin/audit.service';
import { AuditAction } from '../admin/entities/audit-log.entity';
import { RlsContextService } from '../database/rls-context.service';
import { CreateBusinessDto } from './dto/create-business.dto';
import { UpdateBusinessDto } from './dto/update-business.dto';

const MAX_BUSINESSES_PER_ACCOUNT = 5;
const SOFT_DELETE_GRACE_DAYS = 30;

@Injectable()
export class BusinessService {
  private readonly logger = new Logger(BusinessService.name);

  constructor(
    @InjectRepository(Business) private readonly bizRepo: Repository<Business>,
    @InjectRepository(BusinessCard) private readonly cardRepo: Repository<BusinessCard>,
    @InjectRepository(SlugRedirect) private readonly redirectRepo: Repository<SlugRedirect>,
    @InjectRepository(Category) private readonly catRepo: Repository<Category>,
    private readonly dataSource: DataSource,
    private readonly rlsContext: RlsContextService,
    private readonly audit: AuditService,
  ) {}

  // ─── Create ──────────────────────────────────────────────────────────────

  async create(dto: CreateBusinessDto, owner: User): Promise<Business> {
    // Enforce max 5 businesses per account
    const count = await this.bizRepo.count({
      where: { owner_id: owner.id, deleted_at: IsNull() },
    });
    if (count >= MAX_BUSINESSES_PER_ACCOUNT) {
      throw new ForbiddenException(
        `You have reached the maximum of ${MAX_BUSINESSES_PER_ACCOUNT} businesses per account`,
      );
    }

    // Validate categories (1–3 allowed)
    if (!dto.category_ids?.length || dto.category_ids.length > 3) {
      throw new BadRequestException('You must assign 1 to 3 categories');
    }
    const categories = await this.catRepo.findByIds(dto.category_ids);
    if (categories.length !== dto.category_ids.length) {
      throw new BadRequestException('One or more category IDs are invalid');
    }

    const slug = await this.generateUniqueSlug(dto.name);

    return this.rlsContext.run(owner.tenant_id!, async () => {
      const business = this.bizRepo.create({
        ...dto,
        slug,
        owner_id: owner.id,
        tenant_id: owner.tenant_id!,
        categories,
        status: BusinessStatus.PENDING,
      });
      const saved = await this.bizRepo.save(business);

      // Create the public-facing business card
      const card = this.cardRepo.create({
        business_id: saved.id,
        slug,
        template_id: dto.template_id ?? 1,
        seo_metadata: {
          title: dto.name,
          description: dto.description ?? `Visit ${dto.name} on E-CommerXE`,
          keywords: categories.map((c) => c.name),
          schema_type: 'LocalBusiness',
        },
        is_published: false, // published after admin approval
      });
      await this.cardRepo.save(card);

      await this.audit.log({
        actor_id: owner.id,
        action: AuditAction.BUSINESS_CREATED,
        resource_id: saved.id,
        resource_type: 'business',
        metadata: { name: saved.name, slug },
      });

      this.logger.log(`Business created: ${saved.id} by owner ${owner.id}`);
      return this.findOneForOwner(saved.id, owner);
    });
  }

  // ─── Read (owner — full data via RLS) ───────────────────────────────────

  async findAllForOwner(owner: User, page = 1, limit = 20): Promise<{
    data: Business[];
    total: number;
    page: number;
    limit: number;
  }> {
    const [data, total] = await this.rlsContext.run(owner.tenant_id!, () =>
      this.bizRepo.findAndCount({
        where: { owner_id: owner.id, deleted_at: IsNull() },
        relations: ['categories', 'card'],
        order: { created_at: 'DESC' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    );
    return { data, total, page, limit };
  }

  async findOneForOwner(id: string, owner: User): Promise<Business> {
    const biz = await this.rlsContext.run(owner.tenant_id!, () =>
      this.bizRepo.findOne({
        where: { id, owner_id: owner.id, deleted_at: IsNull() },
        relations: ['categories', 'card', 'media_files'],
      }),
    );
    if (!biz) throw new NotFoundException('Business not found');
    return biz;
  }

  // ─── Read (public — no auth, RLS bypass for active only) ────────────────

  async findPublicById(id: string): Promise<Business> {
    const biz = await this.bizRepo.findOne({
      where: { id, status: BusinessStatus.ACTIVE, deleted_at: IsNull() },
      relations: ['categories', 'card', 'media_files'],
    });
    if (!biz) throw new NotFoundException('Business not found');
    return biz;
  }

  // ─── Update ──────────────────────────────────────────────────────────────

  async update(id: string, dto: UpdateBusinessDto, owner: User): Promise<Business> {
    const biz = await this.findOneForOwner(id, owner);

    // Handle slug changes → store 301 redirect
    let newSlug = biz.slug;
    if (dto.name && dto.name !== biz.name) {
      newSlug = await this.generateUniqueSlug(dto.name, id);
      if (newSlug !== biz.slug) {
        await this.redirectRepo.save({
          old_slug: biz.slug,
          new_slug: newSlug,
          business_id: id,
        });
      }
    }

    // Validate updated categories
    let categories = biz.categories;
    if (dto.category_ids) {
      if (dto.category_ids.length === 0 || dto.category_ids.length > 3) {
        throw new BadRequestException('You must assign 1 to 3 categories');
      }
      categories = await this.catRepo.findByIds(dto.category_ids);
      if (categories.length !== dto.category_ids.length) {
        throw new BadRequestException('One or more category IDs are invalid');
      }
    }

    const updated = await this.rlsContext.run(owner.tenant_id!, async () => {
      Object.assign(biz, dto, { slug: newSlug, categories });
      // created_at is immutable (enforced at DB level too)
      const result = await this.bizRepo.save(biz);

      // Keep card slug in sync
      if (biz.card && newSlug !== biz.card.slug) {
        await this.cardRepo.update(biz.card.id, { slug: newSlug });
      }

      return result;
    });

    await this.audit.log({
      actor_id: owner.id,
      action: AuditAction.BUSINESS_UPDATED,
      resource_id: id,
      resource_type: 'business',
      metadata: { changes: dto },
    });

    return updated;
  }

  // ─── Soft Delete ─────────────────────────────────────────────────────────

  async softDelete(id: string, owner: User): Promise<{ message: string }> {
    const biz = await this.findOneForOwner(id, owner);

    const deletedAt = new Date();
    const permanentAt = new Date(deletedAt);
    permanentAt.setDate(permanentAt.getDate() + SOFT_DELETE_GRACE_DAYS);

    await this.rlsContext.run(owner.tenant_id!, () =>
      this.bizRepo.update(id, {
        deleted_at: deletedAt,
        permanent_deletion_at: permanentAt,
        status: BusinessStatus.SUSPENDED,
      }),
    );

    await this.audit.log({
      actor_id: owner.id,
      action: AuditAction.BUSINESS_DELETED,
      resource_id: id,
      resource_type: 'business',
      metadata: { permanent_deletion_at: permanentAt },
    });

    return {
      message: `Business soft-deleted. You have ${SOFT_DELETE_GRACE_DAYS} days to recover it.`,
    };
  }

  /** Restore a soft-deleted business within the 30-day grace window */
  async restore(id: string, owner: User): Promise<Business> {
    const biz = await this.bizRepo.findOne({
      where: { id, owner_id: owner.id, deleted_at: Not(IsNull()) },
    });
    if (!biz) throw new NotFoundException('Deleted business not found');
    if (biz.permanent_deletion_at && biz.permanent_deletion_at < new Date()) {
      throw new ForbiddenException('Grace period has expired — business cannot be restored');
    }

    await this.bizRepo.update(id, {
      deleted_at: null,
      permanent_deletion_at: null,
      status: BusinessStatus.PENDING,
    });

    return this.findOneForOwner(id, owner);
  }

  // ─── Admin operations ────────────────────────────────────────────────────

  async approve(id: string, adminId: string): Promise<Business> {
    const biz = await this.bizRepo.findOne({ where: { id } });
    if (!biz) throw new NotFoundException('Business not found');

    await this.bizRepo.update(id, { status: BusinessStatus.ACTIVE, verified: true });
    if (biz.card) {
      await this.cardRepo.update(biz.card.id, { is_published: true });
    }

    await this.audit.log({
      actor_id: adminId,
      action: AuditAction.BUSINESS_APPROVED,
      resource_id: id,
      resource_type: 'business',
    });

    return this.bizRepo.findOneOrFail({ where: { id }, relations: ['categories', 'card'] });
  }

  async flag(id: string, adminId: string, reason: string): Promise<void> {
    await this.bizRepo.update(id, { status: BusinessStatus.FLAGGED });
    await this.audit.log({
      actor_id: adminId,
      action: AuditAction.BUSINESS_FLAGGED,
      resource_id: id,
      resource_type: 'business',
      metadata: { reason },
    });
  }

  // ─── Slug utilities ──────────────────────────────────────────────────────

  private async generateUniqueSlug(name: string, excludeId?: string): Promise<string> {
    const base = slugify(name, { lower: true, strict: true, trim: true });
    let candidate = base;
    let suffix = 0;

    while (true) {
      const existing = await this.bizRepo.findOne({
        where: { slug: candidate, deleted_at: IsNull() },
      });
      if (!existing || existing.id === excludeId) break;
      suffix += 1;
      candidate = `${base}-${suffix}`;
    }

    return candidate;
  }

  /** Resolve a slug — returns business or checks redirect table */
  async resolveSlug(slug: string): Promise<Business | { redirect: string }> {
    const biz = await this.bizRepo.findOne({
      where: { slug, status: BusinessStatus.ACTIVE, deleted_at: IsNull() },
      relations: ['categories', 'card', 'media_files'],
    });
    if (biz) return biz;

    // Check redirect table for 301
    const redirect = await this.redirectRepo.findOne({ where: { old_slug: slug } });
    if (redirect) return { redirect: redirect.new_slug };

    throw new NotFoundException(`No business found for slug: ${slug}`);
  }
}
