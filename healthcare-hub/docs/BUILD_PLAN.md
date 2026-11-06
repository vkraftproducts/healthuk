# Build plan (work top to bottom; tick as you go)

Each milestone ends with: all tests green, demo script in `docs/demos/Mx.md`, and
DECISIONS.md updated. Do not start a milestone until the previous one is green.

## M0 — Foundations (Phase 2 start)

- [x] Monorepo (pnpm, Turborepo), TS strict, ESLint (incl. no-raw-prisma rule, no-console), Prettier, Husky + lint-staged, Conventional Commits
- [x] docker compose: postgres 16 (+btree_gist), azurite, mailpit, mock OIDC (dev only, hard-fails in prod) _(compose file written; Docker was unavailable in the build sandbox, so tests ran against a local Postgres 16. Mock OIDC runs as `pnpm --filter @hub/api dev:oidc`, not as a container.)_
- [x] `packages/config`, `packages/contracts` (zod + OpenAPI gen), `packages/db` (Prisma, raw SQL migration folder)
- [x] NestJS API skeleton: health `/healthz` `/readyz`, problem+json errors, pino with redaction, OTel _(OpenTelemetry export deferred to the Azure deployment; pino redaction done.)_
- [x] Auth guard (JWT via JWKS), `/me`, context interceptor, PermissionGuard + `@RequirePermission`
- [x] `withTenant()` + RLS policies + app/migrator DB roles; isolation test harness (TEST_PLAN §4)
- [x] Audit log module with hash chain + verify job _(hash chain + `/audit-log` + `verify-chain` done; the scheduled verify job and daily WORM anchor arrive with the worker in M2.)_
- [x] React web shell: layout, nav, breadcrumb/org switcher, auth flow, StatusBadge, DataTable _(auth flow uses the dev mock OIDC; Entra External ID PKCE is wired when the tenant exists.)_
- [x] GitHub Actions: lint, typecheck, unit, integration (testcontainers), build _(workflows written; not yet run on GitHub. Testcontainers not used: CI uses a postgres:16 service, see DECISIONS.)_
- [x] Bicep for staging (see ARCHITECTURE §5) + deploy workflow with OIDC federation _(written but NOT compiled or deployed: no Azure access yet. Run `az bicep build` and a what-if first.)_

## M1 — Organisation, users, roles, settings

- [x] Org/location/service/registered-activity CRUD; memberships; role/permission seed matrix
- [x] User invite, revoke (immediate), MFA enforcement for privileged roles
- [x] Support access grants (break-glass)
- [x] Settings screens; audit log viewer

> M1 notes: optimistic concurrency (If-Match → 409), invite via SECURITY DEFINER `invite_user()`, first sign-in links only on an IdP-verified email, break-glass grants ≤ 8h (read-only, audited per request), custom-role restrictions enforced in SQL and API, no privilege escalation (self-service permissions exempt). Org settings page edits only via API for now (warning windows UI arrives with M2 requirement templates).

## M2 — Rules engine + requirements + evidence

- [x] `packages/rules`: date helpers, status evaluator, recurrence, readiness, validation (all RULES_ENGINE §8 vectors) _(T1–T18 vectors; 100% line/branch coverage enforced.)_
- [x] Requirement templates/versions (publish flow), instances, applicability, due-date changes _(four-eyes publish; library adopt; expiry dates never editable.)_
- [x] Evidence upload via SAS → quarantine → scan → evidence; verification; many-to-many links _(signed short-lived upload/download URLs against a local blob store + basic scanner (EICAR, magic-byte and size checks). Azure Blob SAS + Defender for Storage adapters are swapped in at deployment, M8.)_
- [x] Reconciler worker (pg-boss) + status snapshot table _(`apps/worker`: reconcile every 15 min, notifications every 5 min, snapshot 02:05 and audit-chain verify 02:30 Europe/London. Daily WORM anchor and retention sweep need Azure immutable storage, M8.)_
- [x] Alerts + notification delivery (email via ACS, dedupe, retry, deputy escalation) _(dedupe per window, exponential backoff to DEAD, owner → deputy → registered manager escalation; ACS mailer adapter in M8, dev mailer logs only the recipient domain.)_

> M2 notes: API tests cover upload → scan → verify → status → alert end to end, segregation of duties (uploader cannot verify), quarantine (EICAR / type mismatch / size lie), sensitive-evidence visibility, signed-token tampering, applicability, due-date approvals, snooze not changing status (T16), reconciler time travel and notification retry/escalation. The Ambulance pack starter library is seeded in M5 as planned.

## M3 — Staff module (wireframe 02)

