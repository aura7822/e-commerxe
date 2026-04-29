import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { configValidationSchema } from './config/config.schema';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './auth/redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { BusinessModule } from './businesses/business.module';
import { MediaModule } from './media/media.module';
import { SearchModule } from './search/search.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AdminModule } from './admin/admin.module';

// Entities for cleanup jobs
import { User } from './users/entities/user.entity';
import { Business } from './businesses/entities/business.entity';
import { AuditLog } from './admin/entities/audit-log.entity';

// Shared services
import { MetricsService } from './common/metrics/metrics.service';
import { MetricsController } from './common/metrics/metrics.controller';
import { CleanupJobsService } from './common/jobs/cleanup.jobs';
import { AuditService } from './admin/admin.service';

@Module({
  imports: [
    // ── Config (must be first) ─────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validationSchema: configValidationSchema,
      validationOptions: { abortEarly: false },
    }),

    // ── Global rate limiter (coarse guard; Nginx handles per-route limits) ──
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        limit: 100,
      },
    ]),

    // ── Task scheduler ─────────────────────────────────────────────
    ScheduleModule.forRoot(),

    // ── Infrastructure ─────────────────────────────────────────────
    DatabaseModule,
    RedisModule,

    // ── Domain modules ─────────────────────────────────────────────
    AuthModule,
    UsersModule,
    BusinessModule,
    MediaModule,
    SearchModule,
    AnalyticsModule,
    AdminModule,

    // ── TypeORM for cleanup jobs (entities not in other modules) ───
    TypeOrmModule.forFeature([User, Business, AuditLog]),
  ],
  providers: [
    MetricsService,
    CleanupJobsService,
    AuditService, // re-exported here for CleanupJobsService
  ],
  controllers: [MetricsController],
})
export class AppModule {}
