import * as Crypto from 'expo-crypto';
import * as SQLite from 'expo-sqlite';
import type { OutboxItem } from '../core/outbox';
import type { LocalStore, SecureKv } from '../core/ports';
import { KEYS } from '../core/session';

const NAME = 'hub.db';

/**
 * Encrypted local database: expo-sqlite built with SQLCipher (app.config.ts plugin option), keyed
 * with 32 random bytes held in the secure store. Wiping deletes the file and the key.
 */
export function sqliteStore(kv: SecureKv): LocalStore {
  let db: Promise<SQLite.SQLiteDatabase> | null = null;
  const open = () =>
    (db ??= (async () => {
      let key = await kv.get(KEYS.dbKey);
      if (!key) {
        key = Array.from(Crypto.getRandomBytes(32), (b) => b.toString(16).padStart(2, '0')).join(
          '',
        );
        await kv.set(KEYS.dbKey, key);
      }
      const conn = await SQLite.openDatabaseAsync(NAME);
      await conn.execAsync(`PRAGMA key = "x'${key}'";`);
      await conn.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, until TEXT NOT NULL);
      `);
      return conn;
    })());
  return {
    async putOutbox(item: OutboxItem) {
      await (
        await open()
      ).runAsync('INSERT OR REPLACE INTO outbox (id, json) VALUES (?, ?)', [
        item.clientSubmissionId,
        JSON.stringify(item),
      ]);
    },
    async listOutbox() {
      const rows = await (await open()).getAllAsync<{ json: string }>('SELECT json FROM outbox');
      return rows.map((r) => JSON.parse(r.json) as OutboxItem);
    },
    async deleteOutbox(id) {
      await (await open()).runAsync('DELETE FROM outbox WHERE id = ?', [id]);
    },
    async getCache(key) {
      return (
        (await (
          await open()
        ).getFirstAsync<{ value: string; until: string }>(
          'SELECT value, until FROM cache WHERE key = ?',
          [key],
        )) ?? null
      );
    },
    async setCache(key, value, until) {
      await (
        await open()
      ).runAsync('INSERT OR REPLACE INTO cache (key, value, until) VALUES (?, ?, ?)', [
        key,
        value,
        until,
      ]);
    },
    async deleteCache(key) {
      await (await open()).runAsync('DELETE FROM cache WHERE key = ?', [key]);
    },
    async wipe() {
      if (db) {
        const conn = await db.catch(() => null);
        db = null;
        await conn?.closeAsync().catch(() => undefined);
      }
      await SQLite.deleteDatabaseAsync(NAME).catch(() => undefined);
      await kv.delete(KEYS.dbKey);
    },
  };
}
