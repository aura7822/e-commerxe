import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { IsOptional, IsString, IsBoolean, IsInt, Min, Max } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

import { SearchService, SearchResult } from './search.service';

class SearchQueryDto {
  @ApiProperty({ required: false, example: 'car rental nairobi' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiProperty({ required: false, example: 'car-rental' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(({ value }: { value: string }) => value === 'true')
  @IsBoolean()
  verified?: boolean;

  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  page?: number;

  @ApiProperty({ required: false, default: 20, maximum: 100 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

@ApiTags('Search')
@Controller('api/v1/search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  /**
   * GET /api/v1/search?q=...&category=...&verified=true&page=1&limit=20
   * No authentication required.
   */
  @Get()
  @ApiOperation({
    summary: 'Search businesses (no auth required)',
    description:
      'Full-text search with faceted filters. Uses PostgreSQL GIN index for p95 < 300ms.',
  })
  search(@Query() query: SearchQueryDto): Promise<SearchResult> {
    return this.searchService.search(query);
  }
}
