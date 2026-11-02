import { SYSTEM_USER_ID, type Db, type TenantTx } from '@hub/db';
import {
  breachClock,
  DEFAULT_RETENTION,
  retentionCutoff,
  startOfLondonDay,
  type RetentionCategory,
} from '@hub/rules';
import { strToU8, zipSync } from 'fflate';
import type { BlobStore } from './storage.js';

/**
 * Retention, legal hold, breach clock and subject access export (SECURITY_COMPLIANCE §4).
 * Nothing is acted on until a rule is approved; only patient contact details are ever changed
 * automatically (anonymised), everything else is listed for a person to review.
 */
const RETENTION_PERMS = ['jobs.patient.view', 'events.safeguarding.view', 'privacy.manage'];
const sys = (orgId: string) => ({ orgId, userId: SYSTEM_USER_ID, permissions: RETENTION_PERMS });

/** Placeholder rules (requiring approval) for any category the organisation has not set. */
export async function ensureRetentionDefaults(tx: TenantTx, orgId: string): Promise<void> {
  const have = new Set(
    (await tx.retentionRule.findMany({ select: { category: true } })).map((r) => r.category),
  );
  const missing = DEFAULT_RETENTION.filter((d) => !have.has(d.category));
  if (missing.length)
    await tx.retentionRule.createMany({
      data: missing.map((d) => ({ organisationId: orgId, action: 'REVIEW', ...d })),
      skipDuplicates: true,
    });
}

/** How many records are past the cutoff for a category, and how many of those are under hold. */
export async function retentionCandidates(
  tx: TenantTx,
  category: RetentionCategory,
  cutoffIso: string,
): Promise<{ candidates: number; held: number }> {
  const cutoff = startOfLondonDay(cutoffIso);
  const holds = await tx.legalHold.findMany({ where: { releasedAt: null } });
  const orgHold = holds.some((h) => h.scopeType === 'ORGANISATION');
  const heldIds = (t: string) => holds.filter((h) => h.scopeType === t).map((h) => h.scopeId!);
  let candidates = 0;
  let held = 0;
  switch (category) {
    case 'PATIENT_CONTACT': {
      const where = {
        job: { journeyDate: { lt: cutoff } },
        NOT: { name: '[removed under retention]' },
      };
      candidates = await tx.patientContact.count({ where });
      held = await tx.patientContact.count({ where: { ...where, jobId: { in: heldIds('JOB') } } });
      break;
    }
    case 'JOB_RECORDS':
      candidates = await tx.job.count({ where: { journeyDate: { lt: cutoff } } });
      held = await tx.job.count({
        where: { journeyDate: { lt: cutoff }, id: { in: heldIds('JOB') } },
      });
      break;
    case 'STAFF_HR_RECORDS': {
      const left = await tx.staffLifecycleEvent.findMany({
        where: { toState: 'LEAVER', at: { lt: cutoff }, staff: { lifecycleState: 'LEAVER' } },
        select: { staffId: true },
      });
      const ids = [...new Set(left.map((l) => l.staffId))];
      candidates = ids.length;
      held = ids.filter((i) => heldIds('STAFF').includes(i)).length;
      break;
    }
    case 'DBS_RECORDS':
      candidates = await tx.staffRecord.count({
        where: { kind: 'DBS', createdAt: { lt: cutoff } },
      });
      break;
    case 'EVENT_RECORDS':
      candidates = await tx.event.count({
        where: {
          occurredAt: { lt: cutoff },
          NOT: { types: { hasSome: ['COMPLAINT', 'SAFEGUARDING'] } },
        },
      });
      break;
    case 'COMPLAINTS':
      candidates = await tx.complaintDetail.count({ where: { receivedOn: { lt: cutoff } } });
      break;
    case 'SAFEGUARDING':
      candidates = await tx.event.count({
        where: { occurredAt: { lt: cutoff }, types: { has: 'SAFEGUARDING' } },
      });
      break;
    case 'AUDIT_RECORDS':
      candidates = await tx.auditRun.count({ where: { dueDate: { lt: cutoff } } });
      break;
    case 'AUDIT_LOG':
      candidates = await tx.auditLog.count({ where: { occurredAt: { lt: cutoff } } });
      break;
  }
  return { candidates, held: orgHold ? candidates : held };
}

