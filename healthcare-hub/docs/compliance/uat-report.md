# UAT report (TEST_PLAN UAT-01..08)

Automated run on 2026-11-02 at commit after `c419145` (build machine, synthetic data).
Every scenario is covered by tests tagged with its UAT id; `apps/api/test/uat-trace.test.ts` fails
the build if any scenario loses its tagged API tests.

| Scenario                    | What is proved                                                                                                                                                        | Passing tests (failed)    | Where                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------- |
| UAT-01 Expiry and warnings  | RULES_ENGINE T1–T11 (due today, midnight, DST, whole-job validity); renewed evidence stays pending until verified                                                     | API 14 (0), rules 17 (0)  | `m2.test.ts`, `packages/rules/test/vectors.test.ts`       |
| UAT-02 Safe allocation      | Expired licence, missing competence, AMB-03 critical defect, expired MOT: 409 with the specific check; no override for statutory or safety checks                     | API 9 (0)                 | `m4.test.ts`, `m6.test.ts`                                |
| UAT-03 Shift gate           | Start blocked without a VDI or cleaning; a vehicle swap needs new checks; a failed critical VDI item blocks the vehicle and alerts control                            | API 10 (0)                | `m4.test.ts`, `m6.test.ts`, `m7.test.ts`                  |
| UAT-04 Audit closure        | AUD-102 with one failure; ACT-218 stays at evidence submitted until another person verifies; re-audit ACT-219; history intact                                         | API 2, rules 1, web 6 (0) | `m5.test.ts`                                              |
| UAT-05 Access isolation     | Every route probed across organisations and roles; crew cannot reach another crew's job, patient fields, HR files, attachments or exports (404); no leakage in errors | API 608 (0)               | `isolation.generated.test.ts`, `m6.test.ts`, `m7.test.ts` |
| UAT-06 Offline sync         | The same submission sent repeatedly creates one record; pending badges; capture and receipt times stored; a stale offline start needs control                         | API 13, mobile 7 (0)      | `m4.test.ts`, `m7.test.ts`, mobile `core.test.ts`         |
| UAT-07 Scheduling           | Overlaps refused by the database; vehicle swap keeps history; cancelling one recurring instance or editing "this and following" changes only those                    | API 6 (0)                 | `m6.test.ts`                                              |
| UAT-08 Reports and recovery | Each dashboard tile equals its drill-down; the evidence pack has sources and approvals; restore to a new database matches every table with the audit chains intact    | API 3, rules 4 (0)        | `m5.test.ts`, `m8.test.ts`, `restore-drill-report.md`     |

**Totals for the run:** API 770 passed, 0 failed, 49 skipped; rules 114, web 39 and mobile 35 passed,
none failed.

The 49 skipped tests are the generated isolation probes for routes that the probe user (crew in the
other organisation) is entitled to call, such as its own shift or devices. They are not failures.

## Not covered by this automated run

- The Playwright web end-to-end run and the Maestro crew-app flows. These need a deployed or locally
  running stack with a browser or device. The Maestro flows are in `apps/mobile/.maestro`.
- A production restore within the RTO: run the quarterly drill in `docs/runbooks/restore.md` on
  Azure.

**Open critical safety or isolation defects: none known.**
