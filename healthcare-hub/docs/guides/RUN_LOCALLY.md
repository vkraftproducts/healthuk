# Run Healthcare Hub locally (Windows) and test M0–M7

Everything here is local and synthetic: a Postgres container, a development-only sign-in
server (mock OIDC) and the seeded "Meadowbank Patient Transport / Watford" data. Commands are for
**PowerShell** in the repository folder:

```powershell
cd "$HOME\Downloads\HealthcareUK\healthcare-hub"
```

## 1. Install the prerequisites (once)

| Tool           | Version                         | Notes                                                              |
| -------------- | ------------------------------- | ------------------------------------------------------------------ |
| Node.js        | 22 LTS (22.x)                   | nodejs.org installer or nvm-windows. Check with `node -v`.         |
| pnpm           | 10.28.0                         | `corepack enable` then `corepack prepare pnpm@10.28.0 --activate`. |
| Docker Desktop | current, WSL 2 backend          | Must be running before any database step.                          |
| Git            | any                             | The folder is already a Git repository.                            |
| Android Studio | optional (crew app on emulator) | Only for section 7 option B. Includes the JDK and Android SDK.     |

These ports must be free: **5432** (Postgres), **4000** (API), **4010** (mock sign-in),
**5173** (web). If you already run Postgres on Windows, stop its service first
(`Stop-Service postgresql*`) or the container cannot bind 5432.

If PowerShell refuses to run `pnpm` ("running scripts is disabled"), run once:
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## 2. Install dependencies and configure

```powershell
pnpm install
Copy-Item .env.example .env
```

`.env` holds local, development-only settings. Every dev script reads it automatically; a
variable set in your shell wins over the file. You do not need to edit it.

## 3. Create the database (once, or after a reset)

```powershell
docker compose up -d          # postgres, azurite, mailpit
docker compose ps             # wait until postgres shows "healthy"
pnpm build                    # builds the shared packages (and generates the Prisma client)
pnpm db:bootstrap             # creates roles hub_app / hub_migrator; hands them the hub database
pnpm db:migrate               # applies migrations 0001 … 0010
pnpm db:seed                  # synthetic Meadowbank Patient Transport / Watford
```

Expected: `bootstrap complete`, `applied: 0001_foundations.sql, … 0010_m7_crew.sql`, and
`seeded Meadowbank Patient Transport / Watford`. Re-running migrate or seed is safe.

## 4. Start the stack

```powershell
pnpm dev
```

