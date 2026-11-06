// Forward-only SQL migration runner. Applied migrations are checksummed; editing an applied
// file fails the run. Each migration runs in its own transaction.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { syncSystemRoles } from './system-roles.js';

// src/admin and dist/admin are both two levels below the package root.
const dir = fileURLToPath(new URL('../../sql/migrations/', import.meta.url));

export async function migrate(adminUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migration (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map<string, string>(
      (await client.query('select name, checksum from schema_migration')).rows.map(
        (r: { name: string; checksum: string }) => [r.name, r.checksum],
      ),
    );
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const sql = readFileSync(dir + file, 'utf8');
      // Line endings differ between checkouts (Windows turns LF into CRLF), so the checksum is taken
      // over LF text. A checksum recorded from the raw text by an older runner is still accepted.
      const sha = (t: string) => createHash('sha256').update(t).digest('hex');
      const checksum = sha(sql.replace(/\r\n/g, '\n'));
      const prior = done.get(file);
      if (prior) {
        if (prior !== checksum && prior !== sha(sql)) {
          throw new Error(`Migration ${file} was modified after being applied (checksum mismatch)`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migration (name, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(e as Error).message}`, { cause: e });
      }
    }
  } finally {
    await client.end();
  }
  // Permission catalogue and system roles come from @hub/contracts (single source of truth).
  await syncSystemRoles(adminUrl);
  return applied;
}
