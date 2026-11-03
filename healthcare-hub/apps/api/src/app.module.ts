import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import type { JWTVerifyGetKey } from 'jose';
import type { Logger } from 'pino';
import type { Db } from '@hub/db';
import { CONFIG, type AppConfig } from './config.js';
import { DB } from './db.provider.js';
import { LOGGER } from './logger.provider.js';
import { HubGuard } from './auth/hub.guard.js';
import { PermissionGuard } from './auth/permission.guard.js';
import { KEY_RESOLVER, TokenService } from './auth/token.service.js';
import { AuditInterceptor } from './common/audit.interceptor.js';
import { ProblemFilter } from './common/problem.filter.js';
import { AuditController } from './modules/audit/audit.controller.js';
import { HealthController } from './modules/health/health.controller.js';
import { AdminController } from './modules/admin/admin.controller.js';
import { OrgController } from './modules/org/org.controller.js';
import { UserCache } from './auth/user-cache.js';
import { MeController } from './modules/identity/me.controller.js';
import { OpenApiController } from './modules/openapi.controller.js';
import { RequirementsController } from './modules/requirements/requirements.controller.js';
import { EvidenceController } from './modules/evidence/evidence.controller.js';
import { AlertsController } from './modules/alerts/alerts.controller.js';
import { StaffController } from './modules/staff/staff.controller.js';
import { EquipmentController, VehiclesController } from './modules/fleet/vehicles.controller.js';
import { InspectionsController } from './modules/fleet/inspections.controller.js';
import { DefectsController, ExpensesController } from './modules/fleet/defects.controller.js';
import { AuditsController } from './modules/governance/audits.controller.js';
import { PoliciesController } from './modules/governance/policies.controller.js';
import { EventsController } from './modules/governance/events.controller.js';
import { DashboardController } from './modules/governance/dashboard.controller.js';
import { ReportsController } from './modules/reports/reports.controller.js';
import { ImportsController } from './modules/data/imports.controller.js';
import { PrivacyController } from './modules/privacy/privacy.controller.js';
import { JobsController, ShiftsController } from './modules/dispatch/jobs.controller.js';
import { CrewController } from './modules/crew/crew.controller.js';
import { LiveController } from './modules/live/live.controller.js';
import { LiveChanges } from './modules/live/live.service.js';
import { BLOB_STORE, LocalBlobStore, type BlobStore } from './storage/blob-store.js';
import { BasicScanner, SCANNER, type Scanner } from './storage/scanner.js';

/** Every controller registered in the app; the isolation test suite is generated from this list. */
export const CONTROLLERS = [
  HealthController,
  OpenApiController,
  MeController,
  AuditController,
  OrgController,
  AdminController,
  RequirementsController,
  EvidenceController,
  AlertsController,
  StaffController,
  VehiclesController,
  EquipmentController,
  InspectionsController,
  DefectsController,
  ExpensesController,
  AuditsController,
  PoliciesController,
  EventsController,
  DashboardController,
  ReportsController,
  ImportsController,
  PrivacyController,
  JobsController,
  ShiftsController,
  CrewController,
  LiveController,
] as const;

export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  db: Db;
  keyResolver: JWTVerifyGetKey;
  /** Evidence storage and scanning (defaults: local filesystem + basic scanner). */
  blobStore?: BlobStore;
  scanner?: Scanner;
  /** Extra controllers (tests only). */
  extraControllers?: (new (...args: never[]) => unknown)[];
}

@Module({})
export class AppModule {
  static register(deps: AppDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [...CONTROLLERS, ...(deps.extraControllers ?? [])],
      providers: [
        { provide: CONFIG, useValue: deps.config },
        { provide: LOGGER, useValue: deps.logger },
        { provide: DB, useValue: deps.db },
        { provide: KEY_RESOLVER, useValue: deps.keyResolver },
        {
          provide: BLOB_STORE,
          useValue: deps.blobStore ?? new LocalBlobStore(deps.config.EVIDENCE_DIR),
        },
        { provide: SCANNER, useValue: deps.scanner ?? new BasicScanner() },
        TokenService,
        UserCache,
        LiveChanges,
        // Order matters: authenticate + build context first, then authorise.
        { provide: APP_GUARD, useClass: HubGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
        { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
        {
          provide: APP_FILTER,
          useFactory: (log: Logger) => new ProblemFilter(log),
          inject: [LOGGER],
        },
      ],
    };
  }
}
