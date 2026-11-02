import type { TenantTx } from '@hub/db';
import {
  addDays,
  deriveAlert,
  evaluateRequirement,
  londonDate,
  nextCompletionBased,
  nextFixedCalendar,
  type Blocking,
  type DeadlineKind,
  type Interval,
  type ISODate,
  type RequirementResult,
} from '@hub/rules';
import { deriveEvidenceInputs, type EvidenceVersionState } from './evidence-state.js';

const iso = (d: Date | null | undefined): ISODate | null =>
  d ? d.toISOString().slice(0, 10) : null;
const toDate = (d: ISODate): Date => new Date(`${d}T00:00:00.000Z`);

const instanceInclude = {
  templateVersion: true,
  links: { include: { item: { include: { versions: { include: { verification: true } } } } } },
} as const;

export interface RecomputeOutcome {
  instanceId: string;
  result: RequirementResult;
  changed: boolean;
}

/** Evaluates one instance against its evidence with the pure rules engine (no writes). */
export async function evaluateInstance(
  tx: TenantTx,
  instanceId: string,
  now: Date,
): Promise<RequirementResult> {
  return (await evaluateWithRow(tx, instanceId, now)).result;
}

/** Loads the evidence facts for one instance and evaluates it. */
async function evaluateWithRow(tx: TenantTx, instanceId: string, now: Date) {
  const row = await loadInstance(tx, instanceId);
  const tv = row.templateVersion;
  const states: EvidenceVersionState[] = row.links.flatMap((l) =>
    l.item.versions.map((v) => ({
      id: v.id,
      createdAt: v.createdAt,
      scanStatus: v.scanStatus,
      uploaded: v.uploadedAt !== null,
      decision: v.verification?.decision ?? null,
      decidedAt: v.verification?.createdAt ?? null,
      validFrom: iso(v.validFrom),
      validTo: iso(v.verification?.confirmedValidTo ?? v.validTo),
    })),
  );
  const ev = deriveEvidenceInputs(states);
  const kind = tv.deadlineKind as DeadlineKind;
  const date =
    kind === 'DUE'
      ? iso(row.dueDate)
      : kind === 'EXPIRY'
        ? iso(row.expiryDate)
        : iso(row.reviewDate);
  const result = evaluateRequirement(
    {
      applicability: row.applicability,
      criticalFailure: row.criticalFailure,
      deadline: date ? { kind, date } : null,
      verifiedEvidence: ev.verified
        ? { validFrom: ev.verified.validFrom, validTo: ev.verified.validTo }
        : null,
      pendingEvidence: ev.pending,
      dueSoonDays: tv.dueSoonDays,
      blocking: tv.blocking as Blocking,
    },
    now,
  );
  return { result, row, verified: ev.verified };
}

/** Live evaluation plus the current verified evidence window (used by readiness checks). */
export async function evaluateInstanceDetail(tx: TenantTx, instanceId: string, now: Date) {
  const { result, verified } = await evaluateWithRow(tx, instanceId, now);
  return { result, verified };
}

function loadInstance(tx: TenantTx, id: string) {
  return tx.requirementInstance.findUniqueOrThrow({ where: { id }, include: instanceInclude });
}

/**
 * Recomputes one instance, stores the derived status if it changed, and keeps its alert in step
 * (ALERT-03/04: alerts are derived, never authored). Safe to call repeatedly.
 */
export async function recomputeInstance(
  tx: TenantTx,
  instanceId: string,
  now: Date,
): Promise<RecomputeOutcome> {
  const { result, row } = await evaluateWithRow(tx, instanceId, now);
  const changed =
    row.status !== result.status ||
    row.reasonCode !== result.reasonCode ||
    row.reasonText !== result.reasonText ||
    row.effect !== result.effect ||
    row.currentlyVerified !== result.currentlyVerified;
  if (changed) {
    await tx.requirementInstance.update({
      where: { id: instanceId },
      data: {
        status: result.status,
        reasonCode: result.reasonCode,
        reasonText: result.reasonText,
        effect: result.effect,
        currentlyVerified: result.currentlyVerified,
        computedAt: now,
      },
    });
  }
  await syncAlert(tx, row.organisationId, row.id, row.ownerUserId, result, now);
  return { instanceId, result, changed };
}

