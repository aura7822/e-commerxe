import { DataSource } from 'typeorm';
import { config } from 'dotenv';
import { join } from 'path';

config(); // load .env for CLI usage

export default new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  entities: [join(__dirname, '../**/*.entity.{ts,js}')],
  migrations: [join(__dirname, './migrations/*.{ts,js}')],
  migrationsTableName: 'typeorm_migrations',
  logging: process.env.NODE_ENV === 'development',
});
