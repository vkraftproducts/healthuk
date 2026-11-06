import type { Db, TenantTx } from '@hub/db';
import {
  auditOutcome,
  dashboardCounts,
  evidenceCoverage,
  isNhsContractItem,
  isOverdue,
  jobDashboardRow,
  londonDate,
  moduleStatus,
  type AuditResult,
  type RagStatus,
  type RequirementResult,
  type Severity,
} from '@hub/rules';
import { zipSync, strToU8 } from 'fflate';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { buildFullExport } from './data-export.js';
import { buildSubjectAccessExport } from './privacy.js';
import { buildManagementPack } from './reports.js';
import type { BlobStore } from './storage.js';

const iso = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

/** Sequential human codes per organisation: AUD-100…, ACT-200…, EVT-1…, RSK-1… */
const START: Record<string, number> = {
  AUD: 100,
  ACT: 200,
  EVT: 1,
  RSK: 1,
  J: 100,
  IMP: 1,
  DSR: 1,
  BRE: 1,
  DPC: 1,
  SPK: 1,
  MTG: 1,
  NTF: 1,
};
export type CodePrefix =
  'AUD' | 'ACT' | 'EVT' | 'RSK' | 'J' | 'IMP' | 'DSR' | 'BRE' | 'DPC' | 'SPK' | 'MTG' | 'NTF';
export async function nextCode(tx: TenantTx, orgId: string, prefix: CodePrefix): Promise<string> {
  const rows = await tx.$queryRaw<
    { code: string }[]
  >`SELECT next_code(${orgId}::uuid, ${prefix}, ${START[prefix]}::int) AS code`;
  return rows[0]!.code;
}

export async function createAction(
  tx: TenantTx,
  a: {
    organisationId: string;
    sourceType:
      'FINDING' | 'EVENT' | 'RISK' | 'CORRESPONDENCE' | 'FEEDBACK' | 'MEETING' | 'PREMISES';
    sourceId: string;
    kind?: 'ACTION' | 'REAUDIT';
    title: string;
    severity: Severity;
    ownerUserId: string;
    deadline: string;
    by: string;
    reauditRunId?: string | null;
  },
): Promise<{ id: string; code: string }> {
  const code = await nextCode(tx, a.organisationId, 'ACT');
  const row = await tx.action.create({
    data: {
      organisationId: a.organisationId,
      code,
      sourceType: a.sourceType,
      sourceId: a.sourceId,
      kind: a.kind ?? 'ACTION',
      title: a.title,
      severity: a.severity,
      ownerUserId: a.ownerUserId,
      deadline: new Date(`${a.deadline}T00:00:00.000Z`),
      reauditRunId: a.reauditRunId ?? null,
      createdBy: a.by,
    },
  });
  await tx.actionHistory.create({
    data: {
      organisationId: a.organisationId,
      actionId: row.id,
      fromStatus: null,
      toStatus: 'OPEN',
      note: 'Created',
      byUserId: a.by,
    },
  });
  return row;
}

/** Recomputes the audit run's outcome from its findings and their actions (UAT-04). */
export async function refreshAuditOutcome(tx: TenantTx, runId: string): Promise<void> {
  const run = await tx.auditRun.findUniqueOrThrow({
    where: { id: runId },
    include: { findings: true },
  });
  if (run.status === 'SCHEDULED' || run.status === 'IN_PROGRESS') return;
  // Only the latest submission counts; findings from before a reviewer's return stay as history.
  const latest = Math.max(1, run.submissionNo);
  const findings = run.findings.filter((f) => f.submissionNo === latest);
  const actions = await tx.action.findMany({
    where: { sourceType: 'FINDING', sourceId: { in: run.findings.map((f) => f.id) } },
  });
  const o = auditOutcome(
    findings.map((f) => ({
      result: f.result as AuditResult,
      severity: f.severity as Severity,
    })),
    actions.map((a) => ({
      status: a.status,
      severity: a.severity as Severity,
      kind: a.kind as 'ACTION' | 'REAUDIT',
    })),
  );
  await tx.auditRun.update({
    where: { id: runId },
    data: {
      outcome: o.status,
      outcomeReason: o.reason,
      status: o.closed ? 'CLOSED' : 'ACTIONS_OPEN',
    },
  });
}

// ---------------------------------------------------------------------------
// Dashboard (wireframe 01, DASH-01, UAT-08)
// ---------------------------------------------------------------------------
export type Module = 'STAFF' | 'FLEET' | 'COMPLIANCE' | 'PREMISES' | 'EVENTS' | 'JOBS';
export interface ActionRowOut {
  key: string;
  module: Module;
  item: string;
  ownerUserId: string | null;
  /** Owner's display name (organisation members only); null when unassigned or not a member. */
  ownerName?: string | null;
  deadline: string | null;
  status: RagStatus;
  reasonText: string;
  /** Which tiles this row is counted in: every tile number equals its drill-down rows. */
  tiles: string[];
  /** Requirements have no page of their own: subject says whose page shows them. */
  link: { type: string; id: string; subjectType?: string; subjectId?: string };
}

const MODULE_OF: Record<string, Module> = {
  STAFF: 'STAFF',
  VEHICLE: 'FLEET',
  EQUIPMENT: 'FLEET',
  PREMISES: 'PREMISES',
  SERVICE: 'COMPLIANCE',
  ORGANISATION: 'COMPLIANCE',
};

