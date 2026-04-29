import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'fs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { RedisService } from '../redis/redis.service';

export interface JwtPayload {
  sub: string;       // user ID
  email: string;
  role: string;
  tenant_id: string;
  jti: string;       // JWT ID — used for blacklisting on logout
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtAccessStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly redis: RedisService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      algorithms: ['RS256'],
      secretOrKey: readFileSync(config.get<string>('JWT_PUBLIC_KEY_PATH')!),
      passReqToCallback: false,
    });
  }

  async validate(payload: JwtPayload): Promise<User> {
    // Check token blacklist (logout / revoke)
    const blacklisted = await this.redis.get(`blacklist:${payload.jti}`);
    if (blacklisted) {
      throw new UnauthorizedException('Token has been revoked');
    }

    const user = await this.userRepo.findOne({
      where: { id: payload.sub },
      select: [
        'id', 'email', 'role', 'tenant_id',
        'is_suspended', 'email_verified', 'mfa_enabled',
      ],
    });

    if (!user) throw new UnauthorizedException('User not found');
    if (user.is_suspended) throw new UnauthorizedException('Account suspended');
    if (!user.email_verified) throw new UnauthorizedException('Email not verified');

    return user;
  }
}
