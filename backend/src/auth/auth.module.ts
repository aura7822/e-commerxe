import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { readFileSync } from 'fs';

import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAccessStrategy } from './strategies/jwt.strategy';
import { GoogleStrategy } from './strategies/google.strategy';
import { User } from '../users/entities/user.entity';
import { EmailService } from './email/email.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // RS256 public key for verification in strategy
        publicKey: readFileSync(config.get<string>('JWT_PUBLIC_KEY_PATH')!, 'utf-8'),
        signOptions: { algorithm: 'RS256' },
      }),
    }),
  ],
  providers: [AuthService, JwtAccessStrategy, GoogleStrategy, EmailService],
  controllers: [AuthController],
  exports: [AuthService, EmailService],
})
export class AuthModule {}
