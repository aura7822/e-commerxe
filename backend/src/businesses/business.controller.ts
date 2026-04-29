import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  Redirect,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';

import { BusinessService } from './business.service';
import { CreateBusinessDto, UpdateBusinessDto, BusinessQueryDto, FlagBusinessDto } from './dto/create-business.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User, UserRole } from '../users/entities/user.entity';
import { Business } from './entities/business.entity';

@ApiTags('Businesses')
@Controller('api/v1/businesses')
export class BusinessController {
  constructor(private readonly bizService: BusinessService) {}

  // ─── Owner: Create ───────────────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.BUSINESS_OWNER, UserRole.SUDO_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new business listing (max 5 per account)' })
  @ApiResponse({ status: 201, description: 'Business created, pending admin approval' })
  create(
    @Body() dto: CreateBusinessDto,
    @CurrentUser() user: User,
  ): Promise<Business> {
    return this.bizService.create(dto, user);
  }

  // ─── Owner: List own businesses ──────────────────────────────────────────

  @Get('mine')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.BUSINESS_OWNER, UserRole.SUDO_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List the authenticated owner's businesses" })
  findMine(
    @CurrentUser() user: User,
    @Query() query: BusinessQueryDto,
  ) {
    return this.bizService.findAllForOwner(user, query.page, query.limit);
  }

  // ─── Owner: Get one ──────────────────────────────────────────────────────

  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.BUSINESS_OWNER, UserRole.SUDO_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get full business detail (owner only)' })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ): Promise<Business> {
    if (user.role === UserRole.SUDO_ADMIN) {
      return this.bizService.findPublicById(id); // admin sees all
    }
    return this.bizService.findOneForOwner(id, user);
  }

  // ─── Owner: Update ───────────────────────────────────────────────────────

  @Put(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.BUSINESS_OWNER, UserRole.SUDO_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update business (owner). Slug changes → 301 stored.' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBusinessDto,
    @CurrentUser() user: User,
  ): Promise<Business> {
    return this.bizService.update(id, dto, user);
  }

  // ─── Owner: Soft Delete ──────────────────────────────────────────────────

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.BUSINESS_OWNER, UserRole.SUDO_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Soft-delete business. 30-day recovery grace.' })
  softDelete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ): Promise<{ message: string }> {
    return this.bizService.softDelete(id, user);
  }

  // ─── Owner: Restore ──────────────────────────────────────────────────────

  @Patch(':id/restore')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.BUSINESS_OWNER, UserRole.SUDO_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Restore a soft-deleted business within 30-day window' })
  restore(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ): Promise<Business> {
    return this.bizService.restore(id, user);
  }

  // ─── Admin: Approve ──────────────────────────────────────────────────────

  @Patch(':id/approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUDO_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Approve a business listing' })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() admin: User,
  ): Promise<Business> {
    return this.bizService.approve(id, admin.id);
  }

  // ─── Admin: Flag ─────────────────────────────────────────────────────────

  @Patch(':id/flag')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUDO_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Flag a business listing' })
  flag(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FlagBusinessDto,
    @CurrentUser() admin: User,
  ): Promise<void> {
    return this.bizService.flag(id, admin.id, dto.reason);
  }
}
