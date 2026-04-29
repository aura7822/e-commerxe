import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { IsString, IsEnum, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Request } from 'express';

import { AnalyticsService, DashboardStats } from './analytics.service';
import { EventType } from './entities/analytics-event.entity';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User, UserRole } from '../users/entities/user.entity';
import { hashIp } from '../common/utils/ip.util';

class TrackEventDto {
  @ApiProperty({ example: 'uuid-of-business' })
  @IsString()
  business_id: string;

  @ApiProperty({ enum: EventType })
  @IsEnum(EventType)
  event_type: EventType;

  @ApiProperty({ description: 'Opaque session hash (generated client-side)' })
  @IsString()
  @MaxLength(64)
  session_id: string;

  @ApiProperty({ required: false, example: 'https://google.com' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  referrer?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  cta_label?: string;
}

@ApiTags('Analytics')
@Controller('api/v1/analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  /**
   * POST /api/v1/analytics/events
   * Public endpoint — signed payload from frontend.
   * Tenant is resolved from the business's owner, not from JWT.
   */
  @Post('events')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Track a view, click, or CTA event (no auth required)' })
  async track(
    @Body() dto: TrackEventDto,
    @Req() req: Request,
  ): Promise<{ ok: boolean }> {
    const ip = req.ip ?? '0.0.0.0';
    // Tenant resolved by AnalyticsService using business_id lookup
    await this.analyticsService.track(dto, ip, 'public');
    return { ok: true };
  }

  /**
   * GET /api/v1/analytics/dashboard?business_id=...&days=30
   * Owner-authenticated. RLS enforced by tenant_id match.
   */
  @Get('dashboard')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.BUSINESS_OWNER, UserRole.SUDO_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get analytics dashboard for a business (7/30/90 days)' })
  @ApiQuery({ name: 'business_id', required: true })
  @ApiQuery({ name: 'days', required: false, enum: [7, 30, 90] })
  async getDashboard(
    @Query('business_id') businessId: string,
    @Query('days') daysStr = '30',
    @CurrentUser() user: User,
  ): Promise<DashboardStats> {
    const days = parseInt(daysStr, 10);
    if (![7, 30, 90].includes(days)) {
      throw new BadRequestException('days must be 7, 30, or 90');
    }
    return this.analyticsService.getDashboard(businessId, user, days as 7 | 30 | 90);
  }
}
