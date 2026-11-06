# CLAUDE.md — Healthcare Hub

You are building **Healthcare Hub**, a multi-tenant web platform and crew mobile app for UK
healthcare operations and compliance (first customer: an independent ambulance / patient
transport service in England; later dental practices and care homes via sector packs).

Read this file fully before every session. Then read the doc relevant to your task.

## Document map (source of truth, in priority order)

| Doc                           | Use it for                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| `docs/PRD.md`                 | What to build, why, requirement IDs, user stories, acceptance criteria                   |
| `docs/RULES_ENGINE.md`        | Status colours, due/expiry logic, deployment gates. **Safety-critical — follow exactly** |
| `docs/SECURITY_COMPLIANCE.md` | RBAC matrix, tenant isolation, audit trail, UK GDPR, retention                           |
| `docs/ARCHITECTURE.md`        | Stack, repo layout, modules, Azure deployment, environments                              |
| `docs/DATA_MODEL.md`          | Entities, relationships, constraints, Prisma conventions                                 |
| `docs/API_SPEC.md`            | REST conventions and endpoint catalogue                                                  |
| `docs/UI_SPEC.md`             | Web screens (from wireframes 01–04, 06), components, accessibility                       |
| `docs/MOBILE_APP.md`          | Crew app (wireframe 05), offline sync, device security                                   |
| `docs/BUILD_PLAN.md`          | Ordered milestones and task checklists — **work through this in order**                  |
| `docs/TEST_PLAN.md`           | Unit/integration/E2E strategy and the UAT-01..08 automated scenarios                     |
| `docs/DECISIONS.md`           | Assumptions, open questions, and ADR index (`docs/adr/`)                                 |

If two docs conflict: RULES_ENGINE and SECURITY_COMPLIANCE win, then PRD, then the rest.
If something is genuinely unspecified, choose the safest reasonable option, record it in
`docs/DECISIONS.md` under "Agent assumptions", and continue. Do not stall.

## Non-negotiables (never violate, never "temporarily" skip)

1. **Server-side authorisation on everything.** Every query, record, attachment, search,
   export, report and API call is checked server-side for organisation, location and role.
   UI hiding is cosmetic only. (SYS-01, SEC-01, UAT-05)
2. **Tenant isolation in depth.** Every business table has `organisation_id`. Prisma access
   goes through the scoped client (`withTenant()`), and Postgres Row-Level Security is enabled
   on every tenant table as a second line of defence. Never use the unscoped client in
   request handlers.
3. **Upload never makes anything green.** Evidence is `PENDING_VERIFICATION` until an
   authorised reviewer verifies it. (Status rules in RULES_ENGINE §2)
4. **Safety gates cannot be overridden.** Statutory invalidity (expired licence, no
   insurance/MOT) and safety-critical defects block allocation and shift start. No
   override endpoint exists for these. Policy exceptions need named approver, reason,
   duration and audit. (JOB-03)
5. **History is immutable.** VDIs, audits, evidence versions, due-date changes and approvals
   are append-only. Corrections create attributed amendments. Audit log is hash-chained and
   the DB role used by the app has no UPDATE/DELETE on `audit_log`.
6. **Dates:** date-only deadlines are evaluated in `Europe/London` through 23:59:59.999 on the
   stated date. Server time is authoritative. Use the helpers in `packages/rules` — never
   `new Date()` arithmetic in business code. (ALERT-01)
7. **No patient data** in push notifications, emails, logs, analytics, error trackers, URLs
   or query strings. Log IDs, not names. A lint rule and a log redactor enforce this.
8. **Colour is never the only signal.** Every status shows text + icon + colour (WCAG 2.2 AA).
9. **No CQC rating claims.** Internal measures are labelled "Internal measure — not a CQC rating".
10. **Synthetic data only** in seeds, tests, fixtures and screenshots.

## Working rules

- Work milestone by milestone from `docs/BUILD_PLAN.md`. Tick boxes as you complete them.
- Each task: write/extend tests first for rules, permissions and gates; then implement; then
  run `pnpm lint && pnpm typecheck && pnpm test` and fix everything before moving on.
- Keep business rules as **pure functions** in `packages/rules` (no I/O) so web, API, worker
  and mobile share identical logic. The API is still the authority; the client copy is for UX.
- Every new endpoint needs: zod request/response schema, permission declaration
  (`@RequirePermission(...)`), audit event if sensitive, and an isolation test.
- Every new tenant table needs: `organisation_id`, RLS policy, indexes on
  `(organisation_id, ...)`, `created_at/created_by`, and a migration.
- Migrations are forward-only and reviewed; never edit an applied migration.
- Small, focused commits with Conventional Commit messages referencing requirement IDs,
  e.g. `feat(fleet): block vehicle on critical defect [FLT-06][UAT-02]`.
- Do not add dependencies casually. Prefer the stack in ARCHITECTURE.md. Pin versions;
  avoid packages published in the last 14 days.
- Out of scope (do not build): e-prescribing, eMAR administration, dental charting,
  resident care planning, payroll calculation, automated clinical triage, route optimisation,
  direct CQC portal submission, NHS system integrations.

## Commands (create these in Milestone 0)

```
pnpm install
pnpm dev              # docker compose (postgres, azurite, mailpit) + api + web
pnpm dev:mobile       # Expo
pnpm db:migrate       # prisma migrate dev
pnpm db:seed          # synthetic "Exora / Watford" data matching wireframes
pnpm test             # vitest unit + integration (testcontainers postgres)
pnpm test:e2e         # playwright web E2E incl. UAT scenarios
pnpm lint && pnpm typecheck
```

## Definition of done (per task)

Tests green · types clean · lint clean · permissions + isolation tested · audit events emitted
for sensitive actions · no PII in logs · accessible (labels, keyboard, contrast) · docs updated
if behaviour or API changed.
