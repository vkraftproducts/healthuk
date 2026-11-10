# Deploying the demo stack with Coolify

A demo environment on one VM, built by Coolify from `docker-compose.coolify.yml`. Synthetic data
only: password sign-in with the seeded users, MFA off. It runs with `NODE_ENV=development`, which
is what allows the seeded demo passwords and `DEV_DISABLE_MFA`. **Do not put real patient or staff
data in it.**

## What runs

| Service    | What it does                                                                     |
| ---------- | -------------------------------------------------------------------------------- |
| `postgres` | Postgres 16 with a persistent volume (`pgdata`)                                  |
| `setup`    | One-shot on every deploy: roles, migrations, seed, sector packs; then exits      |
| `api`      | NestJS API on port 4000 (internal only), evidence files on the `evidence` volume |
| `worker`   | Background jobs (escalations, reminders); shares the `evidence` volume           |
| `web`      | nginx serving the web app on port 80 and proxying `/api` to the API              |

Only `web` is exposed. The browser talks to one origin, so the sign-in cookie and the API origin
check both work.

## Before you start

- A VM with Coolify v4 installed. Recommended at least 2 vCPU and 4 GB RAM: each image builds
  the whole monorepo.
- The code pushed to GitHub (`vkraftproducts/healthuk`) on the branch you want to deploy, including
  `docker-compose.coolify.yml`, `deploy/setup.Dockerfile`, `apps/web/Dockerfile` and
  `apps/web/nginx.conf`.
- Coolify connected to GitHub: **Sources → GitHub App** (private repo), or use the public
  repository option if the repo is public.

## Steps in the Coolify UI

1. **Projects → + Add** a project, for example `Exora Healthcare Hub`, and open its
   `production` environment.
2. **+ New → Private Repository (with GitHub App)**. Pick `vkraftproducts/healthuk` and the
   branch.
3. Set **Build Pack** to **Docker Compose**.
   - **Base Directory:** `/healthcare-hub`
   - **Docker Compose Location:** `/docker-compose.coolify.yml`

   Then **Continue**. Coolify reads the file and lists the five services.

4. **Domains.** Open the `web` service settings. Coolify fills in an sslip.io address such as
   `http://web-abc123.203.0.113.10.sslip.io`. Leave it, or replace it with your own domain later
   (see below). The other services need no domain.
5. **Environment Variables.** Coolify generates the `SERVICE_PASSWORD_*` values and
   `SERVICE_URL_WEB` itself. You can optionally set:

   | Variable              | Default                   | Meaning                                |
   | --------------------- | ------------------------- | -------------------------------------- |
   | `SEED_LOCAL_PASSWORD` | `Hub-Dev-Password-2026!`  | Password for every seeded demo user    |
   | `DEV_DISABLE_MFA`     | `true`                    | `false` to require authenticator codes |

   The seed password applies only when a user is first created. Changing it later does not change
   existing passwords.

6. **Deploy.** The first build takes several minutes. Watch **Logs**: `setup` should end with
   `seeded mock dental practice and mock care home`, then `api` turns healthy and `web` starts.
7. Open the `web` URL and sign in, for example `manager@example.test` / `Hub-Dev-Password-2026!`.

## Checking it

- `https://<your-web-url>/readyz` returns `{"status":"ready"}`.
- The sign-in page shows the Healthcare Hub by Vkraft logo and a username and password form.
- After sign-in the header reads `Exora International Ltd / London / Ambulance service`.

## Using your own domain later

1. Point a DNS `A` record at the VM's IP.
2. In Coolify, set the `web` service domain to `https://hub.example.com` and redeploy. Coolify
   issues the certificate. `SERVICE_URL_WEB` follows the domain, so `WEB_ORIGIN` and
   `PUBLIC_API_URL` update by themselves, and the sign-in cookie becomes `Secure` over https.

## Updating

Push to the branch, then **Redeploy** in Coolify (or turn on automatic deploys under the
resource's **Webhooks**). `setup` runs again and applies any new migrations. The seed never
overwrites existing data.

## Troubleshooting

- **Sign-in fails with "Not permitted" or a cross-origin error:** the browser URL must match
  `SERVICE_URL_WEB` exactly (scheme and host). Redeploy after changing the domain.
- **`setup` failed:** open its logs. A database password error after you changed a generated
  password means the volume still has the old one. Restore the old value, or delete the
  `pgdata` volume to start again (this deletes all data).
- **Everyone is signed out after a redeploy:** expected. The demo API makes a new signing key on
  each start. Set `LOCAL_AUTH_PRIVATE_KEY` (PKCS#8 PEM) on the `api` service to keep sessions.
- **Escalation emails:** the demo records them in the outbox only. To send real mail, set
  `EMAIL_TRANSPORT=smtp`, `SMTP_URL` and `EMAIL_FROM` on the `worker` service.

## Not included

- The extra demo records from `pnpm demo:data` (jobs, incidents, evidence). That script needs the
  mock sign-in server and a local API, so it does not run here.
- Backups. Use Coolify's scheduled backups for the `postgres` service, or `pg_dump` from the VM.
- A production setup. Production needs `NODE_ENV=production`, MFA on, real secrets
  (`IP_HASH_SECRET`, `BLOB_SIGNING_SECRET`, `FIELD_ENCRYPTION_KEY`, `LOCAL_AUTH_PRIVATE_KEY`) and
  no seeded passwords. The API refuses to start in production without them.
