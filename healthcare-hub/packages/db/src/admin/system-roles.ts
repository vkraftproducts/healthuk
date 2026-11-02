import pg from 'pg';
import { PERMISSIONS, SYSTEM_ROLES } from '@hub/contracts';

/**
 * Idempotently syncs the permission catalogue and system roles from @hub/contracts (the single
 * source of truth) into the database. Runs as the table owner after migrations. System roles
 * (organisation_id IS NULL, is_system) are never writable through the application role.
 */
export async function syncSystemRoles(adminUrl: string): Promise<void> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    // System rows have no organisation, so the owner needs RLS off for this one transaction.
    await c.query('ALTER TABLE role NO FORCE ROW LEVEL SECURITY');
    await c.query('ALTER TABLE role_permission NO FORCE ROW LEVEL SECURITY');
    for (const [key, description] of Object.entries(PERMISSIONS)) {
      await c.query(
        `INSERT INTO permission (key, description) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description`,
        [key, description],
      );
    }
    for (const role of SYSTEM_ROLES) {
      const found = await c.query(
        'SELECT id FROM role WHERE organisation_id IS NULL AND key = $1',
        [role.key],
      );
      let id: string;
      if (found.rowCount) {
        id = found.rows[0].id as string;
        await c.query('UPDATE role SET name = $2, is_system = true WHERE id = $1', [id, role.name]);
      } else {
        id = (
          await c.query(
            `INSERT INTO role (organisation_id, key, name, is_system) VALUES (NULL, $1, $2, true) RETURNING id`,
            [role.key, role.name],
          )
        ).rows[0].id as string;
      }
      await c.query(
        'DELETE FROM role_permission WHERE role_id = $1 AND NOT (permission_key = ANY($2::text[]))',
        [id, role.permissions],
      );
      await c.query(
        `INSERT INTO role_permission (role_id, permission_key)
         SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
        [id, role.permissions],
      );
    }
    await c.query('ALTER TABLE role FORCE ROW LEVEL SECURITY');
    await c.query('ALTER TABLE role_permission FORCE ROW LEVEL SECURITY');
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}
