import { Controller, Get, HttpCode, Inject } from '@nestjs/common';
import type { Db } from '@hub/db';
import type { ReadyResponse } from '@hub/contracts';
import { Public } from '../../common/decorators.js';
import { DB } from '../../db.provider.js';

@Controller()
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Public()
  @Get('healthz')
  healthz() {
    return { status: 'ok' as const };
  }

  @Public()
  @Get('readyz')
  @HttpCode(200)
  async readyz(): Promise<ReadyResponse> {
    try {
      await this.db.ping();
      return { status: 'ready', checks: { database: 'ok' } };
    } catch {
      return { status: 'degraded', checks: { database: 'fail' } };
    }
  }
}
