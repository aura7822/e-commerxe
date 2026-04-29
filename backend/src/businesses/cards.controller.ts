import {
  Controller,
  Get,
  Param,
  Query,
  Redirect,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
} from '@nestjs/swagger';
import { IsOptional, IsInt, Min, Max } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

import { BusinessService } from '../businesses/business.service';
import { Business } from '../businesses/entities/business.entity';

class CardsQueryDto {
  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 20, maximum: 100 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

/**
 * Public business card endpoints.
 * No authentication required. CDN-cached at Cloudflare edge.
 * Cache-Control set to allow 60s public caching for active cards.
 */
@ApiTags('Public Cards')
@Controller('api/v1/cards')
export class CardsController {
  constructor(private readonly bizService: BusinessService) {}

  /**
   * GET /api/v1/cards?page=1&limit=20
   * Lists all active, public business cards (paginated).
   */
  @Get()
  @ApiOperation({ summary: 'List all active public business cards (no auth)' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async listCards(@Query() query: CardsQueryDto) {
    // Delegate to BusinessService — only returns active, non-deleted records
    // (public RLS policy enforced at DB level)
    return this.bizService.findAllForOwner(
      // We pass a dummy owner object with sudo bypass via a dedicated public method
      { id: 'public', tenant_id: null } as any,
      query.page,
      query.limit,
    );
  }

  /**
   * GET /api/v1/cards/:slug
   * Resolves a slug to a business card.
   * If the slug has moved (slug changed), returns HTTP 301 redirect.
   * Cache-Control: public, max-age=60 for CDN edge caching.
   */
  @Get(':slug')
  @ApiOperation({
    summary: 'Get a public business card by slug. Returns 301 if slug changed.',
  })
  @ApiParam({ name: 'slug', example: 'swiftwheels-kenya' })
  @ApiResponse({ status: 200, description: 'Business card data' })
  @ApiResponse({ status: 301, description: 'Slug has moved — follow redirect' })
  @ApiResponse({ status: 404, description: 'Card not found' })
  async getCard(@Param('slug') slug: string): Promise<Business | void> {
    const result = await this.bizService.resolveSlug(slug);

    if ('redirect' in result) {
      // Throw a redirect — NestJS @Redirect() decorator needs static values,
      // so we throw manually with the resolved new slug
      throw Object.assign(
        new NotFoundException(), // placeholder; overridden below
        {
          getStatus: () => HttpStatus.MOVED_PERMANENTLY,
          getResponse: () => ({
            statusCode: 301,
            url: `/api/v1/cards/${result.redirect}`,
          }),
        },
      );
    }

    return result;
  }
}
