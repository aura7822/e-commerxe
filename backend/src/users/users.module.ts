import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { User } from './entities/user.entity';
import { Business } from '../businesses/entities/business.entity';
import { MediaFile } from '../media/entities/media-file.entity';

@Module({
  imports: [TypeOrmModule.forFeature([User, Business, MediaFile])],
  providers: [UsersService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
