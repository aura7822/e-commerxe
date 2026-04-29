import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MediaService } from './media.service';
import { MediaController } from './media.controller';
import { MediaFile } from './entities/media-file.entity';
import { Business } from '../businesses/entities/business.entity';

@Module({
  imports: [TypeOrmModule.forFeature([MediaFile, Business])],
  providers: [MediaService],
  controllers: [MediaController],
  exports: [MediaService],
})
export class MediaModule {}