This starts the containers, the API (http://localhost:4000), the worker, the mock sign-in
server (http://localhost:4010) and the web app (http://localhost:5173). Wait for
`api listening`, `worker started` and the Vite `Local:` line. Stop everything with
`Ctrl+C`.

Check it is healthy (second PowerShell window):

```powershell
Invoke-RestMethod http://localhost:4000/readyz      # status: ready, database: ok
```

Open **http://localhost:5173**. The sign-in page lists the seeded synthetic users: pick
**Manager** (registered manager) and select **Sign in**.

### Give the crew a shift for today

The seed has no shift for today. In a second window, while `pnpm dev` is running:

```powershell
pnpm demo:crew
```

It books a shift on **AMB-01** for Alex Morgan (ST-0042, driver) and Sam Taylor (ST-0043),
records a synthetic licence check for ST-0042, and books, allocates and offers one journey.
Expect `"allocated": true` and a job code such as `J-100`. Run it again on another day for a
new shift (on the same day it is refused: no double booking).

### Sign in as someone else (web)

Select **Sign out** at the bottom of the left-hand menu, then pick another user on the sign-in
page. Each browser tab keeps its own sign-in, so two tabs can be two different users.

| User            | Name                     | Role                            | Good for                         |
| --------------- | ------------------------ | ------------------------------- | -------------------------------- |
| `manager`       | Manager                  | Registered manager              | Everything; dashboard            |
| `hr`            | Hana Rowe                | HR lead                         | Staff, checks, verification (M3) |
| `fleet`         | Finn Lee                 | Fleet lead                      | Vehicles, defects, VDIs (M4)     |
| `governance`    | Gina Ode                 | Governance lead                 | Audits, policies, events (M5)    |
| `dispatcher`    | Dispatcher               | Dispatcher                      | Work planner, allocation (M6)    |
| `crew`/`crew2`  | Alex Morgan / Sam Taylor | Crew                            | Crew API and app (M7)            |
| `auditor`       | Audrey Ward              | Auditor (read-only)             | Checking that read-only holds    |
| `other-manager` | Other Manager            | Manager, **other organisation** | Tenant isolation checks          |

## 5. What to look at, milestone by milestone

| Milestone | Where                                  | Try this                                                                                                     |
| --------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| M0–M1     | Settings (as `admin`)                  | Organisation, locations, users and roles; the organisation picker; the auditor cannot change anything.       |
| M2        | Compliance → requirements              | Upload evidence: it stays "awaiting verification" (never green) until someone else verifies it.              |
| M3        | Staff (as `hr`)                        | ST-0042 profile: lifecycle, role approvals, records; readiness in the staff list.                            |
| M4        | Vehicles and assets (as `fleet`)       | AMB-03 is blocked by a critical stop-use defect; release needs a second person.                              |
| M5        | Dashboard, Compliance, Premises safety | Every tile count equals its drill-down list; AUD-102 with its actions ACT-218/ACT-219; evidence pack export. |
| M6        | Work planner (as `dispatcher`)         | After `pnpm demo:crew`: J-100 on AMB-01. Try allocating a job to AMB-03: blocked, no override button.        |
| M7        | Crew API / crew app (section 6 and 7)  | My shift gate cards, offline sync, job progress.                                                             |

## 6. Try the crew API by hand (M7)

```powershell
$org   = "01900000-0000-7000-8000-000000000001"
$token = (Invoke-RestMethod "http://localhost:4010/token?user=crew").access_token
$h     = @{ Authorization = "Bearer $token"; "x-org-id" = $org }
$today = Invoke-RestMethod http://localhost:4000/api/v1/crew/today -Headers $h
$today.shift.gate.cards | Format-Table label, state, reasonText   # Driving clearance APPROVED, VDI/Cleaning REQUIRED
$today.shift.jobs       | Format-Table code, state, nextStates      # J-100 OFFERED → ACKNOWLEDGED / REFUSED
```

Idempotent offline sync (UAT-06): send the same cleaning record twice.

```powershell
$item = @{ clientSubmissionId = [guid]::NewGuid().ToString(); type = "CLEANING";
           payload = @{ vehicleId = $today.shift.vehicle.id; shiftId = $today.shift.id;
                        type = "PRE_SHIFT"; capturedAt = (Get-Date).ToUniversalTime().ToString("o") } }
$body = @{ items = @($item) } | ConvertTo-Json -Depth 6
(Invoke-RestMethod -Method Post http://localhost:4000/api/v1/crew/sync -Headers $h -ContentType "application/json" -Body $body).results.outcome   # ACCEPTED
(Invoke-RestMethod -Method Post http://localhost:4000/api/v1/crew/sync -Headers $h -ContentType "application/json" -Body $body).results.outcome   # DUPLICATE
```

The API's OpenAPI description is at http://localhost:4000/api/v1/openapi.json if you prefer a
REST client.

## 7. The crew mobile app

**Option A – automated tests only (no phone needed).** The app's logic and screens are covered
by Jest and Testing Library:

```powershell
pnpm --filter @hub/mobile test        # 35 tests
```

**Option B – Android emulator.** The app uses SQLCipher, so it needs a development build (Expo
Go will not work). iOS builds need a Mac.

1. In Android Studio create an emulator (Pixel, Android 14+), start it, and **set a screen lock
   PIN** in its Settings (the app refuses to sign in without one).
2. Set the Android SDK path for this window, and point the app at your PC (`10.0.2.2` is the
   host machine as seen from the emulator):

   ```powershell
   $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
   $env:HUB_API_URL = "http://10.0.2.2:4000"
   $env:HUB_OIDC_ISSUER = "http://10.0.2.2:4010"
   pnpm --filter @hub/mobile android      # expo run:android: first build takes several minutes
   ```

3. With `pnpm dev` running and `pnpm demo:crew` done, tap **Sign in** (signs in as `crew`),
   unlock with the PIN, and you should see AMB-01 with the three gate cards and J-100.
4. Try airplane mode: complete the cleaning confirmation, see "1 waiting to send", turn
   airplane mode off and watch it send.

On a physical Android phone over USB, run `adb reverse tcp:4000 tcp:4000` and
`adb reverse tcp:4010 tcp:4010` and leave `HUB_API_URL`/`HUB_OIDC_ISSUER` unset (localhost).

End-to-end flows (optional, needs Maestro installed and the emulator running):
`maestro test apps\mobile\.maestro`.

## 8. Run the automated tests

Docker's Postgres must be running (`docker compose up -d`); `pnpm dev` does not need to be.
The tests create and use their own throwaway databases, so they never touch your `hub` data.

```powershell
pnpm lint
pnpm typecheck
pnpm test
```

Expected at M7 (about 3–5 minutes):

| Package          | Tests                     | What it proves                                                |
| ---------------- | ------------------------- | ------------------------------------------------------------- |
| `@hub/rules`     | 101 (100 % coverage gate) | Status colours, dates in Europe/London, gates, job rules      |
| `@hub/db`        | 54                        | Row-level security, immutable history, hash-chained audit log |
| `@hub/domain`    | 15                        | Shared business logic                                         |
| `@hub/contracts` | 11                        | Request/response schemas                                      |
| `@hub/ui`        | 9                         | Status badges always have text + icon                         |
| `@hub/web`       | 32                        | Web screens                                                   |
| `@hub/api`       | 643 passed, 48 skipped    | Every endpoint, permissions, tenant isolation, UAT scenarios  |
| `@hub/mobile`    | 35                        | Outbox, sync, wipe rules, gate cards, screens                 |

Run one area or one file:

```powershell
pnpm --filter @hub/api test                                   # API only
pnpm --filter @hub/api exec vitest run test/m7.test.ts         # one milestone
pnpm --filter @hub/api exec vitest run -t "UAT-06"             # tests tagged with a UAT id
```

Where the acceptance scenarios live (TEST_PLAN UAT-01..08 so far):

| Scenario                  | Test file(s) in `apps/api/test`                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| UAT-01 expiry & warnings  | `packages/rules/test/vectors.test.ts` (RULES_ENGINE T1–T11), `m2.test.ts` (renewed evidence stays pending) |
| UAT-02 safe allocation    | `m4.test.ts`, `m6.test.ts`                                                                                 |
| UAT-03 shift gate         | `m4.test.ts`, `m6.test.ts`, `m7.test.ts`                                                                   |
| UAT-04 audit closure      | `m5.test.ts`                                                                                               |
| UAT-05 access isolation   | `isolation.generated.test.ts`, `m6.test.ts`, `m7.test.ts`                                                  |
| UAT-06 offline sync       | `m4.test.ts`, `m7.test.ts`, mobile `core.test.ts`                                                          |
| UAT-07 scheduling         | `m6.test.ts`                                                                                               |
| UAT-08 reports & recovery | `m5.test.ts` (tiles = drill-down; evidence pack). Restore drill comes with M8.                             |

## 9. Reset or stop

```powershell
docker compose down           # stop containers, keep data
docker compose down -v        # stop and DELETE the local database; then repeat section 3
```

## Troubleshooting

| Symptom                                                                                   | Fix                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Invalid configuration: DATABASE_URL, OIDC_ISSUER …`                                      | `.env` is missing at the repository root: `Copy-Item .env.example .env`.                                                                                                                                                                                                                                     |
| `ECONNREFUSED 127.0.0.1:5432` / bootstrap fails                                           | Docker Desktop is not running, or Postgres is not healthy yet (`docker compose ps`).                                                                                                                                                                                                                         |
| Port 5432 already in use                                                                  | A Windows Postgres service is running: stop it, or change the port mapping and the URLs.                                                                                                                                                                                                                     |
| `password authentication failed for user "postgres"` in tests                             | Your superuser differs: set `TEST_SUPERUSER_URL` (and `DATABASE_SUPERUSER_URL`) in `.env`.                                                                                                                                                                                                                   |
| Web shows "You do not have permission…"                                                   | Check `apps\web\.env.local`; some users (crew, auditor) cannot see every page by design.                                                                                                                                                                                                                     |
| `prisma generate` fails during `pnpm build`                                               | It downloads engine files once: check your proxy/firewall allows `binaries.prisma.sh`.                                                                                                                                                                                                                       |
| `pnpm demo:crew` says `blockers: [...]`                                                   | The named checks failed (that is the safety gate working); `docker compose down -v` and reseed for a clean start.                                                                                                                                                                                            |
| Crew app: "Set a screen lock…"                                                            | Set a PIN on the emulator or phone.                                                                                                                                                                                                                                                                          |
| Crew app cannot reach the API from the emulator                                           | Use `10.0.2.2` as in section 7, and keep `pnpm dev` running on the PC.                                                                                                                                                                                                                                       |
| Web shows "Source unavailable. Could not load your account" (API log: `/api/v1/me` → 401) | Usually a leftover process from an earlier run (Ctrl+C on Windows can leave Node running). Stop `pnpm dev`, run `Get-Process node \| Stop-Process`, start `pnpm dev` again. The API log now says why a token was rejected (`token rejected`, with a reason). If it says `USER_INACTIVE`, run `pnpm db:seed`. |
