import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  ForbiddenException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

import { BusinessService } from './business.service';
import { Business, BusinessStatus } from './entities/business.entity';
import { BusinessCard, SlugRedirect } from './entities/business-card.entity';
import { Category } from './entities/category.entity';
import { User, UserRole, AuthProvider } from '../users/entities/user.entity';
import { RlsContextService } from '../database/rls-context.service';
import { AuditService } from '../admin/admin.service';

// ── Mock factories ────────────────────────────────────────────────────────────

const mockBizRepo = () => ({
  count: jest.fn(),
  findOne: jest.fn(),
  findOneOrFail: jest.fn(),
  findAndCount: jest.fn(),
  find: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
});

const mockCardRepo = () => ({
  create: jest.fn(),
  save: jest.fn(),
  update: jest.fn(),
});

const mockRedirectRepo = () => ({
  save: jest.fn(),
  findOne: jest.fn(),
});

const mockCatRepo = () => ({
  findByIds: jest.fn(),
});

const mockRlsContext = () => ({
  run: jest.fn((tenantId: string, cb: () => Promise<unknown>) => cb()),
  runAsAdmin: jest.fn((cb: () => Promise<unknown>) => cb()),
});

const mockAuditService = () => ({
  log: jest.fn().mockResolvedValue(undefined),
});