- [x] Staff list/profile with tabs; lifecycle transitions; role approvals; restrictions _(`/staff`, `/staff/:id` with Overview, Recruitment, Training, Supervisions, Appraisals, Documents, History; lifecycle rules in `packages/rules/staff.ts`.)_
- [x] Recruitment, references, DBS (restricted), RTW, licences, registrations, OH status _(one immutable `staff_record` table, payload validated per kind; DBS/OH detail/personal hidden by RLS without `staff.sensitive.view`; DBS certificate number encrypted at field level.)_
- [x] Training matrix by role, competencies, supervision, appraisal; role change recalculation _(`role_requirement` maps templates to roles; role approval or mapping change creates missing items (HR-03); `/staff/training-matrix`.)_
- [x] Self-service uploads & correction requests; dispatcher-limited view _(`/staff/me`, correction requests, crew may attach evidence only to their own items; dispatcher sees approved roles and restrictions only. The crew-facing screens are the mobile app (M7).)_

> M3 notes: readiness for a role across a job window (`/staff/:id/readiness`) combines lifecycle, role approval, licence category, competencies, restrictions (NO_DRIVING hard-blocks drivers) and blocking requirements, evaluated live. Leaver transition ends the user's memberships immediately. Verified in a browser against a live API (manager and dispatcher views).

## M4 — Fleet & equipment

- [x] Vehicle register, documents as requirements, location history, odometer with flags _(vehicle templates with `applicabilityRule.autoApply` are applied on create; decreasing / implausible readings are stored but never move the current odometer.)_
- [x] Maintenance by date/mileage; equipment register; inspection regimes; quarantine _(LOLER / service / calibration each need their own requirement; quarantining fitted kit reduces vehicle capability, FLT-08.)_
- [x] VDI templates + submissions (immutable + amendments); cleaning records _(idempotent on clientSubmissionId with capturedAt/receivedAt (UAT-06); a failed critical item raises a CRITICAL stop-use defect and a control alert.)_
- [x] Defects with automatic blocking + affected jobs; return-to-service; fuel/expenses + export _(affected jobs are computed once jobs exist in M6 (hook in `affectedAllocations`); release is a separate immutable act by someone other than the repairer; CSV export is formula-injection safe.)_

> M4 notes: the vehicle status is derived (BLOCKED while any stop-use defect is open; QUARANTINED / OFF_ROAD are explicit fleet decisions). Vehicle readiness checks defects, quarantine, maintenance at the END of the job window, vehicle requirements (MOT, insurance) and suitability (stretcher, wheelchair spaces, seats).

## M5 — Dashboard (wireframe 01) + compliance (wireframe 03)

