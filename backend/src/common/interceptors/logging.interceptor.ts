import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx = context.switchToHttp();
    const req = ctx.getRequest<Request & { requestId?: string }>();
    const res = ctx.getResponse<Response>();

    const requestId = uuidv4();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    const { method, url, ip } = req;
    const userAgent = req.headers['user-agent'] ?? '';
    const start = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const ms = Date.now() - start;
          const statusCode = res.statusCode;
          this.logger.log(
            `${method} ${url} ${statusCode} ${ms}ms — ${ip} "${userAgent}" [${requestId}]`,
          );
        },
        error: (err: Error) => {
          const ms = Date.now() - start;
          this.logger.error(
            `${method} ${url} ERROR ${ms}ms — ${ip} [${requestId}] ${err.message}`,
          );
        },
      }),
    );
  }
}
