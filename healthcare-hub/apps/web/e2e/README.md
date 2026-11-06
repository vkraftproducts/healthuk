# Browser tests per role (Playwright)

These tests drive the real web app in Chromium, signed in as each seeded synthetic user. They
were written on 6 Nov 2026 and **have not been run yet**.

## Before you run them

1. Install the browser once: `pnpm --filter @hub/web exec playwright install chromium`.
2. Start the development stack and load the synthetic data (see `docs/guides/RUN_LOCALLY.md`):
   `pnpm dev`, `pnpm db:seed`, then `pnpm demo:data`.
3. Run: `pnpm test:e2e` from the repository root (or `pnpm --filter @hub/web e2e`).

Set `E2E_BASE_URL` to test somewhere other than `http://localhost:5173`. The tests use the
development sign-in page, so they cannot run against a build that uses Microsoft sign-in.

## What is covered

- `roles.e2e.ts`: for every seeded role, the menu matches the role's permissions, hidden pages
  refuse when opened by URL, and every page in the menu opens. A manager in another organisation
  cannot see Exora staff.
- `workflows.e2e.ts`: one core journey per role (alerts centre, staff requests queue, vehicle
  status and readiness, planner shift management, data protection logs, my record, read-only
  auditor).
- `accessibility.e2e.ts`: axe (serious and critical, WCAG 2.2 AA tags) on the main screen of each
  role.

The tests are read-only apart from what the screens do when opened. They run one at a time
because they share one database.