/**
 * Single source for tiles AND drill-down: the tiles are counted from the rows returned here, so
 * a tile can never disagree with its list (UAT-08).
 */
export interface DashboardFilterIn {
  locationId?: string | undefined;
  serviceId?: string | undefined;
  ownerUserId?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  module?: string | undefined;
  /** Modules the caller may see (permissions and sector packs); rows for others are dropped. */
  modules?: readonly string[] | undefined;
}

export async function dashboardRows(
  tx: TenantTx,
  f: DashboardFilterIn,
  now: Date,
): Promise<{ rows: ActionRowOut[]; results: (RequirementResult & { module: Module })[] }> {
  const today = londonDate(now);
  const inRange = (d: string | null): boolean =>
    d === null || ((!f.dateFrom || d >= f.dateFrom) && (!f.dateTo || d <= f.dateTo));
  const ownerOk = (o: string | null): boolean => !f.ownerUserId || o === f.ownerUserId;
  let serviceCode: string | null = null;
  if (f.serviceId) {
    const svc = await tx.serviceType.findUnique({ where: { id: f.serviceId } });
    // An unknown / other-tenant service id matches nothing rather than everything.
    serviceCode = svc?.code ?? '__none__';
  }
  const allInstances = await tx.requirementInstance.findMany({
    where: {
      ...(f.locationId ? { OR: [{ locationId: f.locationId }, { locationId: null }] } : {}),
      ...(f.ownerUserId ? { ownerUserId: f.ownerUserId } : {}),
    },
    include: {
      template: { select: { title: true } },
      templateVersion: { select: { applicabilityRule: true } },
    },
  });
  const instances = allInstances.filter((i) => {
    if (serviceCode === null) return true;
    const svcs = ((i.templateVersion.applicabilityRule ?? {}) as { services?: string[] }).services;
    return !svcs || svcs.length === 0 || svcs.includes(serviceCode);
  });
  // Names for subjects (staff no / callsign / asset tag / location) — IDs and codes, no PII beyond what the viewer already sees.
  const staff = await tx.staff.findMany({
    where: {
      id: { in: instances.filter((i) => i.subjectType === 'STAFF').map((i) => i.subjectId) },
    },
    select: { id: true, staffNo: true, displayName: true, lifecycleState: true },
  });
  const vehicles = await tx.vehicle.findMany({
    select: { id: true, callsign: true, status: true, statusReason: true, baseLocationId: true },
  });
  const assets = await tx.equipmentAsset.findMany({
    where: {
      id: { in: instances.filter((i) => i.subjectType === 'EQUIPMENT').map((i) => i.subjectId) },
    },
    select: { id: true, assetTag: true },
  });
  const locations = await tx.location.findMany({ select: { id: true, name: true } });
  const leavers = new Set(staff.filter((s) => s.lifecycleState === 'LEAVER').map((s) => s.id));
  const subjectName = (t: string, id: string): string =>
    t === 'STAFF'
      ? (() => {
          const s = staff.find((x) => x.id === id);
          return s ? `${s.displayName} (${s.staffNo})` : 'Staff member';
        })()
      : t === 'VEHICLE'
        ? (vehicles.find((x) => x.id === id)?.callsign ?? 'Vehicle')
        : t === 'EQUIPMENT'
          ? (assets.find((x) => x.id === id)?.assetTag ?? 'Asset')
          : t === 'PREMISES'
            ? (locations.find((x) => x.id === id)?.name ?? 'Location')
            : 'Organisation';

  const rows: ActionRowOut[] = [];
  const results: (RequirementResult & { module: Module })[] = [];
  for (const i of instances) {
    if (i.subjectType === 'STAFF' && leavers.has(i.subjectId)) continue;
    const module = MODULE_OF[i.subjectType] ?? 'COMPLIANCE';
    if (f.module && f.module !== module) continue;
    const r: RequirementResult & { module: Module } = {
      status: i.status,
      reasonCode: i.reasonCode as RequirementResult['reasonCode'],
      reasonText: i.reasonText,
      effect: i.effect as RequirementResult['effect'],
      currentlyVerified: i.currentlyVerified,
      daysUntil: null,
      module,
    };
    if (!inRange(iso(i.dueDate ?? i.expiryDate ?? i.reviewDate))) continue;
    results.push(r);
    const tiles: string[] = [];
    if (r.status === 'RED' && r.reasonCode !== 'CRITICAL_FAILURE') tiles.push('overdue');
    if (r.status === 'AMBER' && (r.reasonCode === 'DUE_SOON' || r.reasonCode === 'DUE_TODAY'))
      tiles.push('dueSoon');
    if (r.status === 'GREY' || (r.status === 'AMBER' && r.reasonCode === 'AWAITING_REVIEW'))
      tiles.push('unverified');
    if (r.status === 'GREEN' || r.status === 'NOT_APPLICABLE') continue;
    rows.push({
      key: `REQ:${i.id}`,
      module,
      item: `${i.template.title} – ${subjectName(i.subjectType, i.subjectId)}`,
      ownerUserId: i.ownerUserId,
      deadline: iso(i.dueDate ?? i.expiryDate ?? i.reviewDate),
      status: r.status,
      reasonText: r.reasonText,
      tiles,
      link: { type: 'REQUIREMENT', id: i.id, subjectType: i.subjectType, subjectId: i.subjectId },
    });
  }
  if (!f.module || f.module === 'FLEET') {
    for (const v of vehicles) {
      if (v.status === 'AVAILABLE') continue;
      if (f.locationId && v.baseLocationId !== f.locationId) continue;
      if (f.ownerUserId) continue; // vehicles have no named owner; an owner filter hides them
      rows.push({
        key: `VEH:${v.id}`,
        module: 'FLEET',
        item: v.callsign,
        ownerUserId: null,
        deadline: null,
        status: v.status === 'OFF_ROAD' ? 'GREY' : 'RED',
        reasonText:
          v.status === 'OFF_ROAD' ? 'Off road' : `Blocked – ${v.statusReason ?? 'not available'}`,
        tiles: v.status === 'BLOCKED' || v.status === 'QUARANTINED' ? ['blockedVehicles'] : [],
        link: { type: 'VEHICLE', id: v.id },
      });
    }
    // Open critical defects count as critical findings (WORKFLOWS L1), whatever the date range.
    if (!f.ownerUserId) {
      const defects = await tx.defect.findMany({
        where: { severity: 'CRITICAL', status: { in: ['OPEN', 'REPAIRING'] } },
        select: { id: true, vehicleId: true, assetId: true, discoveredAt: true },
      });
      for (const d of defects) {
        const v = d.vehicleId ? vehicles.find((x) => x.id === d.vehicleId) : undefined;
        if (f.locationId && v && v.baseLocationId !== f.locationId) continue;
        rows.push({
          key: `DEF:${d.id}`,
          module: 'FLEET',
          item: `${v?.callsign ?? 'Equipment'} critical defect`,
          ownerUserId: null,
          deadline: null,
          status: 'RED',
          reasonText: 'Critical defect open – remains until repaired and released',
          tiles: [],
          link: d.vehicleId ? { type: 'VEHICLE', id: d.vehicleId } : { type: 'DEFECT', id: d.id },
        });
      }
    }
  }
  if (!f.module || f.module === 'COMPLIANCE') {
    const actions = await tx.action.findMany({
      where: {
        status: { not: 'VERIFIED' },
        ...(f.ownerUserId ? { ownerUserId: f.ownerUserId } : {}),
      },
    });
    for (const a of actions) {
      if (!inRange(iso(a.deadline))) continue;
      const late = isOverdue(iso(a.deadline)!, now);
      rows.push({
        key: `ACT:${a.id}`,
        module: 'COMPLIANCE',
        item: `${a.code} ${a.title}`,
        ownerUserId: a.ownerUserId,
        deadline: iso(a.deadline),
        status: late || a.severity === 'CRITICAL' ? 'RED' : 'AMBER',
        reasonText:
          a.status === 'EVIDENCE_SUBMITTED'
            ? 'Evidence awaiting verification'
            : late
              ? 'Action overdue'
              : 'Action open',
        tiles: late ? ['overdue'] : [],
        link: { type: 'ACTION', id: a.id },
      });
    }
    // Critical findings stay visible until verified closed (PRD 4.2).
    const critical = await tx.auditFinding.findMany({
      where: { severity: 'CRITICAL', run: { status: { not: 'CLOSED' } } },
      include: { run: true },
    });
    // Critical findings stay visible regardless of the date range (never hidden by a filter).
    for (const c of critical.filter((x) => ownerOk(x.run.ownerUserId)))
      rows.push({
        key: `FND:${c.id}`,
        module: 'COMPLIANCE',
        item: `${c.run.code} ${c.controlCode} critical finding`,
        ownerUserId: c.run.ownerUserId,
        deadline: iso(c.run.dueDate),
        status: 'RED',
        reasonText: 'Critical finding – remains until verified closed',
        tiles: [],
        link: { type: 'AUDIT_RUN', id: c.runId },
      });
    // Audits past their due date and not submitted (Overdue tasks and the sector tile).
    const lateRuns = await tx.auditRun.findMany({
      where: {
        status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
        dueDate: { lt: new Date(`${today}T00:00:00Z`) },
        ...(f.locationId ? { OR: [{ locationId: f.locationId }, { locationId: null }] } : {}),
        ...(f.ownerUserId ? { ownerUserId: f.ownerUserId } : {}),
      },
      select: { id: true, code: true, title: true, ownerUserId: true, dueDate: true },
    });
    for (const r of lateRuns) {
      if (!inRange(iso(r.dueDate))) continue;
      rows.push({
        key: `AUD:${r.id}`,
        module: 'COMPLIANCE',
        item: `${r.code} ${r.title}`,
        ownerUserId: r.ownerUserId,
        deadline: iso(r.dueDate),
        status: 'RED',
        reasonText: 'Audit overdue – not submitted',
        tiles: ['overdue', 'auditsOverdue'],
        link: { type: 'AUDIT_RUN', id: r.id },
      });
    }
    // Regulator correspondence with a reply deadline (WORKFLOWS I1).
    const letters = await tx.regulatoryCorrespondence.findMany({
      where: {
        status: 'OPEN',
        deadline: { not: null },
        ...(f.ownerUserId ? { ownerUserId: f.ownerUserId } : {}),
      },
      select: { id: true, regulator: true, subject: true, ownerUserId: true, deadline: true },
    });
    const soon = new Date(`${today}T00:00:00Z`);
    soon.setUTCDate(soon.getUTCDate() + 30);
    for (const c of letters) {
      const due = iso(c.deadline)!;
      if (!inRange(due)) continue;
      const late = due < today;
      rows.push({
        key: `COR:${c.id}`,
        module: 'COMPLIANCE',
        item: `${c.regulator} correspondence: ${c.subject}`,
        ownerUserId: c.ownerUserId,
        deadline: due,
        status: late ? 'RED' : 'AMBER',
        reasonText: late ? 'Reply to the regulator overdue' : 'Reply to the regulator due',
        tiles: late ? ['overdue'] : c.deadline! <= soon ? ['dueSoon'] : [],
        link: { type: 'CORRESPONDENCE', id: c.id },
      });
    }
    // Published policies whose review date has passed or falls in the next 30 days (G4).
    const reviews = await tx.policyVersion.findMany({
      where: { status: 'PUBLISHED', reviewDate: { not: null, lte: soon } },
      select: {
        id: true,
        reviewDate: true,
        document: { select: { id: true, code: true, title: true, ownerUserId: true } },
      },
    });
    for (const v of reviews) {
      if (!ownerOk(v.document.ownerUserId)) continue;
      const due = iso(v.reviewDate)!;
      if (!inRange(due)) continue;
      const late = due < today;
      rows.push({
        key: `POL:${v.id}`,
        module: 'COMPLIANCE',
        item: `${v.document.code} ${v.document.title} review`,
        ownerUserId: v.document.ownerUserId,
        deadline: due,
        status: late ? 'RED' : 'AMBER',
        reasonText: late ? 'Policy review overdue' : 'Policy review due',
        tiles: late ? ['overdue'] : ['dueSoon'],
        link: { type: 'POLICY', id: v.document.id },
      });
    }
  }
  if (!f.module) {
    const obligations = await tx.reportingObligation.findMany({
      where: { OR: [{ decision: 'PENDING' }, { decision: 'REQUIRED', submittedAt: null }] },
      include: { event: { select: { code: true, leadUserId: true } } },
    });
    for (const o of obligations) {
      if (!ownerOk(o.event.leadUserId)) continue;
      if (!inRange(o.deadlineAt ? londonDate(o.deadlineAt) : null)) continue;
      const late = o.deadlineAt ? o.deadlineAt < now : false;
      rows.push({
        key: `OBL:${o.id}`,
        module: 'EVENTS',
        item: `${o.event.code} ${o.body} notification`,
        ownerUserId: o.event.leadUserId,
        deadline: o.deadlineAt ? londonDate(o.deadlineAt) : null,
        status: late ? 'RED' : 'AMBER',
        reasonText:
          o.decision === 'PENDING'
            ? 'Reporting decision needed'
            : late
              ? 'Notification overdue'
              : 'Notification to submit',
        tiles: late ? ['overdue'] : [],
        link: { type: 'EVENT', id: o.eventId },
      });
    }
  }
  if (!f.module && !f.ownerUserId) {
    // Journeys for the date range (default: today, London day). Job code and time only: no patient details on the dashboard.
    const jobs = await tx.job.findMany({
      where: {
        journeyDate: {
          gte: new Date(`${f.dateFrom ?? today}T00:00:00Z`),
          lte: new Date(`${f.dateTo ?? f.dateFrom ?? today}T00:00:00Z`),
        },
        ...(f.locationId ? { locationId: f.locationId } : {}),
      },
      select: { id: true, code: true, state: true, plannedStart: true },
    });
    for (const j of jobs) {
      const r = jobDashboardRow(j.state, j.plannedStart, now);
      if (!r) continue;
      const at = j.plannedStart.toLocaleTimeString('en-GB', {
        timeZone: 'Europe/London',
        hour: '2-digit',
        minute: '2-digit',
      });
      rows.push({
        key: `JOB:${j.id}`,
        module: 'JOBS',
        item: `${j.code} at ${at}`,
        ownerUserId: null,
        deadline: today,
        status: r.status,
        reasonText: r.reasonText,
        tiles: r.tiles,
        link: { type: 'JOB', id: j.id },
      });
    }
  }
  if (f.modules) {
    const allowed = new Set<string>(f.modules);
    for (let i = rows.length - 1; i >= 0; i--) if (!allowed.has(rows[i]!.module)) rows.splice(i, 1);
    for (let i = results.length - 1; i >= 0; i--)
      if (!allowed.has(results[i]!.module)) results.splice(i, 1);
  }
  const rank: Record<string, number> = { RED: 0, AMBER: 1, GREY: 2, GREEN: 3, NOT_APPLICABLE: 4 };
  rows.sort(
    (a, b) =>
      rank[a.status]! - rank[b.status]! ||
      (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999') ||
      a.key.localeCompare(b.key),
  );
  const ownerIds = [...new Set(rows.flatMap((r) => (r.ownerUserId ? [r.ownerUserId] : [])))];
  const owners = ownerIds.length
    ? await tx.membership.findMany({
        where: { userId: { in: ownerIds } },
        select: { userId: true, user: { select: { displayName: true } } },
      })
    : [];
  const ownerName = new Map(owners.map((o) => [o.userId, o.user.displayName]));
  for (const r of rows) r.ownerName = r.ownerUserId ? (ownerName.get(r.ownerUserId) ?? null) : null;
  return { rows, results };
}

export async function dashboardSummary(tx: TenantTx, f: DashboardFilterIn, now: Date) {
  const { rows, results } = await dashboardRows(tx, f, now);
  const count = (tile: string) => rows.filter((r) => r.tiles.includes(tile)).length;
  const mod = (m: Module) => results.filter((r) => r.module === m);
  const counts = dashboardCounts(results);
  const fleetBlocked = count('blockedVehicles');
  const setUp = {
    vehicles: await tx.vehicle.count(),
    audits: await tx.auditRun.count(),
  };
  return {
    tiles: {
      overdue: count('overdue'),
      dueSoon: count('dueSoon'),
      blockedVehicles: fleetBlocked,
      jobsToday: count('jobsToday'),
      unverified: count('unverified'),
      auditsOverdue: count('auditsOverdue'),
    },
    notSetUp: (['STAFF', 'FLEET', 'COMPLIANCE', 'PREMISES'] as const).filter(
      (m) =>
        (!f.modules || f.modules.includes(m)) &&
        mod(m).length === 0 &&
        !rows.some((r) => r.module === m) &&
        !(m === 'FLEET' && setUp.vehicles > 0) &&
        !(m === 'COMPLIANCE' && setUp.audits > 0),
    ),
    modules: [
      {
        module: 'STAFF' as const,
        status: moduleStatus(mod('STAFF')),
        count: dashboardCounts(mod('STAFF')).unverified,
        label: 'unverified',
      },
      {
        module: 'FLEET' as const,
        status: fleetBlocked > 0 ? ('RED' as RagStatus) : moduleStatus(mod('FLEET')),
        count: fleetBlocked,
        label: 'blocked',
      },
      {
        module: 'COMPLIANCE' as const,
        status: rows.some((r) => r.module === 'COMPLIANCE' && r.status === 'RED')
          ? ('RED' as RagStatus)
          : moduleStatus(mod('COMPLIANCE')),
        count: rows.filter((r) => r.module === 'COMPLIANCE' && r.tiles.includes('overdue')).length,
        label: 'overdue',
      },
      {
        module: 'PREMISES' as const,
        status: moduleStatus(mod('PREMISES')),
        count: mod('PREMISES').filter((r) => r.reasonCode === 'DUE_TODAY').length,
        label: 'due today',
      },
    ].filter((m) => !f.modules || f.modules.includes(m.module)),
    operations: {
      jobsAwaitingAllocation: count('awaitingAllocation'),
      acknowledgementsDue: count('acknowledgementsDue'),
    },
    criticalOpen: rows.filter((r) => r.key.startsWith('FND:') || r.key.startsWith('DEF:')).length,
    coverage: evidenceCoverage(results),
    blockedTotal: counts.blocked,
  };
}

// ---------------------------------------------------------------------------
// Inspection evidence pack (PDF index + ZIP), run by the worker
// ---------------------------------------------------------------------------
export interface PackParams {
  locationId?: string;
  domain?: string;
  domains?: string[];
  serviceId?: string;
  frameworkVersion?: string;
  from: string;
  to: string;
  /** Older jobs have none of the options below; the defaults reproduce the original pack. */
  purpose?: 'INSPECTION' | 'NHS_CONTRACT' | 'INTERNAL';
  sections?: string[];
  includeFiles?: boolean;
  gapsOnly?: boolean;
}

const PACK_TITLE: Record<string, string> = {
  INSPECTION: 'Inspection evidence pack',
  NHS_CONTRACT: 'NHS contract evidence pack',
  INTERNAL: 'Internal evidence pack',
};
const DEFAULT_SECTIONS = ['REQUIREMENTS', 'AUDITS', 'ACTIONS', 'POLICIES'];

const pdfSafe = (s: string) =>
  s
    .replace(/[^\x20-\x7E£–]/g, '?')
    .replace(/–/g, '-')
    .replace(/£/g, 'GBP ');
const fileSafe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);

