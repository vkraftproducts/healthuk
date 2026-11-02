import pg from 'pg';

export interface Ids {
  orgA: string;
  orgB: string;
  userA: string;
  userB: string;
  locA: string;
  locB: string;
  roleId: string;
  subjectA: string;
}

/** Runs SQL as the table owner (hub_migrator) with the given org context applied. */
export async function asOwner<T>(
  adminUrl: string,
  orgId: string | null,
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.org_id', $1, true)`, [orgId ?? '']);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } finally {
    await c.end();
  }
}

export async function seedTwoOrgs(adminUrl: string): Promise<Ids> {
  const ids = {} as Ids;
  const tag = Math.random().toString(36).slice(2, 10);
  ids.subjectA = `sub-a-${tag}`;
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  const one = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows[0];
  try {
    await c.query('BEGIN');
    // organisation rows are subject to FORCE RLS: set context to the id being created.
    const mkOrg = async (name: string) => {
      const id = (await one('SELECT uuid_generate_v7() AS id')).id as string;
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [id]);
      await c.query('INSERT INTO organisation (id, name) VALUES ($1, $2)', [id, name]);
      const loc = await one(
        `INSERT INTO location (organisation_id, name) VALUES ($1, $2) RETURNING id`,
        [id, `${name} base`],
      );
      return { id, loc: loc.id as string };
    };
    const a = await mkOrg('Org A');
    const b = await mkOrg('Org B');
    ids.orgA = a.id;
    ids.orgB = b.id;
    ids.locA = a.loc;
    ids.locB = b.loc;
    ids.userA = (
      await one(
        `INSERT INTO app_user (idp_subject, email, display_name, status)
         VALUES ($1,$2,'User A','ACTIVE') RETURNING id`,
        [ids.subjectA, `a-${tag}@example.test`],
      )
    ).id;
    ids.userB = (
      await one(
        `INSERT INTO app_user (idp_subject, email, display_name, status)
         VALUES ($1,$2,'User B','ACTIVE') RETURNING id`,
        [`sub-b-${tag}`, `b-${tag}@example.test`],
      )
    ).id;
    await c.query(`SELECT set_config('app.org_id', $1, true)`, [ids.orgA]);
    ids.roleId = (
      await one(
        `INSERT INTO role (organisation_id, key, name) VALUES ($1,'MANAGER','Manager') RETURNING id`,
        [ids.orgA],
      )
    ).id;
    await c.query(`INSERT INTO membership (organisation_id, user_id, role_id) VALUES ($1,$2,$3)`, [
      ids.orgA,
      ids.userA,
      ids.roleId,
    ]);
    await c.query(`SELECT set_config('app.org_id', $1, true)`, [ids.orgB]);
    const roleB = (
      await one(
        `INSERT INTO role (organisation_id, key, name) VALUES ($1,'MANAGER','Manager') RETURNING id`,
        [ids.orgB],
      )
    ).id;
    await c.query(`INSERT INTO membership (organisation_id, user_id, role_id) VALUES ($1,$2,$3)`, [
      ids.orgB,
      ids.userB,
      roleB,
    ]);
    // userA also belongs to org B (multi-organisation membership).
    await c.query(`INSERT INTO membership (organisation_id, user_id, role_id) VALUES ($1,$2,$3)`, [
      ids.orgB,
      ids.userA,
      roleB,
    ]);
    await c.query('COMMIT');
  } finally {
    await c.end();
  }
  return ids;
}
