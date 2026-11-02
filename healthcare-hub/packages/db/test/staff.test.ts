import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb, type Db, type TenantTx } from '../src/index.js';
import { seedTwoOrgs, type Ids } from './helpers.js';

const urls = inject('urls');
let db: Db;
let ids: Ids;
beforeAll(async () => {
  ids = await seedTwoOrgs(urls.admin);
  db = createDb(urls.app);
});
afterAll(async () => db.close());

const SENSITIVE = 'staff.sensitive.view';
const ctxA = (o: { permissions?: string[]; locationIds?: string[] | null } = {}) => ({
  orgId: ids.orgA,
  userId: ids.userA,
  ...o,
});
let n = 1000;
const staffNo = () => `ST-${n++}`;

async function makeStaff(tx: TenantTx, location = ids.locA) {
  return tx.staff.create({
    data: {
      organisationId: ids.orgA,
      staffNo: staffNo(),
      displayName: 'Synthetic Person',
      primaryLocationId: location,
      createdBy: ids.userA,
    },
  });
}

describe('staff', () => {
  it('is isolated per organisation and needs a location in the same organisation', async () => {
    const s = await db.withTenant(ctxA(), (tx) => makeStaff(tx));
    const seen = await db.withTenant({ orgId: ids.orgB, userId: ids.userB }, (tx) =>
      tx.staff.findUnique({ where: { id: s.id } }),
    );
    expect(seen).toBeNull();
    await expect(db.withTenant(ctxA(), (tx) => makeStaff(tx, ids.locB))).rejects.toThrow();
  });

  it('location-scoped users only see staff at their locations', async () => {
    const s = await db.withTenant(ctxA(), (tx) => makeStaff(tx));
    const other = await db.withTenant(ctxA(), (tx) =>
      tx.location.create({ data: { organisationId: ids.orgA, name: 'Other base' } }),
    );
    const scoped = await db.withTenant(ctxA({ locationIds: [other.id] }), (tx) =>
      tx.staff.findUnique({ where: { id: s.id } }),
    );
    expect(scoped).toBeNull();
    const all = await db.withTenant(ctxA({ locationIds: [ids.locA] }), (tx) =>
      tx.staff.findUnique({ where: { id: s.id } }),
    );
    expect(all?.id).toBe(s.id);
  });

  it('lifecycle changes must be logged in the same transaction', async () => {
    const s = await db.withTenant(ctxA(), (tx) => makeStaff(tx));
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.staff.update({ where: { id: s.id }, data: { lifecycleState: 'ACTIVE' } }),
      ),
    ).rejects.toThrow(/logged/);
    const ok = await db.withTenant(ctxA(), async (tx) => {
      await tx.staffLifecycleEvent.create({
        data: {
          organisationId: ids.orgA,
          staffId: s.id,
          fromState: 'CANDIDATE',
          toState: 'CHECKS_IN_PROGRESS',
          reason: 'Offer accepted',
          actorUserId: ids.userA,
        },
      });
      return tx.staff.update({
        where: { id: s.id },
        data: { lifecycleState: 'CHECKS_IN_PROGRESS' },
      });
    });
    expect(ok.lifecycleState).toBe('CHECKS_IN_PROGRESS');
    expect(ok.version).toBe(2);
  });

  it('role approvals and restrictions can only be closed once and never edited or deleted', async () => {
    const s = await db.withTenant(ctxA(), (tx) => makeStaff(tx));
    const a = await db.withTenant(ctxA(), (tx) =>
      tx.staffRoleApproval.create({
        data: {
          organisationId: ids.orgA,
          staffId: s.id,
          role: 'DRIVER',
          reason: 'Licence checked',
          approvedBy: ids.userA,
        },
      }),
    );
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.staffRoleApproval.update({ where: { id: a.id }, data: { role: 'PARAMEDIC' } }),
      ),
    ).rejects.toThrow(/closed, not edited/);
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.staffRoleApproval.create({
          data: {
            organisationId: ids.orgA,
            staffId: s.id,
            role: 'DRIVER',
            reason: 'Twice',
            approvedBy: ids.userA,
          },
        }),
      ),
    ).rejects.toThrow(); // one active approval per role
    const close = { revokedAt: new Date(), revokedBy: ids.userA, revokeReason: 'Licence lapsed' };
    await db.withTenant(ctxA(), (tx) =>
      tx.staffRoleApproval.update({ where: { id: a.id }, data: close }),
    );
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.staffRoleApproval.update({
          where: { id: a.id },
          data: { ...close, revokeReason: 'Changed my mind' },
        }),
      ),
    ).rejects.toThrow(/already closed/);
    await expect(
      db.withTenant(ctxA(), (tx) => tx.staffRoleApproval.delete({ where: { id: a.id } })),
    ).rejects.toThrow();
  });
});

describe('staff records', () => {
  it('are immutable; corrections supersede a record of the same person and kind', async () => {
    const [s1, s2] = await db.withTenant(ctxA(), async (tx) => [
      await makeStaff(tx),
      await makeStaff(tx),
    ]);
    const base = { organisationId: ids.orgA, createdBy: ids.userA };
    const r = await db.withTenant(ctxA(), (tx) =>
      tx.staffRecord.create({
        data: { ...base, staffId: s1!.id, kind: 'TRAINING', data: { courseCode: 'MH-01' } },
      }),
    );
    expect(r.sensitive).toBe(false);
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.staffRecord.update({ where: { id: r.id }, data: { data: {} } }),
      ),
    ).rejects.toThrow();
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.staffRecord.create({
          data: { ...base, staffId: s2!.id, kind: 'TRAINING', data: {}, supersedesId: r.id },
        }),
      ),
    ).rejects.toThrow(/same staff member and kind/);
    const fixed = await db.withTenant(ctxA(), (tx) =>
      tx.staffRecord.create({
        data: {
          ...base,
          staffId: s1!.id,
          kind: 'TRAINING',
          data: { courseCode: 'MH-02' },
          supersedesId: r.id,
        },
      }),
    );
    expect(fixed.supersedesId).toBe(r.id);
  });

  it('sensitive kinds are invisible and unwritable without staff.sensitive.view', async () => {
    const s = await db.withTenant(ctxA(), (tx) => makeStaff(tx));
    const data = {
      organisationId: ids.orgA,
      createdBy: ids.userA,
      staffId: s.id,
      kind: 'DBS' as const,
      data: {},
    };
    await expect(db.withTenant(ctxA(), (tx) => tx.staffRecord.create({ data }))).rejects.toThrow();
    const r = await db.withTenant(ctxA({ permissions: [SENSITIVE] }), (tx) =>
      tx.staffRecord.create({ data }),
    );
    expect(r.sensitive).toBe(true);
    expect(
      await db.withTenant(ctxA(), (tx) => tx.staffRecord.findUnique({ where: { id: r.id } })),
    ).toBeNull();
    expect(
      (
        await db.withTenant(ctxA({ permissions: [SENSITIVE] }), (tx) =>
          tx.staffRecord.findUnique({ where: { id: r.id } }),
        )
      )?.id,
    ).toBe(r.id);
  });
});
