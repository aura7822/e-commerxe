import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(private readonly config: ConfigService) {
    this.client = new Redis({
      host: this.config.get<string>('REDIS_HOST'),
      port: this.config.get<number>('REDIS_PORT'),
      password: this.config.get<string>('REDIS_PASSWORD') || undefined,
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 100, 3000),
      enableReadyCheck: true,
    });

    this.client.on('error', (err) => this.logger.error('Redis error', err));
    this.client.on('connect', () => this.logger.log('Redis connected'));
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.setex(key, ttlSeconds, value);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  async expire(key: string, seconds: number): Promise<void> {
    await this.client.expire(key, seconds);
  }

  async rpush(key: string, value: string): Promise<void> {
    await this.client.rpush(key, value);
  }

  async lpop(key: string): Promise<string | null> {
    return this.client.lpop(key);
  }

  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  /** Sliding window rate limit check. Returns remaining hits. */
  async slidingWindowRateLimit(
    key: string,
    maxRequests: number,
    windowSeconds: number,
  ): Promise<{ allowed: boolean; remaining: number; resetIn: number }> {
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;

    const pipeline = this.client.pipeline();
    pipeline.zremrangebyscore(key, '-inf', windowStart);
    pipeline.zadd(key, now, `${now}`);
    pipeline.zcard(key);
    pipeline.expire(key, windowSeconds);

    const results = await pipeline.exec();
    const count = (results?.[2]?.[1] as number) ?? 0;

    return {
      allowed: count <= maxRequests,
      remaining: Math.max(0, maxRequests - count),
      resetIn: windowSeconds,
    };
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}