- [x] Dashboard summary/actions/export; filters; source health; reconciliation test (UAT-08) _(tiles are counted from the same rows as their drill-down; job figures connected in M6.)_
- [x] Audit templates/versions, runs, sampling, responses, findings, actions, verification, re-audit _(four-eyes publish, management activation, AUD-02 repeat-sample reason; evidence alone never closes an action (UAT-04).)_
- [x] Policies/SOPs lifecycle + acknowledgements; risk register; registration & correspondence _(non-material versions carry acknowledgements forward; material versions force re-acknowledgement.)_
- [x] Events, reporting obligations, candour, complaints; premises register _(workflow gated on obligation decisions, candour decision when flagged, verified actions; safeguarding restricted by RLS.)_
- [x] Seed AC-01..AC-11 as inactive templates; Ambulance pack v1 starter library (inactive until approved) _(library in migration 0008 (20 items with sources); AC-07 + AUD-102 / ACT-218 / ACT-219 seeded for the wireframe example.)_
- [x] Evidence pack export (PDF index + ZIP) via worker _(built with the requester's permissions; downloaded through a 5-minute signed link; audited.)_

## M6 — Work planner & dispatch (wireframe 04) (Phase 3)

- [x] Bookings, recurrence series with instance edits, job fields with minimisation _(daily/weekly series up to 100 instances; "this" or "this and following" edits detach or shift only the intended instances; the patient is a booking reference, contact details live in a separate table readable only with `jobs.patient.view`.)_
- [x] Shifts, crew assignments, resource_booking exclusion constraint _(GiST exclusion on vehicle and staff bookings and on allocations per shift; crew changes and vehicle swaps are immutable shift_change rows.)_
- [x] Validate/allocate endpoints, validation panel UI, policy exceptions (no statutory/safety overrides) _(allocation re-validates at allocate and offer; 409 `ALLOCATION_BLOCKED` lists every check; only COMPETENCE can be excepted, for at most 7 days.)_
- [x] Planner day/week grid with drag/drop + keyboard alternative _("Assign here" per row; "Allocate and notify crew" stays disabled while any check fails.)_
- [x] Job lifecycle, offers/acknowledgements, late/unacknowledged alerts, reassignment on block _(idempotent status updates from the offline outbox; `job-timing` worker every 2 minutes; a stop-use defect releases not-started jobs for reassignment; dashboard job figures are live.)_

## M7 — Crew app (wireframe 05)

- [x] Expo app scaffolding, auth, secure storage, encrypted DB, outbox sync _(Expo SDK 58; Entra PKCE; SQLCipher via expo-sqlite; idempotent `POST /crew/sync`.)_
- [x] My shift + gates, VDI, cleaning, job detail/progress, defects, fuel, policies, profile _(plus Messages for pending items and conflict reconciliation.)_
- [x] Push registration (generic payloads); revocation wipe; offline rules
- [x] Maestro E2E flows; EAS internal builds _(flows and build profiles written; running them needs a device and the customer's EAS/store accounts – see DECISIONS M7.)_

## M8 — Reports, import, hardening, go-live readiness (Phases 4–5)

- [x] Reports listed in PRD §4.10 with documented definitions; monthly management pack PDF _(8 reports; CSV export audited; pack built by the worker.)_
- [x] CSV import framework + compliance workbook staging per MIG-01..03; full data export _(staff and vehicles; preview → commit → rollback; workbook sheets as CSV; ZIP export with attachments.)_
- [x] Retention rules, legal hold, SAR export, breach record workflow _(plus disclosure log and the 72-hour ICO clock; Settings → Data protection.)_
- [x] Production Bicep (prod params), budgets & alerts, backup geo-redundancy, restore runbook + drill _(Bicep not yet compiled here – no Azure CLI; local restore drill PASS, see docs/compliance.)_
- [x] k6 load test at pilot profile; axe accessibility pass; ZAP baseline; pen-test fixes _(local load check PASS (p95 < 0.7 s) and k6 script for staging; axe: no violations on 12 screens; ZAP workflow for staging; pen test is external – remediation log ready.)_
- [x] Compliance artefacts (SECURITY_COMPLIANCE §9); admin & user guides in `docs/guides/` _(drafts in docs/compliance – the organisation completes and signs the DPIA, ROPA, retention basis and statements.)_
- [x] All UAT-01..08 green; no open critical safety/isolation defects _(docs/compliance/uat-report.md; traceability guard in apps/api/test/uat-trace.test.ts.)_

## Spec gap closure (4 Nov 2026)

Closes the gaps found when comparing the build with the Development spec v0.1.

- [x] DASH-01 filters: location, service, owner and deadline date range, as well as module (`GET /dashboard/summary|actions` accept `locationId`, `serviceId`, `ownerUserId`, `dateFrom`, `dateTo`). Tiles still equal their drill-down under every filter. _(The service filter uses `applicabilityRule.services` (service codes) on a requirement template; a template that names none applies to every service. An owner filter hides vehicles, which have no named owner. A date range never hides a record that has no deadline, such as a blocked vehicle or a critical finding.)_
- [x] Group dashboard: `GET /dashboard/group` gives counts per organisation the user holds `dashboard.view` in, computed inside each organisation's own tenant context. Counts only; an organisation that cannot be read is shown as unavailable, never as zero. Shown on the home page when the user belongs to more than one organisation.
- [x] HSE-01 premises: create form on the Premises page; contractor, assessment reference/date, action owner, evidence count; infection-control items at an administration-only location need an explicit confirmation (migration 0014).
- [x] EVT-04 feedback: compliments, staff feedback and patient surveys with themes, actions (`source_type` FEEDBACK) and a themes report that counts complaints and feedback together (migration 0015, Compliance → Feedback).

Dental and care-home packs and integrations now exist as clearly labelled **draft / mock** builds (see "Later" below). Real content validation and live connections remain open.

## Later (separately approved): Phase 4 sector packs

Dental pack, care-home pack (content requires specialist validation), integrations
(FleetX, payroll, telematics, calendars) via adapters in `apps/api/src/integrations/*`.

### Draft build with mock data (done)

- **Dental (`DENTAL_V1`, 20 templates) and care-home (`CARE_HOME_V1`, 28 templates) packs** - migration `0016`. Synthetic starting content: every template's regulation reference starts "[Draft pack - specialist validation required before use]". Adopting one needs the pack enabled on the organisation and a named specialist (`specialistValidatedBy`), which is audited. Nothing is active until a second person publishes it.
- **Mock organisations** - `pnpm db:seed:sectors` adds "Mock Dental Practice (synthetic)" and "Mock Care Home (synthetic)" with a manager, an administrator, three staff each and INACTIVE draft audit templates carrying a proposed cadence. Users: `dev|dental-manager`, `dev|dental-admin`, `dev|carehome-manager`, `dev|carehome-admin`.
- **Integrations (INT-01), mock adapters only** - migration `0017`, `/integrations`, Settings -> Integrations. Telematics (odometer readings, flagged by the normal plausibility rules), FleetX (submitted fuel expenses, duplicates marked), training (unverified staff records, never linked to a requirement), payroll hours CSV and an iCalendar shift feed. Syncs are idempotent; a "faults" scenario shows flagged and skipped records. Connecting in LIVE mode is refused.
- **Still needs the customer**: specialist validation of both packs, confirmed API access and credentials for each real system, and a decision on payroll format.
