import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * RlsContextService
 *
 * Sets the PostgreSQL session variable `app.current_tenant` so that
 * Row-Level Security policies enforce tenant isolation automatically.
 *
 * Usage:
 *   await this.rlsContext.run(tenantId, () => repo.find(...));
 *
 * For sudo_admin bypassing RLS:
 *   await this.rlsContext.runAsAdmin(() => repo.find(...));
 */
@Injectable()
export class RlsContextService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Runs a callback inside a transaction with tenant context set.
   * All queries inside the callback will have RLS applied for tenantId.
   */
  async run<T>(tenantId: string, callback: () => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      // SET LOCAL scopes the variable to this transaction only
      await manager.query(`SET LOCAL app.current_tenant = '${tenantId}'`);
      await manager.query(`SET LOCAL app.bypass_rls = 'false'`);
      return callback();
    });
  }

  /**
   * Runs a callback with RLS bypassed (sudo_admin only).
   * Must be gated by RBAC guard before calling.
   */
  async runAsAdmin<T>(callback: () => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL app.bypass_rls = 'true'`);
      return callback();
    });
  }

  /**
   * Sets tenant context on a raw QueryRunner (for complex queries).
   */
  async setTenantContext(
    queryRunner: import('typeorm').QueryRunner,
    tenantId: string,
  ): Promise<void> {
    await queryRunner.query(`SET LOCAL app.current_tenant = '${tenantId}'`);
    await queryRunner.query(`SET LOCAL app.bypass_rls = 'false'`);
  }
}
