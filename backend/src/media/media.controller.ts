import {
  Controller,
  Post,
  Delete,
  Get,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Body,
  HttpCode,
  HttpStatus,
  BadRequestException,
  ParseUUIDPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiConsumes,
  ApiBody,
  ApiParam,
} from '@nestjs/swagger';
import { IsString, IsEnum, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { memoryStorage } from 'multer';

import { MediaService } from './media.service';
import { MediaFile, MediaFileType } from './entities/media-file.entity';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User, UserRole } from '../users/entities/user.entity';

class UploadMediaDto {
  @ApiProperty({ enum: MediaFileType })
  @IsEnum(MediaFileType)
  file_type: MediaFileType;

  @ApiProperty({ description: 'UUID of the target business' })
  @IsString()
  @IsNotEmpty()
  business_id: string;
}

@ApiTags('Media')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.BUSINESS_OWNER, UserRole.SUDO_ADMIN)
@Controller('api/v1/media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  /**
   * POST /api/v1/media/upload
   * Multer stores file in memory — passed to Sharp for processing.
   * Max: 10MB, allowed types: JPG/PNG/WebP/AVIF.
   * Rate limit: 10 uploads/min per user (enforced in MediaService).
   */
  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB hard limit at Multer layer
      fileFilter: (_req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
        if (!allowed.includes(file.mimetype)) {
          cb(new BadRequestException('File type not allowed'), false);
        } else {
          cb(null, true);
        }
      },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        business_id: { type: 'string' },
        file_type: { type: 'string', enum: Object.values(MediaFileType) },
      },
    },
  })
  @ApiOperation({ summary: 'Upload media file (auto-resized, EXIF stripped, scanned)' })
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadMediaDto,
    @CurrentUser() user: User,
  ): Promise<MediaFile> {
    if (!file) throw new BadRequestException('No file provided');
    return this.mediaService.upload(file, dto.business_id, dto.file_type, user);
  }

  /**
   * GET /api/v1/media/presign?business_id=...&filename=...
   * Returns a 15-min presigned R2 URL for direct browser uploads.
   */
  @Get('presign')
  @ApiOperation({ summary: 'Get a presigned R2 upload URL (15 min expiry)' })
  getPresignedUrl(
    @Query('business_id') businessId: string,
    @Query('filename') filename: string,
    @CurrentUser() user: User,
  ): Promise<{ url: string; key: string; expires_in: number }> {
    if (!businessId || !filename) {
      throw new BadRequestException('business_id and filename are required');
    }
    return this.mediaService.getPresignedUploadUrl(businessId, filename, user);
  }

  /**
   * DELETE /api/v1/media/:id
   * Deletes all size variants from R2 and removes the DB record.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a media file and all its variants from storage' })
  @ApiParam({ name: 'id', description: 'MediaFile UUID' })
  delete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ): Promise<void> {
    return this.mediaService.delete(id, user);
  }
}
