# Load test report (NFR-02)

**Target:** pilot load of 100 staff, 50 vehicles, 10 locations and 500 journeys a day, with p95 under
2 seconds for dashboard and job actions.

## Build-machine run, 2026-11-02

- **Data:** the seeded example organisation plus `tests/load/seed-pilot.mjs`, which loaded 100 staff
  and 50 vehicles through the CSV importer and about 470 journeys for the day through the bookings API
  (synthetic).
- **Load:** `node tests/load/smoke.mjs 60 20`, meaning 20 concurrent clients for 60 seconds with no
  think time. That is about 45 requests a second, far above pilot usage.
- **Environment:** a 2-CPU build VM running the API from source (tsx, not bundled), with Postgres 16
  on the same machine and the rate limit raised for the run (`RATE_LIMIT_PER_MINUTE`).

| Scenario          | Requests | Errors | p50 ms | p95 ms | p99 ms |
| ----------------- | -------- | ------ | ------ | ------ | ------ |
| dashboard summary | 339      | 0      | 508    | 665    | 753    |
| dashboard actions | 339      | 0      | 501    | 650    | 723    |
| planner day       | 340      | 0      | 451    | 569    | 636    |
| jobs list         | 341      | 0      | 374    | 505    | 553    |
| job detail        | 341      | 0      | 415    | 561    | 646    |
| crew today        | 340      | 0      | 465    | 613    | 680    |
| staff list        | 339      | 0      | 409    | 525    | 586    |
| fleet list        | 339      | 0      | 374    | 497    | 570    |

**Result: PASS.** Every p95 is under 700 ms and there were no errors.

## Still to do before go-live

Run `tests/load/pilot.js` (k6, 10 minutes, 15 office users and 25 crews) against staging on the
production SKU, and record the result here. k6 could not be installed in the build environment.
