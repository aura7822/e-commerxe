import {
  Controller,
  Get,
  Put,
  Delete,
  Post,
  Body,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { Response } from 'express';

import { UsersService, UpdateProfileDto } from './users.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from './entities/user.entity';

@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/v1/user')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // ─── Profile ─────────────────────────────────────────────────────────────

  @Get('profile')
  @ApiOperation({ summary: 'Get own profile' })
  getProfile(@CurrentUser() user: User): Promise<User> {
    return this.usersService.getProfile(user.id);
  }

  @Put('profile')
  @ApiOperation({ summary: 'Update display name and avatar' })
  updateProfile(
    @CurrentUser() user: User,
    @Body() dto: UpdateProfileDto,
  ): Promise<User> {
    return this.usersService.updateProfile(user.id, dto);
  }

  // ─── GDPR Export ─────────────────────────────────────────────────────────

  @Get('export')
  @ApiOperation({
    summary: 'GDPR data export — download all personal data as JSON',
  })
  @ApiResponse({ status: 200, description: 'JSON file download' })
  async exportData(
    @CurrentUser() user: User,
    @Res() res: Response,
  ): Promise<void> {
    const data = await this.usersService.exportData(user.id);
    const filename = `ecommerxe-data-export-${user.id}-${Date.now()}.json`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(JSON.stringify(data, null, 2));
  }

  // ─── Account Deletion ────────────────────────────────────────────────────

  @Delete('account')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request account deletion (30-day GDPR grace period)',
  })
  requestDeletion(
    @CurrentUser() user: User,
  ): Promise<{ message: string; scheduled_at: Date }> {
    return this.usersService.requestDeletion(user.id);
  }

  @Post('account/cancel-deletion')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a pending account deletion' })
  cancelDeletion(@CurrentUser() user: User): Promise<{ message: string }> {
    return this.usersService.cancelDeletion(user.id);
  }
}
