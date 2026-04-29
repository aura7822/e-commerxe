import * as Joi from 'joi';

export const configValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().default(3000),
  APP_URL: Joi.string().uri().required(),
  FRONTEND_URL: Joi.string().uri().required(),

  // Database
  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().default(5432),
  DB_NAME: Joi.string().required(),
  DB_USER: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_SSL: Joi.boolean().default(false),

  // Redis
  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').optional(),
  REDIS_TTL: Joi.number().default(1800),

  // JWT
  JWT_PRIVATE_KEY_PATH: Joi.string().required(),
  JWT_PUBLIC_KEY_PATH: Joi.string().required(),
  JWT_ACCESS_TTL: Joi.number().default(900),
  JWT_REFRESH_TTL: Joi.number().default(604800),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),

  // Google OAuth
  GOOGLE_CLIENT_ID: Joi.string().required(),
  GOOGLE_CLIENT_SECRET: Joi.string().required(),
  GOOGLE_CALLBACK_URL: Joi.string().uri().required(),

  // R2 / S3
  R2_ACCOUNT_ID: Joi.string().required(),
  R2_ACCESS_KEY_ID: Joi.string().required(),
  R2_SECRET_ACCESS_KEY: Joi.string().required(),
  R2_BUCKET_NAME: Joi.string().required(),
  R2_PUBLIC_URL: Joi.string().uri().required(),
  CDN_URL: Joi.string().uri().required(),

  // Email
  SMTP_HOST: Joi.string().required(),
  SMTP_PORT: Joi.number().default(587),
  SMTP_USER: Joi.string().required(),
  SMTP_PASS: Joi.string().required(),
  SMTP_FROM: Joi.string().email().required(),

  // Sentry
  SENTRY_DSN: Joi.string().uri().optional(),

  // Cloudflare Turnstile
  TURNSTILE_SECRET_KEY: Joi.string().required(),

  // Encryption
  ENCRYPTION_KEY: Joi.string().length(32).required(),

  // Throttle
  THROTTLE_TTL: Joi.number().default(60),
  THROTTLE_LIMIT: Joi.number().default(100),
});
