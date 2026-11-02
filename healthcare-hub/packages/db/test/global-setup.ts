import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { bootstrap } from '../src/admin/bootstrap.js';
import { migrate } from '../src/admin/migrate.js';

declare module 'vitest' {
  export interface ProvidedContext {
    urls: { superuser: string; admin: string; app: string };
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
  project.provide('urls', urls);
  return async () => {
    const c = new pg.Client({ connectionString: base });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await c.end();
  };
}
