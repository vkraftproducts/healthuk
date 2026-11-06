import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { bootstrap, migrate, seed, SEED_IDS } from '@hub/db/admin';

declare module 'vitest' {
  export interface ProvidedContext {
    urls: { superuser: string; admin: string; app: string };
  }
}

/** Test-only ORG_ADMIN (dev|admin): the dev seed has no user with this role. */
async function addOrgAdmin(adminUrl: string): Promise<void> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.org_id', $1, true)`, [SEED_IDS.orgExample]);
    await c.query(
      `INSERT INTO app_user (id, idp_subject, email, display_name, status)
       VALUES ('01900000-0000-7000-8000-000000000106', 'dev|admin', 'admin@example.test', 'Test Org Admin', 'ACTIVE')`,
    );
    await c.query(
      `INSERT INTO membership (organisation_id, user_id, role_id, valid_from)
       SELECT $1, '01900000-0000-7000-8000-000000000106', id, now() - interval '1 day'
         FROM role WHERE organisation_id IS NULL AND key = 'ORG_ADMIN'`,
      [SEED_IDS.orgExample],
    );
    await c.query('COMMIT');
  } finally {
    await c.end();
  }
}

/**
 * Creates a fresh database for the run (no shared state between runs).
 * CI provides a postgres:16 service; locally use docker compose or any Postgres 16.
 * Override with TEST_SUPERUSER_URL.
 */
export default async function setup(project: TestProject) {
  const base =
    process.env.TEST_SUPERUSER_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres';
  const dbName = `hub_test_${process.pid}_${Date.now()}`;
  const u = new URL(base);
  const mk = (user: string, pw: string, db: string) => `postgresql://${user}:${pw}@${u.host}/${db}`;
  // Roles are cluster-wide: use the same passwords as .env.example so running the tests never
  // locks a local `pnpm dev` out of its own database.
  const urls = {
    superuser: mk(decodeURIComponent(u.username), decodeURIComponent(u.password), dbName),
    admin: mk('hub_migrator', 'hub_migrator_dev', dbName),
    app: mk('hub_app', 'hub_app_dev', dbName),
  };
  await bootstrap({ superuserUrl: base, adminUrl: urls.admin, appUrl: urls.app });
  await migrate(urls.admin);
  await seed(urls.admin);
  await addOrgAdmin(urls.admin);
  project.provide('urls', urls);
  return async () => {
    const c = new pg.Client({ connectionString: base });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await c.end();
  };
}