async function renderPdf(title: string, lines: string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setProducer('Healthcare Hub');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([595, 842]);
  let y = 800;
  const write = (text: string, isBold = false, size = 10) => {
    for (const chunk of pdfSafe(text).match(/.{1,95}(\s|$)|\S+/g) ?? ['']) {
      if (y < 50) {
        page = pdf.addPage([595, 842]);
        y = 800;
      }
      page.drawText(chunk.trimEnd(), {
        x: 40,
        y,
        size,
        font: isBold ? bold : font,
        color: rgb(0.1, 0.1, 0.1),
      });
      y -= size + 4;
    }
  };
  write(title, true, 16);
  y -= 6;
  for (const l of lines)
    write(l.replace(/^# /, ''), l.startsWith('# '), l.startsWith('# ') ? 12 : 10);
  return pdf.save();
}

/**
 * Builds the pack inside the requester's permissions (captured on the job): sensitive staff
 * evidence and safeguarding material are left out unless they held the matching permission.
 */
export async function buildEvidencePack(
  tx: TenantTx,
  p: PackParams,
  permissions: readonly string[],
  store: BlobStore,
  now: Date,
): Promise<{ zip: Uint8Array; files: number; gaps: number }> {
  const canSensitive = permissions.includes('staff.sensitive.view');
  const purpose = p.purpose ?? 'INSPECTION';
  const sections = new Set(p.sections?.length ? p.sections : DEFAULT_SECTIONS);
  const includeFiles = p.includeFiles ?? true;
  const instances = await tx.requirementInstance.findMany({
    where: p.locationId ? { OR: [{ locationId: p.locationId }, { locationId: null }] } : {},
    include: {
      template: { select: { code: true, title: true, pack: true } },
      templateVersion: {
        select: {
          basisType: true,
          regulationRef: true,
          sourceUrl: true,
          frameworkMappings: true,
          version: true,
        },
      },
      links: { include: { item: { include: { versions: { include: { verification: true } } } } } },
    },
    orderBy: { createdAt: 'asc' },
  });
  const wanted = new Set([...(p.domains ?? []), ...(p.domain ? [p.domain] : [])]);
  const inDomain = (maps: unknown) =>
    wanted.size === 0 ||
    (Array.isArray(maps) && maps.some((m) => wanted.has((m as { domain?: string }).domain ?? '')));
  const files: Record<string, Uint8Array> = {};
  const csv: string[][] = [
    [
      'Requirement',
      'Template version',
      'Subject',
      'Status',
      'Reason',
      'Basis',
      'Regulation',
      'Source',
      'Evidence file',
      'Evidence valid',
      'Verified by',
      'Verified at',
    ],
  ];
  const reviewers = new Map<string, string>();
  const loadNames = async (ids: (string | null)[]) => {
    const want = [...new Set(ids.filter((x): x is string => !!x && !reviewers.has(x)))];
    if (want.length === 0) return;
    for (const m of await tx.membership.findMany({
      where: { userId: { in: want } },
      select: { userId: true, user: { select: { displayName: true } } },
    }))
      reviewers.set(m.userId, m.user.displayName);
  };
  await loadNames(
    instances.flatMap((i) =>
      i.links.flatMap((l) => l.item.versions.map((v) => v.verification?.reviewerId ?? null)),
    ),
  );
  const reviewer = (id: string) => reviewers.get(id) ?? 'a former member';
  const lines: string[] = [
    `Period: ${p.from} to ${p.to}. Generated ${now.toISOString()} (Europe/London dates).`,
    'Internal measure - not a CQC rating. Statuses are as at generation time.',
    'Only verified evidence counts as met; anything else is listed as a gap.',
    ...(p.frameworkVersion ? [`Framework version: ${p.frameworkVersion}.`] : []),
    ...(wanted.size > 0 ? [`Key questions: ${[...wanted].join(', ')}.`] : []),
    ...(purpose === 'NHS_CONTRACT'
      ? ['Requirements are limited to NHS contract items. Check them against the contract itself.']
      : []),
    ...(p.gapsOnly ? ['Only requirements that are not met are listed.'] : []),
    ...(includeFiles ? [] : ['Index only: evidence files are not included in this pack.']),
  ];
  let gaps = 0;
  if (sections.has('REQUIREMENTS')) lines.push('', '# Requirements and evidence');
  for (const i of sections.has('REQUIREMENTS') ? instances : []) {
    if (!inDomain(i.templateVersion.frameworkMappings)) continue;
    if (purpose === 'NHS_CONTRACT' && !isNhsContractItem(i.template)) continue;
    const ok = i.status === 'GREEN' || i.status === 'NOT_APPLICABLE';
    if (!ok) gaps += 1;
    if (p.gapsOnly && ok) continue;
    lines.push(
      `${i.template.code} v${i.templateVersion.version} ${i.template.title} [${i.subjectType}] - ${i.status}: ${i.reasonText}`,
    );
    let any = false;
    for (const l of i.links) {
      if (l.item.sensitivity !== 'NORMAL' && !canSensitive) continue;
      for (const v of l.item.versions) {
        const ver = v.verification;
        if (!ver || ver.decision !== 'ACCEPTED' || v.scanStatus !== 'CLEAN') continue;
        if (ver.createdAt.toISOString().slice(0, 10) > p.to) continue;
        const ext =
          (v.mime ?? '')
            .split('/')[1]
            ?.replace('vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx') ??
          'bin';
        const name = `evidence/${fileSafe(i.template.code)}/${fileSafe(l.item.title)}-v${v.versionNo}.${fileSafe(ext)}`;
        if (includeFiles) {
          const bytes = await store.get(v.blobKey);
          if (!bytes) continue;
          files[name] = new Uint8Array(bytes);
        }
        any = true;
        const validTo = iso(ver.confirmedValidTo ?? v.validTo);
        lines.push(
          `   evidence: ${includeFiles ? name : `${l.item.title} v${v.versionNo} (held in the hub)`} (valid to ${validTo ?? 'no end date'}), verified ${ver.createdAt.toISOString().slice(0, 10)} by ${reviewer(ver.reviewerId)}`,
        );
        csv.push([
          i.template.title,
          String(i.templateVersion.version),
          i.subjectType,
          i.status,
          i.reasonText,
          i.templateVersion.basisType,
          i.templateVersion.regulationRef ?? '',
          i.templateVersion.sourceUrl ?? '',
          includeFiles ? name : '',
          validTo ?? '',
          reviewer(ver.reviewerId),
          ver.createdAt.toISOString(),
        ]);
      }
    }
    if (!any) {
      lines.push('   GAP: no verified evidence on file');
      csv.push([
        i.template.title,
        String(i.templateVersion.version),
        i.subjectType,
        i.status,
        i.reasonText,
        i.templateVersion.basisType,
        i.templateVersion.regulationRef ?? '',
        i.templateVersion.sourceUrl ?? '',
        '',
        '',
        '',
        '',
      ]);
    }
  }
  const from = new Date(`${p.from}T00:00:00Z`);
  const to = new Date(`${p.to}T23:59:59Z`);
  if (sections.has('AUDITS')) {
    const runs = await tx.auditRun.findMany({
      where: {
        dueDate: { gte: from, lte: to },
        ...(p.locationId ? { locationId: p.locationId } : {}),
      },
      include: { findings: true, templateVersion: { include: { template: true } } },
    });
    lines.push('', '# Audits in the period');
    for (const r of runs) {
      if (wanted.size > 0 && !wanted.has(r.templateVersion.template.domain)) continue;
      if (p.serviceId && r.serviceId && r.serviceId !== p.serviceId) continue;
      lines.push(
        `${r.code} ${r.title} (${r.templateVersion.template.code} v${r.templateVersion.version}) - ${r.outcome ?? 'not submitted'}${r.outcomeReason ? `: ${r.outcomeReason}` : ''}`,
      );
      for (const f of r.findings) lines.push(`   ${f.controlCode}: ${f.summary} (${f.result})`);
    }
  }
  if (sections.has('ACTIONS')) {
    const actions = await tx.action.findMany({
      where: { status: { not: 'VERIFIED' } },
      orderBy: { deadline: 'asc' },
    });
    lines.push('', '# Open actions');
    for (const a of actions)
      lines.push(`${a.code} ${a.title} - ${a.status}, deadline ${iso(a.deadline)}`);
    if (actions.length === 0) lines.push('None');
  }
  if (sections.has('POLICIES')) {
    const policies = await tx.policyVersion.findMany({
      where: { status: 'PUBLISHED' },
      include: { document: true, _count: { select: { acks: true } } },
    });
    await loadNames(policies.map((v) => v.approvedBy));
    lines.push('', '# Published policies');
    for (const v of policies)
      lines.push(
        `${v.document.code} ${v.document.title} v${v.version} - approved by ${v.approvedBy ? reviewer(v.approvedBy) : 'n/a'}, ${v._count.acks} acknowledgement(s)`,
      );
  }
  if (sections.has('GOVERNANCE')) lines.push(...(await governanceLines(tx, from, to)));
  if (sections.has('CONTRACTS')) {
    const contracts = await tx.nhsContract.findMany({ orderBy: { endOn: 'asc' } });
    lines.push('', '# NHS contracts');
    for (const c of contracts)
      lines.push(
        `${c.reference} ${c.service} with ${c.commissioner}: ${iso(c.startOn)} to ${iso(c.endOn)}, notice ${c.noticeMonths} month(s), reporting ${c.reporting.toLowerCase()}`,
      );
    if (contracts.length === 0) lines.push('None recorded');
  }
  lines.push('', `Open gaps: ${gaps}`);

  files['index.pdf'] = await renderPdf(PACK_TITLE[purpose] ?? PACK_TITLE.INSPECTION!, lines);
  files['index.csv'] = strToU8(
    csv
      .map((r) =>
        r
          .map((c) =>
            /[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : /^[=+\-@]/.test(c) ? `'${c}` : c,
          )
          .join(','),
      )
      .join('\r\n') + '\r\n',
  );
  return { zip: zipSync(files, { level: 6 }), files: Object.keys(files).length, gaps };
}

/**
 * Registration and governance records for the pack: the ratings exactly as CQC published them,
 * approved meeting minutes and CQC notifications in the period. Notification text is left out
 * (codes, kinds and dates only) so nothing about a person is copied into the pack.
 */
async function governanceLines(tx: TenantTx, from: Date, to: Date): Promise<string[]> {
  const out: string[] = ['', '# Registration and governance'];
  const ratings = await tx.cqcRatingRecord.findMany({
    orderBy: [{ publishedOn: 'desc' }, { createdAt: 'desc' }],
  });
  const seen = new Set<string>();
  out.push('Ratings as published by CQC (the hub does not calculate ratings):');
  for (const r of ratings) {
    const k = r.locationId ?? 'provider';
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(
      `   ${r.locationId ? 'Location' : 'Provider'}: ${r.overall.replace(/_/g, ' ').toLowerCase()}, published ${iso(r.publishedOn)}; displayed at premises ${iso(r.displayedPremisesOn) ?? 'not recorded'}, website ${r.noWebsite ? 'no website' : (iso(r.displayedWebsiteOn) ?? 'not recorded')}`,
    );
  }
  if (seen.size === 0) out.push('   None recorded');
  const meetings = await tx.governanceMeeting.findMany({
    where: { heldOn: { gte: from, lte: to } },
    orderBy: { heldOn: 'asc' },
  });
  out.push('Governance meetings in the period:');
  for (const m of meetings)
    out.push(
      `   ${m.code} ${m.title} (${iso(m.heldOn)}) - ${m.status === 'APPROVED' ? 'minutes approved' : 'minutes in draft'}${m.quorate ? '' : ', not quorate'}`,
    );
  if (meetings.length === 0) out.push('   None');
  const notifications = await tx.cqcNotification.findMany({
    where: { occurredOn: { gte: from, lte: to } },
    orderBy: { occurredOn: 'asc' },
  });
  out.push('CQC notifications in the period:');
  for (const n of notifications)
    out.push(
      `   ${n.code} ${n.kind.replace(/_/g, ' ').toLowerCase()} (${iso(n.occurredOn)}) - ${n.status === 'SUBMITTED' ? `submitted ${iso(n.submittedOn)}, CQC reference ${n.cqcReference ?? ''}` : n.status.replace(/_/g, ' ').toLowerCase()}`,
    );
  if (notifications.length === 0) out.push('   None');
  return out;
}

/** Worker: runs queued exports for every organisation. Failures are recorded on the job. */
/** Export builders by kind. Each runs with the requester's own permissions (RLS + captured list). */
export type ExportBuilder = (
  tx: TenantTx,
  params: unknown,
  permissions: readonly string[],
  store: BlobStore,
  now: Date,
) => Promise<{ bytes: Uint8Array; ext: 'zip' | 'pdf' | 'json'; summary: Record<string, unknown> }>;

const EXPORT_BUILDERS: Record<string, ExportBuilder> = {
  EVIDENCE_PACK: async (tx, params, perms, store, now) => {
    const out = await buildEvidencePack(tx, params as PackParams, perms, store, now);
    return { bytes: out.zip, ext: 'zip', summary: { files: out.files, gaps: out.gaps } };
  },
  MANAGEMENT_PACK: async (tx, params, _perms, _store, now) => {
    const out = await buildManagementPack(
      tx,
      params as { month: string; from: string; to: string; locationId?: string },
      now,
    );
    return { bytes: out.pdf, ext: 'pdf', summary: { reports: out.reports } };
  },
  SAR: async (tx, params, _perms, store, now) => {
    const out = await buildSubjectAccessExport(tx, params as { requestId: string }, store, now);
    return { bytes: out.zip, ext: 'zip', summary: { files: out.files } };
  },
  FULL_EXPORT: async (tx, _params, _perms, store, now) => {
    const out = await buildFullExport(tx, store, now);
    return {
      bytes: out.zip,
      ext: 'zip',
      summary: { tables: out.tables, rows: out.rows, attachments: out.attachments },
    };
  },
};

/** Later slices (full export, SAR) register their builders here. */
export function registerExportBuilder(kind: string, b: ExportBuilder): void {
  EXPORT_BUILDERS[kind] = b;
}

async function buildExport(
  tx: TenantTx,
  kind: string,
  params: unknown,
  permissions: readonly string[],
  store: BlobStore,
  now: Date,
) {
  const b = EXPORT_BUILDERS[kind];
  if (!b) throw new Error(`No builder for export kind ${kind}`);
  return b(tx, params, permissions, store, now);
}

export async function runPendingExports(
  db: Db,
  store: BlobStore,
  now: () => Date = () => new Date(),
): Promise<number> {
  let done = 0;
  for (const orgId of await db.listOrganisations()) {
    const jobs = await db.withTenant(
      { orgId, userId: '00000000-0000-7000-8000-000000000000' },
      (tx) =>
        tx.exportJob.findMany({
          where: { status: 'QUEUED' },
          orderBy: { createdAt: 'asc' },
          take: 5,
        }),
    );
    for (const job of jobs) {
      // Build with the requester's own permissions so the pack never shows more than they could see.
      const ctx = { orgId, userId: job.requestedBy, permissions: job.requesterPermissions };
      try {
        await db.withTenant(ctx, (tx) =>
          tx.exportJob.update({
            where: { id: job.id },
            data: { status: 'RUNNING', startedAt: now() },
          }),
        );
        const out = await db.withTenant(ctx, (tx) =>
          buildExport(tx, job.kind, job.params, job.requesterPermissions, store, now()),
        );
        const key = `${orgId}/exports/${job.id}.${out.ext}`;
        await store.put(key, Buffer.from(out.bytes));
        await db.withTenant(ctx, async (tx) => {
          await tx.exportJob.update({
            where: { id: job.id },
            data: {
              status: 'DONE',
              blobKey: key,
              bytes: BigInt(out.bytes.length),
              finishedAt: now(),
            },
          });
          await db.appendAudit(tx, {
            orgId,
            actorUserId: null,
            actorType: 'SYSTEM',
            action: 'export.generated',
            entity: 'export_job',
            entityId: job.id,
            afterSummary: { kind: job.kind, ...out.summary },
          });
        });
        done += 1;
      } catch (e) {
        await db.withTenant(ctx, (tx) =>
          tx.exportJob.update({
            where: { id: job.id },
            data: {
              status: 'FAILED',
              error: (e instanceof Error ? e.message : 'failed').slice(0, 200),
              finishedAt: now(),
            },
          }),
        );
      }
    }
  }
  return done;
}
