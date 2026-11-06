# Test plan

| Layer         | Tool                                                | Scope                                                      | Gate                  |
| ------------- | --------------------------------------------------- | ---------------------------------------------------------- | --------------------- |
| Unit          | Vitest                                              | `packages/rules` (100% branches), services, utils          | CI                    |
| Integration   | Vitest + Testcontainers Postgres 16 + Azurite       | API modules with real DB, RLS, constraints                 | CI                    |
| Isolation     | Generated suite                                     | every route × (foreign org, wrong role, crew-not-assigned) | CI, blocking          |
| E2E web       | Playwright                                          | key journeys + UAT-01..08                                  | CI on main, nightly   |
| E2E mobile    | Maestro                                             | shift gate, VDI, offline sync, defect                      | nightly / pre-release |
| Load          | k6                                                  | NFR-02 pilot profile                                       | pre-release           |
| Security      | CodeQL, pnpm audit, ZAP baseline, external pen test |                                                            | pre-go-live           |
| Accessibility | axe-core in Playwright + manual screen-reader pass  |                                                            | pre-release           |
| Restore drill | runbook                                             | RPO/RTO                                                    | quarterly             |

## 1. Seed data

`pnpm db:seed` creates "Exora" with Watford location matching wireframes:
staff Alex Morgan (ST-0042, licence due 12 Nov 2026), Sam Taylor, Jordan, Lee; vehicles
AMB-01..03 (AMB-03 critical ramp defect); jobs J-104, J-105, J-108, J-112, J-117; audit
AUD-102 with AC-07, ACT-218, ACT-219; the test suite adds a second org "Other organisation" for isolation
tests. All synthetic. Fixed clock via `TEST_NOW=2026-10-22T09:42:00+01:00`.

## 2. UAT scenarios (automate each as named Playwright/API test)

| ID                        | Steps                                                                                                                                      | Pass criterion                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| UAT-01 Expiry & warnings  | Run RULES_ENGINE T1–T11 via API with clock control; upload renewed licence                                                                 | due-today boundary, midnight, DST, whole-job validity correct; renewed evidence pending until verified                   |
| UAT-02 Safe allocation    | Try allocating (a) expired-licence driver, (b) missing mandatory competence, (c) AMB-03 with critical defect, (d) vehicle with expired MOT | each → 409 `ALLOCATION_BLOCKED` with specific check + reason; UI shows FAIL row; no override button for statutory/safety |
| UAT-03 Shift gate         | Crew starts shift without VDI; then without cleaning; swap vehicle; submit VDI with failed critical item                                   | blocked with reasons; replacement requires new checks; control alert created                                             |
| UAT-04 Audit closure      | Submit AUD-102 with 1 fail; upload evidence to ACT-218; try close                                                                          | action stays EVIDENCE_SUBMITTED until verifier accepts; re-audit ACT-219 scheduled; history intact                       |
| UAT-05 Access isolation   | Crew A requests crew B's job, patient fields, staff HR file, attachment link, export, via UI, altered URL, direct API                      | all denied (404); no data leakage in errors; audit entries                                                               |
| UAT-06 Offline sync       | Submit same VDI 3× with same clientSubmissionId; stale clearance offline                                                                   | exactly one record; pending badge; capturedAt & receivedAt stored; stale clearance cannot authorise                      |
| UAT-07 Scheduling         | Overlapping assignment; vehicle swap; cancel one recurring instance; edit "this and following"                                             | overlap rejected; history preserved; only intended instances changed                                                     |
| UAT-08 Reports & recovery | Compare each dashboard tile to drill-down; export evidence pack; restore backup to new server                                              | counts equal; export contains sources & approvals; restore within RTO                                                    |

## 3. Critical unit test list

All RULES_ENGINE §8 vectors; recurrence edge cases; permission matrix snapshot test;
redaction (logger drops `patient*`, `dob`, `address`, `phone`, `email` fields); hash chain
verification; idempotency key reuse with different payload → 422.

## 4. Isolation suite

Route registry is introspected at test time; for every route a test asserts that
(1) foreign-org token gets 404/403, (2) role lacking permission gets 403, (3) list endpoints
never return foreign rows, (4) SAS links are not issued for foreign blobs. A new route
without a permission decorator fails the build.
