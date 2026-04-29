import {
  Controller,
  Get,
  Put,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
} from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

import { AdminService, AuditService } from './admin.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User, UserRole } from '../users/entities/user.entity';
import { AuditAction } from './entities/audit-log.entity';

class ChangeRoleDto {
  @ApiProperty({ enum: UserRole })
  @IsEnum(UserRole)
  role: UserRole;
}

class AuditQueryDto {
  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  page?: number = 1;

  @ApiProperty({ required: false, default: 50 })
  @IsOptional()
  limit?: number = 50;

  @ApiProperty({ required: false, enum: AuditAction })
  @IsOptional()
  @IsEnum(AuditAction)
  action?: AuditAction;
}

const ADMIN_GUARD = [JwtAuthGuard, RolesGuard];
const ADMIN_ROLE = [UserRole.SUDO_ADMIN];

@ApiTags('Admin')
@ApiBearerAuth()
@UseGuards(...ADMIN_GUARD)
@Roles(...ADMIN_ROLE)
@Controller('api/v1/admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly auditService: AuditService,
  ) {}

  // ─── Dashboard metrics ───────────────────────────────────────────────────

  @Get('metrics')
  @ApiOperation({ summary: '[Admin] System health & KPI metrics' })
  getMetrics() {
    return this.adminService.getSystemMetrics();
  }

  // ─── Users ───────────────────────────────────────────────────────────────

  @Get('users')
  @ApiOperation({ summary: '[Admin] List all users' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'search', required: false })
  listUsers(
    @Query('page') page = 1,
    @Query('limit') limit = 50,
    @Query('search') search?: string,
  ) {
    return this.adminService.listUsers(+page, +limit, search);
  }

  @Put('users/:id/suspend')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '[Admin] Suspend a user account' })
  suspendUser(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() admin: User,
  ): Promise<void> {
    return this.adminService.suspendUser(id, admin.id);
  }

  @Put('users/:id/activate')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '[Admin] Reactivate a suspended user' })
  activateUser(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() admin: User,
  ): Promise<void> {
    return this.adminService.activateUser(id, admin.id);
  }

  @Put('users/:id/role')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '[Admin] Change a user role' })
  changeRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeRoleDto,
    @CurrentUser() admin: User,
  ): Promise<void> {
    return this.adminService.changeRole(id, dto.role, admin.id);
  }

  @Delete('users/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '[Admin] Schedule user account deletion (30-day grace)' })
  deleteUser(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() admin: User,
  ): Promise<void> {
    return this.adminService.deleteUserAccount(id, admin.id);
  }

  // ─── Businesses ──────────────────────────────────────────────────────────

  @Get('businesses/pending')
  @ApiOperation({ summary: '[Admin] List businesses awaiting approval' })
  listPending(@Query('page') page = 1, @Query('limit') limit = 50) {
    return this.adminService.listPendingBusinesses(+page, +limit);
  }

  @Get('businesses')
  @ApiOperation({ summary: '[Admin] List all businesses' })
  listAll(@Query('page') page = 1, @Query('limit') limit = 50) {
    return this.adminService.listAllBusinesses(+page, +limit);
  }

  // ─── Audit Logs ──────────────────────────────────────────────────────────

  @Get('audit-logs')
  @ApiOperation({ summary: '[Admin] View append-only audit logs' })
  getAuditLogs(@Query() query: AuditQueryDto) {
    return this.auditService.findAll(query.page, query.limit, query.action);
  }
}
