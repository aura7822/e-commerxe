// ─── jwt-auth.guard.ts ───────────────────────────────────────────────────────
import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<T>(err: Error, user: T, info: Error): T {
    if (info instanceof TokenExpiredError) {
      throw new UnauthorizedException('Access token has expired — please refresh');
    }
    if (info instanceof JsonWebTokenError) {
      throw new UnauthorizedException('Invalid access token');
    }
    if (err || !user) {
      throw err ?? new UnauthorizedException('Authentication required');
    }
    return user;
  }

  getRequest(context: ExecutionContext) {
    return context.switchToHttp().getRequest();
  }
}
