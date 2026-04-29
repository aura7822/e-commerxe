import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AdminService, AuditService } from './admin.service';
import { AdminController } from './admin.controller';
import { AuditLog } from './entities/audit-log.entity';
import { User } from '../users/entities/user.entity';
import { Business } from '../businesses/entities/business.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AuditLog, User, Business])],
  providers: [AdminService, AuditService],
  controllers: [AdminController],
  exports: [AuditService, AdminService],
})
export class AdminModule {}
