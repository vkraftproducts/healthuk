import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb, type Db } from '../src/index.js';
import { seedTwoOrgs, type Ids } from './helpers.js';

const urls = inject('urls');
let db: Db;
let ids: Ids;
beforeAll(async () => {
  ids = await seedTwoOrgs(urls.admin);
  db = createDb(urls.app);
});
afterAll(async () => db.close());

const ctxA = () => ({ orgId: ids.orgA, userId: ids.userA });
const ctxB = () => ({ orgId: ids.orgB, userId: ids.userB });
let n = 0;
const code = () => `T-${Date.now().toString(36).toUpperCase()}${n++}`;

async function makeVersion(org: string, user: string, over: Record<string, unknown> = {}) {
  return db.withTenant({ orgId: org, userId: user }, async (tx) => {
    const t = await tx.requirementTemplate.create({
      data: { organisationId: org, code: code(), title: 'Driving licence', createdBy: user },
    });
    const v = await tx.requirementTemplateVersion.create({
      data: {
        organisationId: org,
        templateId: t.id,
        version: 1,
        basisType: 'STATUTORY',
        subjectType: 'STAFF',
        recurrence: { type: 'COMPLETION_BASED', interval: { unit: 'YEARS', every: 1 } },
        blocking: 'STATUTORY',
        deadlineKind: 'EXPIRY',
        createdBy: user,
        ...over,
      },
    });
    return { t, v };
  });
}

describe('requirement templates', () => {
  it('library rows (no organisation) are visible to every organisation but cannot be created by the app', async () => {
    const lib = await db.withTenant(ctxA(), (tx) =>
      tx.requirementTemplate.findMany({ where: { organisationId: null } }),
    );
    expect(Array.isArray(lib)).toBe(true);
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.requirementTemplate.create({ data: { organisationId: null, code: code(), title: 'x' } }),
      ),
    ).rejects.toThrow();
  });

  it('a draft can be edited; publishing needs a different approver (four-eyes)', async () => {
    const { v } = await makeVersion(ids.orgA, ids.userA);
    await db.withTenant(ctxA(), (tx) =>
      tx.requirementTemplateVersion.update({
        where: { id: v.id },
        data: { regulationRef: 'Reg 12' },
      }),
    );
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.requirementTemplateVersion.update({
          where: { id: v.id },
          data: { status: 'EFFECTIVE', approvedBy: ids.userA, approvedAt: new Date() },
        }),
      ),
    ).rejects.toThrow(/approver must be different/);
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.requirementTemplateVersion.update({
          where: { id: v.id },
          data: { status: 'EFFECTIVE' },
        }),
      ),
    ).rejects.toThrow(/needs an approver/);
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.requirementTemplateVersion.update({
          where: { id: v.id },
          data: {
            status: 'EFFECTIVE',
            approvedBy: ids.userB,
            approvedAt: new Date(),
            blocking: 'NONE',
          },
        }),
      ),
    ).rejects.toThrow(/Content cannot change while publishing/);
    const pub = await db.withTenant(ctxA(), (tx) =>
      tx.requirementTemplateVersion.update({
        where: { id: v.id },
        data: { status: 'EFFECTIVE', approvedBy: ids.userB, approvedAt: new Date() },
      }),
    );
    expect(pub.status).toBe('EFFECTIVE');
  });

  it('a published version is immutable and cannot be deleted; only the lifecycle moves forward', async () => {
    const { v } = await makeVersion(ids.orgA, ids.userA);
    await db.withTenant(ctxA(), (tx) =>
      tx.requirementTemplateVersion.update({
        where: { id: v.id },
        data: { status: 'EFFECTIVE', approvedBy: ids.userB, approvedAt: new Date() },
      }),
    );
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.requirementTemplateVersion.update({ where: { id: v.id }, data: { blocking: 'NONE' } }),
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.withTenant(ctxA(), (tx) => tx.requirementTemplateVersion.delete({ where: { id: v.id } })),
    ).rejects.toThrow(/cannot be deleted/);
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.requirementTemplateVersion.update({ where: { id: v.id }, data: { status: 'DRAFT' } }),
      ),
    ).rejects.toThrow(/Invalid requirement version status/);
    const sup = await db.withTenant(ctxA(), (tx) =>
      tx.requirementTemplateVersion.update({ where: { id: v.id }, data: { status: 'SUPERSEDED' } }),
    );
    expect(sup.status).toBe('SUPERSEDED');
  });

  it('only one EFFECTIVE version per template', async () => {
    const { t, v } = await makeVersion(ids.orgA, ids.userA);
    await db.withTenant(ctxA(), (tx) =>
      tx.requirementTemplateVersion.update({
        where: { id: v.id },
        data: { status: 'EFFECTIVE', approvedBy: ids.userB, approvedAt: new Date() },
      }),
    );
    await expect(
      db.withTenant(ctxA(), async (tx) => {
        const v2 = await tx.requirementTemplateVersion.create({
          data: {
            organisationId: ids.orgA,
            templateId: t.id,
            version: 2,
            basisType: 'STATUTORY',
            subjectType: 'STAFF',
            recurrence: {},
            createdBy: ids.userA,
          },
        });
        return tx.requirementTemplateVersion.update({
          where: { id: v2.id },
          data: { status: 'EFFECTIVE', approvedBy: ids.userB, approvedAt: new Date() },
        });
      }),
    ).rejects.toThrow();
  });

  it('is isolated between organisations', async () => {
    const { t } = await makeVersion(ids.orgA, ids.userA);
    expect(
      await db.withTenant(ctxB(), (tx) =>
        tx.requirementTemplate.findUnique({ where: { id: t.id } }),
      ),
    ).toBeNull();
  });
});

