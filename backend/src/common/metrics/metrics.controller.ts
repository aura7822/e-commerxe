import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiOperation, ApiExcludeEndpoint } from '@nestjs/swagger';
import { MetricsService } from './metrics.service';

/**
 * Prometheus metrics endpoint.
 * In production, this should be restricted to internal network access only
 * (e.g. via Nginx allow/deny rules — not exposed to the public internet).
 */
@ApiTags('Observability')
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get()
  @ApiExcludeEndpoint() // hide from Swagger docs
  @ApiOperation({ summary: 'Prometheus metrics scrape endpoint' })
  async getMetrics(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', this.metricsService.getContentType());
    const metrics = await this.metricsService.getMetrics();
    res.end(metrics);
  }
}
