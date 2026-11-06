# Healthcare Hub

Multi-tenant web platform and crew app for UK healthcare operations and compliance (first customer:
independent ambulance / patient transport, England). Agent rules are in `CLAUDE.md`; requirements in
`docs/`. Work is tracked in `docs/BUILD_PLAN.md` (currently: **M0 foundations complete**).

## Quick start (local)

Prerequisites: Node 22, pnpm 10, Docker.

```bash
pnpm install && pnpm build            # builds shared packages (db client, contracts) used by the API
cp .env.example .env
docker compose up -d postgres            # postgres 16 (azurite + mailpit also available)
export DATABASE_SUPERUSER_URL=postgresql://postgres:postgres@localhost:5432/postgres
export DATABASE_URL=postgresql://hub_app:hub_app_dev@localhost:5432/hub
export DATABASE_ADMIN_URL=postgresql://hub_migrator:hub_migrator_dev@localhost:5432/hub
pnpm --filter @hub/db bootstrap          # roles + database (once)
pnpm db:migrate && pnpm db:seed          # schema + synthetic "Exora International Ltd / London"

pnpm --filter @hub/api dev:oidc          # dev-only mock identity provider  (:4010)
pnpm --filter @hub/api dev               # API                              (:4000)
pnpm --filter @hub/web dev               # web                              (:5173)
```

Checks (all must pass before a task is done):

```bash
pnpm lint && pnpm typecheck && pnpm test     # tests need Postgres: TEST_SUPERUSER_URL (default localhost:5432 postgres/postgres)
```

## Layout

```
apps/api       NestJS + Fastify API (auth, tenant context, permissions, audit)
apps/web       React + Vite web shell
packages/db    SQL migrations (RLS, audit chain), Prisma client, withTenant()
packages/contracts  Zod schemas + OpenAPI
packages/ui    StatusBadge, DataTable
packages/rules Pure status/date/gate logic (Milestone M2)
infra/         Bicep (UK South) - not yet compiled/deployed
```

## Safety rails already enforced by tests

Tenant isolation (RLS, fail-closed), generated per-route isolation suite, append-only hash-chained
audit log (tamper detection), deny-by-default permissions, MFA for privileged roles, problem+json
errors that never echo input, log redaction of PII, mock OIDC refused in production.
