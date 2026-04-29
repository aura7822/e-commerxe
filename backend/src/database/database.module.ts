import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { join } from 'path';

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('DB_HOST'),
        port: config.get<number>('DB_PORT'),
        username: config.get<string>('DB_USER'),
        password: config.get<string>('DB_PASSWORD'),
        database: config.get<string>('DB_NAME'),
        ssl:
          config.get<string>('DB_SSL') === 'true'
            ? { rejectUnauthorized: false }
            : false,
        entities: [join(__dirname, '../**/*.entity.{ts,js}')],
        migrations: [join(__dirname, './migrations/*.{ts,js}')],
        migrationsRun: false, // run manually via CLI
        synchronize: false,   // always use migrations in production
        logging: config.get('NODE_ENV') === 'development',
        /**
         * Connection pool — sized for multi-tenant concurrent load.
         * Each request sets app.current_tenant via SET LOCAL within transaction.
         */
        extra: {
          max: 20,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
        },
      }),
    }),
  ],
})
export class DatabaseModule {}
