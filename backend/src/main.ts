import { NestFactory, Reflector } from '@nestjs/core';
import { ValidationPipe, ClassSerializerInterceptor } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import * as helmet from 'helmet';
import * as cookieParser from 'cookie-parser';

import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Use Winston logger in production
    logger:
      process.env.NODE_ENV === 'production'
        ? ['error', 'warn', 'log']
        : ['error', 'warn', 'log', 'verbose', 'debug'],
  });

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT') ?? 3000;
  const frontendUrl = config.get<string>('FRONTEND_URL')!;

  // ── Security headers (OWASP SRS §8) ─────────────────────────────
  app.use(
    (helmet as unknown as typeof helmet.default)({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", 'https:', 'data:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameSrc: ["'none'"],
          upgradeInsecureRequests: [],
        },
      },
      hsts: {
        maxAge: 63_072_000, // 2 years
        includeSubDomains: true,
        preload: true,
      },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      permittedCrossDomainPolicies: false,
      crossOriginEmbedderPolicy: false, // allow CDN images
    }),
  );

  // ── Cookie parser (for HTTP-only refresh token) ──────────────────
  app.use(cookieParser());

  // ── CORS — restrict to known frontend origin ─────────────────────
  app.enableCors({
    origin: [frontendUrl],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    credentials: true, // needed for HTTP-only cookie
    maxAge: 86_400,
  });

  // ── Global validation pipe ───────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,           // strip unknown properties
      forbidNonWhitelisted: true, // throw on unknown properties
      transform: true,           // auto-transform payloads to DTO instances
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // ── Global filters ───────────────────────────────────────────────
  app.useGlobalFilters(new GlobalExceptionFilter());

  // ── Global interceptors ──────────────────────────────────────────
  const reflector = app.get(Reflector);
  app.useGlobalInterceptors(
    new LoggingInterceptor(),
    new ClassSerializerInterceptor(reflector), // respects @Exclude()
    new TransformInterceptor(),
  );

  // ── Trust proxy (Nginx sits in front) ───────────────────────────
  const expressApp = app.getHttpAdapter().getInstance() as {
    set: (key: string, value: unknown) => void;
  };
  expressApp.set('trust proxy', 1);

  // ── Swagger / OpenAPI (non-production only) ──────────────────────
  if (config.get('NODE_ENV') !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('E-CommerXE API')
      .setDescription(
        'Multi-tenant digital business advertising platform — SRS v1.0',
      )
      .setVersion('1.0')
      .addBearerAuth()
      .addCookieAuth('refresh_token')
      .addTag('Authentication')
      .addTag('Users')
      .addTag('Businesses')
      .addTag('Public Cards')
      .addTag('Search')
      .addTag('Media')
      .addTag('Analytics')
      .addTag('Admin')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
        tagsSorter: 'alpha',
      },
    });

    console.log(`📚 Swagger docs: http://localhost:${port}/api/docs`);
  }

  await app.listen(port, '0.0.0.0');
  console.log(`🚀 E-CommerXE API running on port ${port} [${config.get('NODE_ENV')}]`);
}

bootstrap().catch((err) => {
  console.error('Failed to start application', err);
  process.exit(1);
});