/**
 * Daily worker job. Approved ANONYMISE rules blank patient contact details past the cutoff (not
 * under hold); approved REVIEW rules raise one alert per category for a person to act on.
 * Every run with something to do is written to the immutable retention log.
 */
export async function runRetention(
  db: Db,
  now: Date,
): Promise<{ anonymised: number; reviewAlerts: number }> {
  let anonymised = 0;
  let reviewAlerts = 0;
  for (const orgId of await db.listOrganisations()) {
    await db.withTenant(sys(orgId), async (tx) => {
      const rules = await tx.retentionRule.findMany({ where: { status: 'APPROVED' } });
      for (const r of rules) {
        const cutoff = retentionCutoff(now, r.retainMonths);
        const c = await retentionCandidates(tx, r.category as RetentionCategory, cutoff);
        let affected = 0;
        if (r.action === 'ANONYMISE' && r.category === 'PATIENT_CONTACT' && c.candidates > c.held) {
          const rows = await tx.$queryRaw<
            { n: number }[]
          >`SELECT retention_anonymise_patient_contacts(${cutoff}::date) AS n`;
          affected = Number(rows[0]?.n ?? 0);
          anonymised += affected;
        }
        const open = await tx.alert.findFirst({
          where: { sourceType: 'RETENTION', sourceId: r.id, state: { not: 'RESOLVED' } },
        });
        const due = r.action === 'REVIEW' ? c.candidates - c.held : 0;
        if (due > 0 && !open) {
          await tx.alert.create({
            data: {
              organisationId: orgId,
              sourceType: 'RETENTION',
              sourceId: r.id,
              severity: 'MEDIUM',
              reasonCode: 'RETENTION_REVIEW',
              reasonText: `${due} ${r.category.toLowerCase().replace(/_/g, ' ')} past retention: review`,
            },
          });
          reviewAlerts += 1;
        } else if (due === 0 && open)
          await tx.alert.update({
            where: { id: open.id },
            data: { state: 'RESOLVED', resolvedAt: now },
          });
        if (c.candidates > 0 || affected > 0)
          await tx.retentionLog.create({
            data: {
              organisationId: orgId,
              ruleId: r.id,
              category: r.category,
              action: r.action,
              cutoff: startOfLondonDay(cutoff),
              candidates: c.candidates,
              affected,
              held: c.held,
            },
          });
      }
    });
  }
  return { anonymised, reviewAlerts };
}