const mockDataSource = () => ({
  transaction: jest.fn((cb: (em: unknown) => Promise<unknown>) => cb({})),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildOwner(overrides: Partial<User> = {}): User {
  return {
    id: 'owner-uuid-1',
    email: 'owner@example.com',
    role: UserRole.BUSINESS_OWNER,
    tenant_id: 'owner-uuid-1',
    email_verified: true,
    is_suspended: false,
    mfa_enabled: false,
    failed_login_attempts: 0,
    auth_provider: AuthProvider.LOCAL,
    ...overrides,
  } as User;
}

function buildCategory(id = 'cat-uuid-1', name = 'E-Commerce'): Category {
  return { id, name, slug: 'ecommerce', is_active: true } as Category;
}

function buildBusiness(overrides: Partial<Business> = {}): Business {
  return {
    id: 'biz-uuid-1',
    owner_id: 'owner-uuid-1',
    tenant_id: 'owner-uuid-1',
    name: 'SwiftWheels Kenya',
    slug: 'swiftwheels-kenya',
    status: BusinessStatus.ACTIVE,
    verified: true,
    deleted_at: null,
    permanent_deletion_at: null,
    categories: [buildCategory()],
    created_at: new Date('2024-01-01'),
    updated_at: new Date('2024-01-01'),
    ...overrides,
  } as Business;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('BusinessService', () => {
  let service: BusinessService;
  let bizRepo: ReturnType<typeof mockBizRepo>;
  let cardRepo: ReturnType<typeof mockCardRepo>;
  let redirectRepo: ReturnType<typeof mockRedirectRepo>;
  let catRepo: ReturnType<typeof mockCatRepo>;
  let rlsContext: ReturnType<typeof mockRlsContext>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BusinessService,
        { provide: getRepositoryToken(Business), useFactory: mockBizRepo },
        { provide: getRepositoryToken(BusinessCard), useFactory: mockCardRepo },
        { provide: getRepositoryToken(SlugRedirect), useFactory: mockRedirectRepo },
        { provide: getRepositoryToken(Category), useFactory: mockCatRepo },
        { provide: DataSource, useFactory: mockDataSource },
        { provide: RlsContextService, useFactory: mockRlsContext },
        { provide: AuditService, useFactory: mockAuditService },
      ],
    }).compile();

    service = module.get<BusinessService>(BusinessService);
    bizRepo = module.get(getRepositoryToken(Business));
    cardRepo = module.get(getRepositoryToken(BusinessCard));
    redirectRepo = module.get(getRepositoryToken(SlugRedirect));
    catRepo = module.get(getRepositoryToken(Category));
    rlsContext = module.get(RlsContextService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── Create ────────────────────────────────────────────────────────────────

  describe('create()', () => {
    const dto = {
      name: 'SwiftWheels Kenya',
      description: 'Car hire service',
      category_ids: ['cat-uuid-1'],
    };
    const owner = buildOwner();

    it('creates a business with card when under the 5-business cap', async () => {
      bizRepo.count.mockResolvedValue(2); // 2 existing, under cap
      catRepo.findByIds.mockResolvedValue([buildCategory()]);
      bizRepo.findOne.mockResolvedValue(null); // slug unique check
      const newBiz = buildBusiness({ id: 'new-biz-id' });
      bizRepo.create.mockReturnValue(newBiz);
      bizRepo.save.mockResolvedValue(newBiz);
      cardRepo.create.mockReturnValue({ id: 'card-id' });
      cardRepo.save.mockResolvedValue({ id: 'card-id' });

      // findOneForOwner inside create
      bizRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(newBiz);

      const result = await service.create(dto as any, owner);
      expect(bizRepo.save).toHaveBeenCalled();
      expect(cardRepo.save).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('throws ForbiddenException when owner has 5 businesses', async () => {
      bizRepo.count.mockResolvedValue(5);

      await expect(service.create(dto as any, owner)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws BadRequestException when no categories provided', async () => {
      bizRepo.count.mockResolvedValue(0);

      await expect(
        service.create({ ...dto, category_ids: [] } as any, owner),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when more than 3 categories provided', async () => {
      bizRepo.count.mockResolvedValue(0);

      await expect(
        service.create(
          { ...dto, category_ids: ['a', 'b', 'c', 'd'] } as any,
          owner,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when category IDs are invalid', async () => {
      bizRepo.count.mockResolvedValue(0);
      catRepo.findByIds.mockResolvedValue([]); // none found

      await expect(service.create(dto as any, owner)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── Soft Delete ───────────────────────────────────────────────────────────

  describe('softDelete()', () => {
    it('sets deleted_at and permanent_deletion_at 30 days out', async () => {
      const owner = buildOwner();
      const biz = buildBusiness();
      bizRepo.findOne.mockResolvedValue(biz);
      bizRepo.update.mockResolvedValue(undefined);

      const result = await service.softDelete('biz-uuid-1', owner);

      expect(bizRepo.update).toHaveBeenCalledWith(
        'biz-uuid-1',
        expect.objectContaining({
          deleted_at: expect.any(Date),
          permanent_deletion_at: expect.any(Date),
          status: BusinessStatus.SUSPENDED,
        }),
      );
      expect(result.message).toContain('30 days');
    });

    it('throws NotFoundException if business not owned by requester', async () => {
      bizRepo.findOne.mockResolvedValue(null);
      const owner = buildOwner();

      await expect(service.softDelete('nonexistent', owner)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── Restore ───────────────────────────────────────────────────────────────

  describe('restore()', () => {
    it('restores a soft-deleted business within grace period', async () => {
      const owner = buildOwner();
      const futureDate = new Date(Date.now() + 10 * 24 * 3600 * 1000); // 10 days from now
      const deletedBiz = buildBusiness({
        deleted_at: new Date(),
        permanent_deletion_at: futureDate,
      });

      bizRepo.findOne
        .mockResolvedValueOnce(deletedBiz) // find deleted
        .mockResolvedValueOnce({ ...deletedBiz, deleted_at: null }); // findOneForOwner after restore

      bizRepo.update.mockResolvedValue(undefined);

      const result = await service.restore('biz-uuid-1', owner);
      expect(bizRepo.update).toHaveBeenCalledWith(
        'biz-uuid-1',
        expect.objectContaining({ deleted_at: null }),
      );
    });

    it('throws ForbiddenException if grace period has expired', async () => {
      const owner = buildOwner();
      const expiredDate = new Date(Date.now() - 24 * 3600 * 1000); // yesterday
      const deletedBiz = buildBusiness({
        deleted_at: new Date(Date.now() - 31 * 24 * 3600 * 1000),
        permanent_deletion_at: expiredDate,
      });

      bizRepo.findOne.mockResolvedValue(deletedBiz);

      await expect(service.restore('biz-uuid-1', owner)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // ── Approve ───────────────────────────────────────────────────────────────

  describe('approve()', () => {
    it('sets status to ACTIVE and publishes the card', async () => {
      const biz = buildBusiness({ status: BusinessStatus.PENDING, card: { id: 'card-id' } as any });
      bizRepo.findOne.mockResolvedValue(biz);
      bizRepo.update.mockResolvedValue(undefined);
      cardRepo.update.mockResolvedValue(undefined);
      bizRepo.findOneOrFail.mockResolvedValue({ ...biz, status: BusinessStatus.ACTIVE });

      const result = await service.approve('biz-uuid-1', 'admin-id');

      expect(bizRepo.update).toHaveBeenCalledWith(
        'biz-uuid-1',
        expect.objectContaining({ status: BusinessStatus.ACTIVE, verified: true }),
      );
      expect(cardRepo.update).toHaveBeenCalledWith(
        'card-id',
        expect.objectContaining({ is_published: true }),
      );
    });
  });

  // ── Slug resolution ───────────────────────────────────────────────────────

  describe('resolveSlug()', () => {
    it('returns business for valid slug', async () => {
      const biz = buildBusiness();
      bizRepo.findOne.mockResolvedValue(biz);

      const result = await service.resolveSlug('swiftwheels-kenya');
      expect(result).toEqual(biz);
    });

    it('returns redirect object when slug has moved', async () => {
      bizRepo.findOne.mockResolvedValue(null); // not found at old slug
      redirectRepo.findOne.mockResolvedValue({
        old_slug: 'old-slug',
        new_slug: 'new-slug',
      });

      const result = await service.resolveSlug('old-slug');
      expect(result).toHaveProperty('redirect', 'new-slug');
    });

    it('throws NotFoundException when slug not found and no redirect', async () => {
      bizRepo.findOne.mockResolvedValue(null);
      redirectRepo.findOne.mockResolvedValue(null);

      await expect(service.resolveSlug('ghost-slug')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