describe('instances, applicability and due-date history', () => {
  async function instance() {
    const { t, v } = await makeVersion(ids.orgA, ids.userA);
    const i = await db.withTenant(ctxA(), (tx) =>
      tx.requirementInstance.create({
        data: {
          organisationId: ids.orgA,
          templateId: t.id,
          templateVersionId: v.id,
          subjectType: 'STAFF',
          subjectId: ids.userA,
        },
      }),
    );
    return { t, v, i };
  }

  it('rejects a version from another template, another organisation, or another subject type', async () => {
    const { t, i } = await instance();
    const other = await makeVersion(ids.orgA, ids.userA);
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.requirementInstance.create({
          data: {
            organisationId: ids.orgA,
            templateId: t.id,
            templateVersionId: other.v.id,
            subjectType: 'STAFF',
            subjectId: ids.userB,
          },
        }),
      ),
    ).rejects.toThrow(/does not belong to the template/);
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.requirementInstance.create({
          data: {
            organisationId: ids.orgA,
            templateId: t.id,
            templateVersionId: i.templateVersionId,
            subjectType: 'VEHICLE',
            subjectId: ids.userB,
          },
        }),
      ),
    ).rejects.toThrow(/Subject type/);
    const foreign = await makeVersion(ids.orgB, ids.userB);
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.requirementInstance.create({
          data: {
            organisationId: ids.orgA,
            templateId: foreign.t.id,
            templateVersionId: foreign.v.id,
            subjectType: 'STAFF',
            subjectId: ids.userB,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('one live instance per template and subject; instances are isolated per organisation', async () => {
    const { t, v, i } = await instance();
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.requirementInstance.create({
          data: {
            organisationId: ids.orgA,
            templateId: t.id,
            templateVersionId: v.id,
            subjectType: 'STAFF',
            subjectId: ids.userA,
          },
        }),
      ),
    ).rejects.toThrow();
    expect(
      await db.withTenant(ctxB(), (tx) =>
        tx.requirementInstance.findUnique({ where: { id: i.id } }),
      ),
    ).toBeNull();
    await expect(
      db.withTenant(ctxB(), (tx) =>
        tx.requirementInstance.create({
          data: {
            organisationId: ids.orgA,
            templateId: t.id,
            templateVersionId: v.id,
            subjectType: 'STAFF',
            subjectId: ids.userB,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('applicability decisions and due-date changes are append-only', async () => {
    const { i } = await instance();
    const d = await db.withTenant(ctxA(), (tx) =>
      tx.applicabilityDecision.create({
        data: {
          organisationId: ids.orgA,
          instanceId: i.id,
          decision: 'APPROVED_NOT_APPLICABLE',
          reason: 'No bariatric work is undertaken',
          reviewerId: ids.userA,
          reviewDate: new Date('2026-10-30'),
        },
      }),
    );
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.applicabilityDecision.update({
          where: { id: d.id },
          data: { reason: 'edited after the fact' },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.applicabilityDecision.create({
          data: {
            organisationId: ids.orgA,
            instanceId: i.id,
            decision: 'APPROVED_NOT_APPLICABLE',
            reason: 'short',
            reviewerId: ids.userA,
            reviewDate: new Date(),
          },
        }),
      ),
    ).rejects.toThrow();
    const c = await db.withTenant(ctxA(), (tx) =>
      tx.dueDateChange.create({
        data: {
          organisationId: ids.orgA,
          instanceId: i.id,
          field: 'DUE',
          newDate: new Date('2026-12-01'),
          reason: 'Training course rescheduled',
          approverId: ids.userA,
          createdBy: ids.userA,
        },
      }),
    );
    await expect(
      db.withTenant(ctxA(), (tx) => tx.dueDateChange.delete({ where: { id: c.id } })),
    ).rejects.toThrow();
  });
});

describe('evidence', () => {
  async function version() {
    const { t, v } = await makeVersion(ids.orgA, ids.userA);
    const i = await db.withTenant(ctxA(), (tx) =>
      tx.requirementInstance.create({
        data: {
          organisationId: ids.orgA,
          templateId: t.id,
          templateVersionId: v.id,
          subjectType: 'STAFF',
          subjectId: ids.userA,
        },
      }),
    );
    return db.withTenant(ctxA(), async (tx) => {
      const item = await tx.evidenceItem.create({
        data: { organisationId: ids.orgA, title: 'Licence scan', createdBy: ids.userA },
      });
      const ev = await tx.evidenceVersion.create({
        data: {
          organisationId: ids.orgA,
          itemId: item.id,
          blobKey: `${ids.orgA}/${item.id}/1`,
          declaredMime: 'application/pdf',
          declaredSize: 1000,
          uploadedBy: ids.userA,
        },
      });
      await tx.evidenceLink.create({
        data: { organisationId: ids.orgA, itemId: item.id, instanceId: i.id, createdBy: ids.userA },
      });
      return { item, ev, i };
    });
  }

  it('evidence versions are immutable except the scan outcome, which is recorded once', async () => {
    const { ev } = await version();
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.evidenceVersion.update({
          where: { id: ev.id },
          data: { validTo: new Date('2030-01-01') },
        }),
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.withTenant(ctxA(), (tx) => tx.evidenceVersion.delete({ where: { id: ev.id } })),
    ).rejects.toThrow();
    const scanned = await db.withTenant(ctxA(), (tx) =>
      tx.evidenceVersion.update({
        where: { id: ev.id },
        data: {
          scanStatus: 'CLEAN',
          scannedAt: new Date(),
          sha256: 'a'.repeat(64),
          sizeBytes: 1000n,
          mime: 'application/pdf',
          uploadedAt: new Date(),
        },
      }),
    );
    expect(scanned.scanStatus).toBe('CLEAN');
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.evidenceVersion.update({ where: { id: ev.id }, data: { scanStatus: 'MALICIOUS' } }),
      ),
    ).rejects.toThrow(/already recorded/);
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.evidenceVersion.update({ where: { id: ev.id }, data: { sha256: 'b'.repeat(64) } }),
      ),
    ).rejects.toThrow(/checksum/);
  });

  it('verification requires a clean scan and a reviewer who is not the uploader', async () => {
    const { ev } = await version();
    const data = {
      organisationId: ids.orgA,
      evidenceVersionId: ev.id,
      decision: 'ACCEPTED' as const,
      reviewerId: ids.userB,
    };
    await expect(db.withTenant(ctxA(), (tx) => tx.verification.create({ data }))).rejects.toThrow(
      /clean/,
    );
    await db.withTenant(ctxA(), (tx) =>
      tx.evidenceVersion.update({
        where: { id: ev.id },
        data: { scanStatus: 'CLEAN', scannedAt: new Date() },
      }),
    );
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.verification.create({ data: { ...data, reviewerId: ids.userA } }),
      ),
    ).rejects.toThrow(/cannot verify evidence you uploaded/);
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.verification.create({ data: { ...data, decision: 'REJECTED' } }),
      ),
    ).rejects.toThrow();
    const v = await db.withTenant(ctxA(), (tx) => tx.verification.create({ data }));
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.verification.update({
          where: { id: v.id },
          data: { decision: 'REJECTED', reason: 'changed my mind' },
        }),
      ),
    ).rejects.toThrow();
    await expect(db.withTenant(ctxA(), (tx) => tx.verification.create({ data }))).rejects.toThrow(); // one decision per version
  });

  it('cannot link evidence across organisations and is isolated', async () => {
    const { item, ev } = await version();
    expect(
      await db.withTenant(ctxB(), (tx) => tx.evidenceItem.findUnique({ where: { id: item.id } })),
    ).toBeNull();
    expect(
      await db.withTenant(ctxB(), (tx) => tx.evidenceVersion.findUnique({ where: { id: ev.id } })),
    ).toBeNull();
    const foreign = await makeVersion(ids.orgB, ids.userB);
    const fi = await db.withTenant(ctxB(), (tx) =>
      tx.requirementInstance.create({
        data: {
          organisationId: ids.orgB,
          templateId: foreign.t.id,
          templateVersionId: foreign.v.id,
          subjectType: 'STAFF',
          subjectId: ids.userB,
        },
      }),
    );
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.evidenceLink.create({
          data: {
            organisationId: ids.orgA,
            itemId: item.id,
            instanceId: fi.id,
            createdBy: ids.userA,
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('alerts and notifications', () => {
  it('allows one open alert per source and dedupes notifications by key', async () => {
    const src = ids.userA;
    const a = await db.withTenant(ctxA(), (tx) =>
      tx.alert.create({
        data: {
          organisationId: ids.orgA,
          sourceType: 'REQUIREMENT',
          sourceId: src,
          severity: 'HIGH',
          reasonCode: 'OVERDUE',
          reasonText: 'Overdue',
        },
      }),
    );
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.alert.create({
          data: {
            organisationId: ids.orgA,
            sourceType: 'REQUIREMENT',
            sourceId: src,
            severity: 'HIGH',
            reasonCode: 'OVERDUE',
            reasonText: 'Overdue',
          },
        }),
      ),
    ).rejects.toThrow();
    await db.withTenant(ctxA(), (tx) =>
      tx.alert.update({ where: { id: a.id }, data: { state: 'RESOLVED', resolvedAt: new Date() } }),
    );
    const again = await db.withTenant(ctxA(), (tx) =>
      tx.alert.create({
        data: {
          organisationId: ids.orgA,
          sourceType: 'REQUIREMENT',
          sourceId: src,
          severity: 'HIGH',
          reasonCode: 'OVERDUE',
          reasonText: 'Overdue',
        },
      }),
    );
    const n = {
      organisationId: ids.orgA,
      alertId: again.id,
      channel: 'EMAIL' as const,
      recipientUserId: ids.userA,
      dedupeKey: `${again.id}|EMAIL|2026-10-30`,
    };
    await db.withTenant(ctxA(), (tx) => tx.notificationDelivery.create({ data: n }));
    await expect(
      db.withTenant(ctxA(), (tx) => tx.notificationDelivery.create({ data: n })),
    ).rejects.toThrow();
    expect(
      await db.withTenant(ctxB(), (tx) => tx.alert.findUnique({ where: { id: again.id } })),
    ).toBeNull();
  });

  it('lets the worker list organisations without reading the organisation table', async () => {
    const rows = await db.withTenant(
      ctxA(),
      (tx) =>
        tx.$queryRaw<
          { worker_list_organisations: string }[]
        >`SELECT * FROM worker_list_organisations()`,
    );
    const listed = rows.map((r) => r.worker_list_organisations);
    expect(listed).toEqual(expect.arrayContaining([ids.orgA, ids.orgB]));
  });

  it('listOrganisations works with no tenant context, and hub_app still cannot read other organisations directly', async () => {
    expect(await db.listOrganisations()).toEqual(expect.arrayContaining([ids.orgA, ids.orgB]));
    // userB belongs only to org B (userA is deliberately a member of both, see helpers).
    const direct = await db.withTenant(ctxB(), (tx) =>
      tx.organisation.findMany({ select: { id: true } }),
    );
    expect(direct.map((o) => o.id)).toEqual([ids.orgB]);
  });
});
