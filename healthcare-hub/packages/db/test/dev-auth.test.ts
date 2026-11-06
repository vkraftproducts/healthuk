import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import {
  checkDevLogin,
  ensureDevAuth,
  hashPassword,
  setDevPassword,
  verifyPassword,
} from '../src/admin/dev-auth.js';

const urls = inject('urls');
let admin: pg.Client;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: urls.admin });
  await admin.connect();
  await ensureDevAuth(admin);
  await setDevPassword(admin, 'tester', 'dev|tester', 'correct horse battery');
});
afterAll(async () => admin.end());

describe('development passwords', () => {
  it('stores only a salted hash, which verifies the right password and nothing else', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).not.toContain('correct');
    expect(a).not.toBe(b); // salted
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('correct horse batterY', a)).toBe(false);
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
  });

  it('refuses passwords too short to be worth having', async () => {
    await expect(setDevPassword(admin, 'tester', 'dev|tester', 'short')).rejects.toThrow(/12/);
  });

  it('signs in with the right username and password, and nothing else', async () => {
    expect(await checkDevLogin(admin, 'tester', 'correct horse battery')).toEqual({
      ok: true,
      subject: 'dev|tester',
    });
    expect(await checkDevLogin(admin, 'TESTER ', 'correct horse battery')).toMatchObject({
      ok: true,
    });
    expect(await checkDevLogin(admin, 'tester', 'wrong password!')).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(await checkDevLogin(admin, 'nobody', 'correct horse battery')).toEqual({
      ok: false,
      reason: 'invalid', // same answer as a wrong password: usernames are not revealed
    });
  });

  it('locks the account after five wrong passwords, even for the right one, then unlocks', async () => {
    await setDevPassword(admin, 'locky', 'dev|locky', 'correct horse battery');
    const now = new Date('2026-11-06T10:00:00Z');
    for (let i = 0; i < 5; i++) await checkDevLogin(admin, 'locky', 'wrong password!', now);
    expect(await checkDevLogin(admin, 'locky', 'correct horse battery', now)).toEqual({
      ok: false,
      reason: 'locked',
    });
    const later = new Date(now.getTime() + 16 * 60_000);
    expect(await checkDevLogin(admin, 'locky', 'correct horse battery', later)).toMatchObject({
      ok: true,
    });
  });

  it('is out of reach of the application role', async () => {
    const app = new pg.Client({ connectionString: urls.app });
    await app.connect();
    await expect(app.query('SELECT * FROM dev_auth.credential')).rejects.toThrow(
      /permission denied/,
    );
    await app.end();
  });
});