async function syncAlert(
  tx: TenantTx,
  orgId: string,
  instanceId: string,
  ownerId: string | null,
  result: RequirementResult,
  now: Date,
): Promise<void> {
  const derived = deriveAlert(result, result.effect === 'BLOCK');
  const open = await tx.alert.findFirst({
    where: {
      organisationId: orgId,
      sourceType: 'REQUIREMENT',
      sourceId: instanceId,
      state: { not: 'RESOLVED' },
    },
  });
  if (!derived) {
    if (open)
      await tx.alert.update({
        where: { id: open.id },
        data: { state: 'RESOLVED', resolvedAt: now },
      });
    return;
  }
  if (!open) {
    await tx.alert.create({
      data: {
        organisationId: orgId,
        sourceType: 'REQUIREMENT',
        sourceId: instanceId,
        severity: derived.severity,
        reasonCode: derived.reasonCode,
        reasonText: derived.reasonText,
        ownerUserId: ownerId,
        raisedAt: now,
      },
    });
    return;
  }
  const same =
    open.severity === derived.severity &&
    open.reasonCode === derived.reasonCode &&
    open.reasonText === derived.reasonText &&
    open.ownerUserId === ownerId;
  if (same) return;
  // A new situation (different reason) reopens an acknowledged / snoozed alert; a mere text refresh does not.
  const reopen = open.reasonCode !== derived.reasonCode;
  await tx.alert.update({
    where: { id: open.id },
    data: {
      severity: derived.severity,
      reasonCode: derived.reasonCode,
      reasonText: derived.reasonText,
      ownerUserId: ownerId,
      ...(reopen
        ? { state: 'OPEN', snoozedUntil: null, acknowledgedAt: null, acknowledgedBy: null }
        : {}),
    },
  });
}

/** Recomputes every instance in the organisation (reconciler). */
export async function recomputeOrganisation(
  tx: TenantTx,
  now: Date,
): Promise<{ total: number; changed: number }> {
  const ids = await tx.requirementInstance.findMany({ select: { id: true } });
  let changed = 0;
  for (const { id } of ids) if ((await recomputeInstance(tx, id, now)).changed) changed += 1;
  return { total: ids.length, changed };
}

/** Recomputes all instances linked to an evidence item (after upload / scan / verification). */
export async function recomputeForEvidenceItem(
  tx: TenantTx,
  itemId: string,
  now: Date,
): Promise<RecomputeOutcome[]> {
  const links = await tx.evidenceLink.findMany({ where: { itemId }, select: { instanceId: true } });
  const out: RecomputeOutcome[] = [];
  for (const l of links) out.push(await recomputeInstance(tx, l.instanceId, now));
  return out;
}

/**
 * After an ACCEPTED verification, advance the instance deadline per the template's recurrence
 * (RULES_ENGINE recurrence table). Every change is recorded in the immutable due_date_change log.
 */
export async function advanceDeadlineAfterVerification(
  tx: TenantTx,
  instanceId: string,
  evidence: { validFrom: ISODate | null; validTo: ISODate | null; capturedAt: Date },
  reviewerId: string,
  now: Date,
): Promise<{ field: 'DUE' | 'EXPIRY' | 'REVIEW'; from: ISODate | null; to: ISODate } | null> {
  const inst = await loadInstance(tx, instanceId);
  const tv = inst.templateVersion;
  const kind = tv.deadlineKind as DeadlineKind;
  const rec = tv.recurrence as { type?: string; interval?: Interval };
  const completedOn = evidence.validFrom ?? londonDate(evidence.capturedAt);
  const today = londonDate(now);
  let next: ISODate | null = null;
  const current =
    kind === 'DUE'
      ? iso(inst.dueDate)
      : kind === 'EXPIRY'
        ? iso(inst.expiryDate)
        : iso(inst.reviewDate);

  if (kind === 'EXPIRY') {
    next =
      evidence.validTo ?? (rec.interval ? nextCompletionBased(completedOn, rec.interval) : null);
  } else if (kind === 'DUE' && rec.interval) {
    if (rec.type === 'FIXED_CALENDAR') {
      const anchor = iso(inst.anchorDate) ?? current ?? completedOn;
      let n = nextFixedCalendar(anchor, rec.interval, current ?? addDays(anchor, -1));
      // Catch up if several periods were missed; never schedule in the past.
      while (n < today) n = nextFixedCalendar(anchor, rec.interval, n);
      next = n;
    } else if (rec.type === 'COMPLETION_BASED') {
      next = nextCompletionBased(completedOn, rec.interval);
    }
  } else if (kind === 'REVIEW' && rec.interval) {
    next = nextCompletionBased(completedOn, rec.interval);
  }
  if (!next || (current !== null && next <= current)) return null;
  await tx.requirementInstance.update({
    where: { id: instanceId },
    data: {
      [kind === 'DUE' ? 'dueDate' : kind === 'EXPIRY' ? 'expiryDate' : 'reviewDate']: toDate(next),
      ...(kind === 'DUE' && !inst.anchorDate && rec.type === 'FIXED_CALENDAR'
        ? { anchorDate: toDate(current ?? next) }
        : {}),
    },
  });
  await tx.dueDateChange.create({
    data: {
      organisationId: inst.organisationId,
      instanceId,
      field: kind,
      oldDate: current ? toDate(current) : null,
      newDate: toDate(next),
      reason: 'Advanced automatically after verified evidence',
      approverId: reviewerId,
      createdBy: reviewerId,
    },
  });
  return { field: kind, from: current, to: next };
}
