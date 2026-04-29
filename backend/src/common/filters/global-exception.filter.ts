import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';

interface ErrorResponse {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
  requestId?: string;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';
    let error = 'Internal Server Error';

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        const resObj = res as { message?: string | string[]; error?: string };
        message = resObj.message ?? message;
        error = resObj.error ?? exception.name;
      }
    } else if (exception instanceof QueryFailedError) {
      // PostgreSQL unique violation
      const pgError = exception as QueryFailedError & { code?: string };
      if (pgError.code === '23505') {
        statusCode = HttpStatus.CONFLICT;
        message = 'A record with this value already exists';
        error = 'Conflict';
      } else if (pgError.code === '23503') {
        statusCode = HttpStatus.BAD_REQUEST;
        message = 'Referenced record does not exist';
        error = 'Bad Request';
      } else {
        this.logger.error('Database query failed', exception);
      }
    } else {
      this.logger.error('Unhandled exception', exception as Error);
    }

    const body: ErrorResponse = {
      statusCode,
      error,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    // Never expose stack traces in production
    if (process.env.NODE_ENV !== 'production' && exception instanceof Error) {
      (body as ErrorResponse & { stack?: string }).stack = exception.stack;
    }

    response.status(statusCode).json(body);
  }
}
