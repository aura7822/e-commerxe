import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { Request } from 'express';

export interface ApiEnvelope<T> {
  success: true;
  data: T;
  meta?: {
    requestId?: string;
    timestamp: string;
  };
}

@Injectable()
export class TransformInterceptor<T>
  implements NestInterceptor<T, ApiEnvelope<T>>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiEnvelope<T>> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { requestId?: string }>();

    return next.handle().pipe(
      map((data) => ({
        success: true as const,
        data,
        meta: {
          requestId: req.requestId,
          timestamp: new Date().toISOString(),
        },
      })),
    );
  }
}
