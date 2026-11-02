// Creates roles and the database (idempotent). Run once per environment as a superuser/admin.
//   DATABASE_SUPERUSER_URL  admin connection (default: local docker postgres)
//   DATABASE_ADMIN_URL      migrator connection (role + db name are taken from it)
//   DATABASE_URL            app connection (role + password are taken from it)
import pg from 'pg';

export async function bootstrap(opts: {
  superuserUrl: string;
  adminUrl: string;
  appUrl: string;
}): Promise<void> {
  const admin = new URL(opts.adminUrl);
  const app = new URL(opts.appUrl);
  const dbName = admin.pathname.slice(1);
  const migratorRole = decodeURIComponent(admin.username);
  const appRole = decodeURIComponent(app.username);
  const ident = /^[a-z_][a-z0-9_]*$/;
  if (![dbName, migratorRole, appRole].every((v) => ident.test(v))) {
    throw new Error('Role and database names must match ^[a-z_][a-z0-9_]*$');
  }
  const client = new pg.Client({ connectionString: opts.superuserUrl });
  await client.connect();
  try {
    const q = (s: string) => client.query(s);
    const lit = (v: string) => client.escapeLiteral(v);
    for (const [role, pw] of [
      [migratorRole, decodeURIComponent(admin.password)],
      [appRole, decodeURIComponent(app.password)],
    ] as const) {
      const exists = await client.query('select 1 from pg_roles where rolname = $1', [role]);
      const attrs = 'LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE';
      await q(
        exists.rowCount
          ? `ALTER ROLE ${role} ${attrs} PASSWORD ${lit(pw)}`
          : `CREATE ROLE ${role} ${attrs} PASSWORD ${lit(pw)}`,
      );
    }
    const db = await client.query('select 1 from pg_database where datname = $1', [dbName]);
    if (!db.rowCount) await q(`CREATE DATABASE ${dbName} OWNER ${migratorRole}`);
    await q(`REVOKE ALL ON DATABASE ${dbName} FROM PUBLIC`);
    await q(`GRANT CONNECT ON DATABASE ${dbName} TO ${appRole}`);
  } finally {
    await client.end();
  }
  // Schema-level setup inside the target database.
  const inDb = new pg.Client({
    connectionString: opts.superuserUrl.replace(/\/[^/]*$/, `/${dbName}`),
  });
  await inDb.connect();
  try {
    await inDb.query(`ALTER SCHEMA public OWNER TO ${migratorRole}`);
    await inDb.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await inDb.query(`GRANT ALL ON SCHEMA public TO ${migratorRole}`);
    await inDb.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
    await inDb.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  } finally {
    await inDb.end();
  }
}
