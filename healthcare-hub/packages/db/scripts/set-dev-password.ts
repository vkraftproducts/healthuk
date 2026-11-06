/* eslint-disable no-console */
// DEV-ONLY: `pnpm dev:password <username>` sets a development account's password (and unlocks it).
// The new password comes from NEW_PASSWORD, or is asked for.
import { createInterface } from 'node:readline/promises';
import pg from 'pg';
import { ensureDevAuth, setDevPassword } from '../src/admin/index.js';

if (process.env.NODE_ENV === 'production') {
  console.error('development passwords must never be set in production');
  process.exit(1);
}
const url = process.env.DATABASE_ADMIN_URL;
const username = process.argv[2]?.trim().toLowerCase();
if (!url || !username) {
  console.error('Usage: pnpm dev:password <username>   (DATABASE_ADMIN_URL must be set)');
  process.exit(1);
}
const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  const subject = `dev|${username}`;
  const user = await c.query('SELECT 1 FROM app_user WHERE idp_subject = $1', [subject]);
  if (!user.rowCount) throw new Error(`There is no seeded account called "${username}"`);
  let password = process.env.NEW_PASSWORD;
  if (!password) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    password = await rl.question('New password (shown as you type; development only): ');
    rl.close();
  }
  await ensureDevAuth(c);
  await setDevPassword(c, username, subject, password);
  console.log(`Password set for ${username}.`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await c.end();
}