/** Keeps one alert per open breach in step with the 72-hour ICO clock. No personal data in the text. */
export async function breachClockAlerts(db: Db, now: Date): Promise<number> {
  let changed = 0;
  for (const orgId of await db.listOrganisations()) {
    await db.withTenant(sys(orgId), async (tx) => {
      const open = await tx.breachRecord.findMany({
        where: { status: { in: ['OPEN', 'ASSESSED'] } },
      });
      for (const b of open) {
        const clock = breachClock({ ...b, now });
        const alert = await tx.alert.findFirst({
          where: { sourceType: 'BREACH', sourceId: b.id, state: { not: 'RESOLVED' } },
        });
        const severity = clock.state === 'OVERDUE' ? 'CRITICAL' : 'HIGH';
        const text =
          clock.state === 'OVERDUE'
            ? `${b.code}: ICO notification deadline passed – decide and report, recording the reasons for delay`
            : `${b.code}: ICO notification decision due within ${Math.max(clock.hoursLeft, 0)} hours`;
        if (clock.state === 'DUE_SOON' || clock.state === 'OVERDUE') {
          if (!alert) {
            await tx.alert.create({
              data: {
                organisationId: orgId,
                sourceType: 'BREACH',
                sourceId: b.id,
                severity,
                reasonCode: `BREACH_${clock.state}`,
                reasonText: text,
              },
            });
            changed += 1;
          } else if (alert.reasonCode !== `BREACH_${clock.state}`) {
            await tx.alert.update({
              where: { id: alert.id },
              data: {
                severity,
                reasonCode: `BREACH_${clock.state}`,
                reasonText: text,
                state: 'OPEN',
                snoozedUntil: null,
              },
            });
            changed += 1;
          }
        } else if (alert) {
          await tx.alert.update({
            where: { id: alert.id },
            data: { state: 'RESOLVED', resolvedAt: now },
          });
          changed += 1;
        }
      }
      // Reported, not reportable or closed breaches resolve their alerts.
      const done = await tx.breachRecord.findMany({
        where: { OR: [{ status: { in: ['REPORTED', 'CLOSED'] } }, { icoReportable: false }] },
        select: { id: true },
      });
      await tx.alert.updateMany({
        where: {
          sourceType: 'BREACH',
          sourceId: { in: done.map((d) => d.id) },
          state: { not: 'RESOLVED' },
        },
        data: { state: 'RESOLVED', resolvedAt: now },
      });
    });
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Subject access export: everything held about one person, built for the requester.
// ---------------------------------------------------------------------------
const replacer = (k: string, v: unknown) =>
  k === 'blobKey' || k === 'pushToken' || k === 'idpSubject'
    ? undefined
    : typeof v === 'bigint'
      ? v.toString()
      : v;
const json = (v: unknown) => strToU8(JSON.stringify(v, replacer, 2));

export async function buildSubjectAccessExport(
  tx: TenantTx,
  p: { requestId: string },
  store: BlobStore,
  now: Date,
): Promise<{ zip: Uint8Array; files: number }> {
  const r = await tx.subjectRequest.findUniqueOrThrow({ where: { id: p.requestId } });
  const files: Record<string, Uint8Array> = {};
  if (r.subjectType === 'STAFF' && r.staffId) {
    const staff = await tx.staff.findUniqueOrThrow({ where: { id: r.staffId } });
    files['staff.json'] = json(staff);
    files['lifecycle.json'] = json(
      await tx.staffLifecycleEvent.findMany({ where: { staffId: staff.id } }),
    );
    files['role-approvals.json'] = json(
      await tx.staffRoleApproval.findMany({ where: { staffId: staff.id } }),
    );
    files['restrictions.json'] = json(
      await tx.staffRestriction.findMany({ where: { staffId: staff.id } }),
    );
    files['records.json'] = json(await tx.staffRecord.findMany({ where: { staffId: staff.id } }));
    const reqs = await tx.requirementInstance.findMany({
      where: { subjectType: 'STAFF', subjectId: staff.id },
    });
    files['requirements.json'] = json(reqs);
    files['shifts.json'] = json(await tx.crewAssignment.findMany({ where: { staffId: staff.id } }));
    const links = await tx.evidenceLink.findMany({
      where: { instanceId: { in: reqs.map((q) => q.id) } },
    });
    const versions = await tx.evidenceVersion.findMany({
      where: {
        scanStatus: 'CLEAN',
        OR: [
          { itemId: { in: links.map((l) => l.itemId) } },
          ...(staff.userId ? [{ uploadedBy: staff.userId }] : []),
        ],
      },
    });
    files['evidence.json'] = json(versions);
    for (const v of versions) {
      const bytes = await store.get(v.blobKey);
      if (bytes) files[`evidence/${v.id}`] = new Uint8Array(bytes);
    }
    if (staff.userId) {
      files['policy-acknowledgements.json'] = json(
        await tx.policyAcknowledgement.findMany({ where: { userId: staff.userId } }),
      );
      files['audit-log.json'] = json(
        await tx.auditLog.findMany({
          where: { OR: [{ actorUserId: staff.userId }, { entityId: staff.id }] },
          take: 20000,
        }),
      );
    }
  } else if (r.subjectType === 'PATIENT' && r.patientRef) {
    const jobs = await tx.job.findMany({ where: { patientRef: r.patientRef } });
    files['journeys.json'] = json(jobs);
    files['patient-contacts.json'] = json(
      await tx.patientContact.findMany({ where: { jobId: { in: jobs.map((j) => j.id) } } }),
    );
    files['journey-status.json'] = json(
      await tx.jobStatusEvent.findMany({ where: { jobId: { in: jobs.map((j) => j.id) } } }),
    );
    files['bookings.json'] = json(
      await tx.booking.findMany({ where: { id: { in: jobs.map((j) => j.bookingId) } } }),
    );
  }
  files['README.txt'] = strToU8(
    [
      `Subject access export for request ${r.code}`,
      `Generated ${now.toISOString()} (UK GDPR Art 15).`,
      'Review before release: remove information about other people where required, and record',
      'the release in the disclosure log. Fields encrypted at rest are exported as stored.',
    ].join('\n'),
  );
  return { zip: zipSync(files, { level: 6 }), files: Object.keys(files).length };
}
