# Architecture

Modular monolith (ARCH-01): one API service with strict domain modules, one background
worker, one web SPA, one mobile app, one Postgres database, one blob store. Chosen for low
running cost and simple operations at pilot scale; modules have clean boundaries so they can
be split later.

## 1. Stack

| Layer          | Choice                                                                       | Why                                                     |
| -------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------- |
| Language       | TypeScript (strict) everywhere                                               | One language across web, API, mobile, shared rules      |
| Monorepo       | pnpm workspaces + Turborepo                                                  | Shared packages, cached builds                          |
| API            | NestJS 10 on Fastify adapter                                                 | Modules, guards, DI; good fit for permission decorators |
| Validation     | zod (shared schemas in `packages/contracts`) + `nestjs-zod`                  | Same schema web/mobile/API; OpenAPI generation          |
| DB             | PostgreSQL 16 (Azure Database for PostgreSQL Flexible Server)                | Relational, RLS, exclusion constraints                  |
| ORM            | Prisma 5 + raw SQL migrations for RLS/constraints                            | Agent-friendly, typed                                   |
| Jobs/queue     | pg-boss (Postgres-backed)                                                    | No Service Bus cost; transactional enqueue              |
| Dates          | Luxon (`Europe/London`)                                                      | Explicit zones, DST-safe                                |
| Web            | React 18 + Vite + TanStack Router + TanStack Query + Tailwind + Radix/shadcn | Fast SPA, accessible primitives                         |
| Mobile         | Expo (React Native) SDK, EAS Build                                           | One codebase for Android & iOS                          |
| Mobile storage | op-sqlite with SQLCipher + expo-secure-store for key                         | Encrypted offline cache/queue                           |
| Auth (IdP)     | Microsoft Entra External ID (OIDC, PKCE)                                     | Free tier covers pilot MAU; MFA; UK/EU data handling    |
| Authorisation  | In-app RBAC tables (org/location/role/permission)                            | IdP proves identity only                                |
| Files          | Azure Blob Storage + user-delegation SAS (≤ 5 min)                           | Private, short-lived links                              |
| Malware scan   | Microsoft Defender for Storage on-upload scanning                            | Managed, cheap at low volume                            |
| PDF/ZIP export | Playwright-rendered HTML→PDF in worker; `archiver` for ZIP                   | Indexed evidence packs                                  |
| Email          | Azure Communication Services Email                                           | Pay-per-message, UK data option                         |
| Push           | Expo push → APNs/FCM (no patient data in payload)                            | Simple; payload is "You have an update" + ID            |
| Observability  | OpenTelemetry → Application Insights (with PII redaction)                    | Cheap with sampling + daily cap                         |
| Tests          | Vitest, Testcontainers (Postgres), Playwright, Maestro (mobile)              |                                                         |
| IaC            | Bicep in `infra/`                                                            | Native Azure, no state backend cost                     |
| CI/CD          | GitHub Actions with OIDC federated credentials to Azure                      | No stored secrets                                       |

## 2. Repo layout

```
apps/
  api/            NestJS: src/modules/{identity,org,staff,fleet,compliance,events,
                  premises,jobs,documents,notifications,reports,admin,audit,import}
  worker/         pg-boss consumers: reconciliation, notifications, exports, imports
  web/            React SPA
  mobile/         Expo app
packages/
  rules/          PURE status/date/gate logic (RULES_ENGINE.md) — no I/O
  contracts/      zod schemas + generated OpenAPI + typed API client
  db/             prisma/schema.prisma, sql/ (RLS, constraints), seed/
  ui/             shared web components (StatusBadge, DataTable, CheckList…)
  config/         eslint, tsconfig, prettier
infra/            Bicep: main.bicep, modules/*.bicep, params/{staging,prod}.bicepparam
docs/             this documentation
```

## 3. Request flow and isolation

