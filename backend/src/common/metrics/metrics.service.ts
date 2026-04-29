import { Injectable, OnModuleInit } from '@nestjs/common';
import * as promClient from 'prom-client';

@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly registry: promClient.Registry;

  // ─── HTTP metrics ────────────────────────────────────────────────────────
  readonly httpRequestDuration: promClient.Histogram<string>;
  readonly httpRequestTotal: promClient.Counter<string>;

  // ─── Business metrics ─────────────────────────────────────────────────────
  readonly businessCreatedTotal: promClient.Counter<string>;
  readonly activeListingsGauge: promClient.Gauge<string>;

  // ─── Auth metrics ────────────────────────────────────────────────────────
  readonly loginTotal: promClient.Counter<string>;
  readonly loginFailureTotal: promClient.Counter<string>;
  readonly accountLockoutTotal: promClient.Counter<string>;

  // ─── Upload metrics ──────────────────────────────────────────────────────
  readonly mediaUploadDuration: promClient.Histogram<string>;

  constructor() {
    this.registry = new promClient.Registry();
    promClient.collectDefaultMetrics({ register: this.registry });

    this.httpRequestDuration = new promClient.Histogram({
      name: 'ecommerxe_http_request_duration_seconds',
      help: 'HTTP request latency in seconds',
      labelNames: ['method', 'route', 'status_code', 'tenant_id'],
      buckets: [0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5],
      registers: [this.registry],
    });

    this.httpRequestTotal = new promClient.Counter({
      name: 'ecommerxe_http_requests_total',
      help: 'Total HTTP request count',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.registry],
    });

    this.businessCreatedTotal = new promClient.Counter({
      name: 'ecommerxe_businesses_created_total',
      help: 'Total businesses created',
      labelNames: ['category'],
      registers: [this.registry],
    });

    this.activeListingsGauge = new promClient.Gauge({
      name: 'ecommerxe_active_listings',
      help: 'Number of currently active business listings',
      registers: [this.registry],
    });

    this.loginTotal = new promClient.Counter({
      name: 'ecommerxe_logins_total',
      help: 'Total successful login attempts',
      labelNames: ['provider'],
      registers: [this.registry],
    });

    this.loginFailureTotal = new promClient.Counter({
      name: 'ecommerxe_login_failures_total',
      help: 'Total failed login attempts',
      registers: [this.registry],
    });

    this.accountLockoutTotal = new promClient.Counter({
      name: 'ecommerxe_account_lockouts_total',
      help: 'Total account lockouts triggered',
      registers: [this.registry],
    });

    this.mediaUploadDuration = new promClient.Histogram({
      name: 'ecommerxe_media_upload_duration_seconds',
      help: 'Media upload and processing duration',
      buckets: [0.5, 1, 2, 3, 5, 10, 20],
      registers: [this.registry],
    });
  }

  onModuleInit(): void {
    // Registry is ready — metrics endpoint served by MetricsController
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  getContentType(): string {
    return this.registry.contentType;
  }
}