```
Client ─OIDC token─▶ API (Container Apps)
  AuthGuard: validate JWT (issuer, audience, exp, amr for MFA)
  ContextInterceptor: resolve user → memberships → active org/location from header
                      X-Org-Id / X-Location-Id (must be in memberships)
  PermissionGuard: @RequirePermission('fleet.defect.create', scope)
  Service → withTenant(ctx, tx => ...)   // sets SET LOCAL app.org_id, app.user_id
  Postgres RLS: USING (organisation_id = current_setting('app.org_id')::uuid)
  AuditInterceptor: emits audit event for sensitive operations
```

- `withTenant` opens a transaction and runs `SELECT set_config('app.org_id', $1, true)`.
- App DB role `hub_app` is **not** table owner and has `FORCE ROW LEVEL SECURITY`.
- Migration role `hub_migrator` owns tables; used only by CI deploy job.
- Field-level restriction (DBS, OH, safeguarding) enforced in services via permission
  checks + separate tables (`staff_sensitive`, `safeguarding_case`) with their own RLS
  policies using `app.permissions`.

## 4. Background worker

- `reconcile-statuses` every 15 min (incremental) and 02:00 nightly (full).
- `send-notifications` (dedupe key, retries with exponential backoff, deputy escalation).
- `generate-export` (inspection packs, reports) → blob → audit event → short-lived link.
- `process-import` (staged CSV/XLSX with preview and rollback).
- `audit-anchor` daily: writes latest hash-chain head per org to immutable blob container.
- `retention-sweep` daily: applies approved retention rules respecting legal holds.

## 5. Azure deployment (UK South primary, UK West for backup copies)

```
Azure Front Door Standard (TLS, custom domain, rate-limit custom rules)  [optional in lean tier]
  ├─ Static Web Apps (Standard)  → web SPA
  └─ Container Apps Environment (Consumption, UK South)
        ├─ api     (min 1 replica, 0.5 vCPU / 1 GiB, max 3)
        └─ worker  (1 replica, 0.25 vCPU / 0.5 GiB)
PostgreSQL Flexible Server (Burstable B2s, 64 GiB, PITR 35 days, geo-redundant backup → UK West)
Storage account (GRS UK South→UK West): containers quarantine/, evidence/ (versioning,
  soft delete), exports/ (lifecycle 7 days), audit-anchors/ (immutable WORM policy)
Key Vault (secrets, SAS signing via managed identity), Container Registry (Basic)
Application Insights + Log Analytics (daily cap, 30–90 day retention)
Communication Services (email), Entra External ID tenant
Managed identities everywhere; no connection-string secrets in app settings.
```

Network: start with public endpoints restricted by firewall rules + Entra auth + TLS
(keeps cost low). Upgrade path: VNet-integrated Container Apps + private endpoints for
Postgres/Storage (adds ~£15–25/month) — recommended before onboarding multiple organisations.

## 6. Environments

| Env        | Where                                                           | Notes                                               |
| ---------- | --------------------------------------------------------------- | --------------------------------------------------- |
| local      | docker compose (postgres 16, azurite, mailpit, mock OIDC)       | mock OIDC refuses to start if `NODE_ENV=production` |
| staging    | Azure UK South, scaled down, Postgres B1ms stopped out of hours | synthetic data only                                 |
| production | Azure UK South                                                  | real data after DPIA sign-off                       |

## 7. Availability, backup and DR (NFR-01)

- RPO ≤ 1 h: Postgres PITR (continuous WAL, ~5 min RPO) + geo-redundant backups.
- RTO ≤ 4 h: runbook `docs/runbooks/restore.md` (create in M7): restore to new server in
  UK South or UK West, redeploy Container Apps via Bicep, swap connection. Drill quarterly.
- Blob: GRS + versioning + soft delete (30 days).
- Manual fallback: daily printable "tomorrow's jobs & crew" PDF + downtime procedure.
- Zone-redundant HA for Postgres is the upgrade path when moving beyond pilot.

## 8. Performance (NFR-02)

Indexes on `(organisation_id, status, due_date)`, `(organisation_id, subject_type, subject_id)`;
dashboard counts from a `requirement_status_snapshot` maintained by the reconciler + on-write
updates; paginate everything; k6 load test script in `tests/load`.
