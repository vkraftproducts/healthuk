import type { Db, TenantTx } from '@hub/db';
import {
  auditOutcome,
  dashboardCounts,
  evidenceCoverage,
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
};
export async function nextCode(
  tx: TenantTx,
  orgId: string,
  prefix: 'AUD' | 'ACT' | 'EVT' | 'RSK' | 'J' | 'IMP' | 'DSR' | 'BRE',
): Promise<string> {
  const rows = await tx.$queryRaw<
    { code: string }[]
  >`SELECT next_code(${orgId}::uuid, ${prefix}, ${START[prefix]}::int) AS code`;
  return rows[0]!.code;
}

export async function createAction(
  tx: TenantTx,
  a: {
    organisationId: string;
    sourceType: 'FINDING' | 'EVENT' | 'RISK' | 'CORRESPONDENCE';
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
  const actions = await tx.action.findMany({
    where: { sourceType: 'FINDING', sourceId: { in: run.findings.map((f) => f.id) } },
  });
  const o = auditOutcome(
    run.findings.map((f) => ({
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
  deadline: string | null;
  status: RagStatus;
  reasonText: string;
  /** Which tiles this row is counted in: every tile number equals its drill-down rows. */
  tiles: string[];
  link: { type: string; id: string };
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
export async function dashboardRows(
  tx: TenantTx,
  f: { locationId?: string; module?: string },
  now: Date,
): Promise<{ rows: ActionRowOut[]; results: (RequirementResult & { module: Module })[] }> {
  const today = londonDate(now);
  const instances = await tx.requirementInstance.findMany({
    where: {
      ...(f.locationId ? { OR: [{ locationId: f.locationId }, { locationId: null }] } : {}),
    },
    include: { template: { select: { title: true } } },
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
      link: { type: 'REQUIREMENT', id: i.id },
    });
  }
  if (!f.module || f.module === 'FLEET') {
    for (const v of vehicles) {
      if (v.status === 'AVAILABLE') continue;
      if (f.locationId && v.baseLocationId !== f.locationId) continue;
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
  }
  if (!f.module || f.module === 'COMPLIANCE') {
    const actions = await tx.action.findMany({ where: { status: { not: 'VERIFIED' } } });
    for (const a of actions) {
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
    for (const c of critical)
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
  }
  if (!f.module) {
    const obligations = await tx.reportingObligation.findMany({
      where: { OR: [{ decision: 'PENDING' }, { decision: 'REQUIRED', submittedAt: null }] },
      include: { event: { select: { code: true, leadUserId: true } } },
    });
    for (const o of obligations) {
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
  if (!f.module) {
    // Today's journeys (London day). Job code and time only: no patient details on the dashboard.
    const jobs = await tx.job.findMany({
      where: {
        journeyDate: new Date(`${today}T00:00:00Z`),
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
  const rank: Record<string, number> = { RED: 0, AMBER: 1, GREY: 2, GREEN: 3, NOT_APPLICABLE: 4 };
  rows.sort(
    (a, b) =>
      rank[a.status]! - rank[b.status]! ||
      (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999') ||
      a.key.localeCompare(b.key),
  );
  return { rows, results };
}

export async function dashboardSummary(
  tx: TenantTx,
  f: { locationId?: string; module?: string },
  now: Date,
) {
  const { rows, results } = await dashboardRows(tx, f, now);
  const count = (tile: string) => rows.filter((r) => r.tiles.includes(tile)).length;
  const mod = (m: Module) => results.filter((r) => r.module === m);
  const counts = dashboardCounts(results);
  const fleetBlocked = count('blockedVehicles');
  return {
    tiles: {
      overdue: count('overdue'),
      dueSoon: count('dueSoon'),
      blockedVehicles: fleetBlocked,
      jobsToday: count('jobsToday'),
      unverified: count('unverified'),
    },
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
    ],
    operations: {
      jobsAwaitingAllocation: count('awaitingAllocation'),
      acknowledgementsDue: count('acknowledgementsDue'),
    },
    criticalOpen: rows.filter((r) => r.key.startsWith('FND:')).length,
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
  from: string;
  to: string;
}

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
  const instances = await tx.requirementInstance.findMany({
    where: p.locationId ? { OR: [{ locationId: p.locationId }, { locationId: null }] } : {},
    include: {
      template: { select: { code: true, title: true } },
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
  const inDomain = (maps: unknown) =>
    !p.domain ||
    (Array.isArray(maps) && maps.some((m) => (m as { domain?: string }).domain === p.domain));
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
  const lines: string[] = [
    `Period: ${p.from} to ${p.to}. Generated ${now.toISOString()} (Europe/London dates).`,
    'Internal measure - not a CQC rating. Statuses are as at generation time.',
    '',
    '# Requirements and evidence',
  ];
  let gaps = 0;
  for (const i of instances) {
    if (!inDomain(i.templateVersion.frameworkMappings)) continue;
    const ok = i.status === 'GREEN' || i.status === 'NOT_APPLICABLE';
    if (!ok) gaps += 1;
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
        const bytes = await store.get(v.blobKey);
        if (!bytes) continue;
        const ext =
          (v.mime ?? '')
            .split('/')[1]
            ?.replace('vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx') ??
          'bin';
        const name = `evidence/${fileSafe(i.template.code)}/${fileSafe(l.item.title)}-v${v.versionNo}.${fileSafe(ext)}`;
        files[name] = new Uint8Array(bytes);
        any = true;
        const validTo = iso(ver.confirmedValidTo ?? v.validTo);
        lines.push(
          `   evidence: ${name} (valid to ${validTo ?? 'no end date'}), verified ${ver.createdAt.toISOString().slice(0, 10)} by reviewer ${ver.reviewerId}`,
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
          name,
          validTo ?? '',
          ver.reviewerId,
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
  const runs = await tx.auditRun.findMany({
    where: {
      dueDate: { gte: from, lte: to },
      ...(p.locationId ? { locationId: p.locationId } : {}),
    },
    include: { findings: true, templateVersion: { include: { template: true } } },
  });
  lines.push('', '# Audits in the period');
  for (const r of runs) {
    if (p.domain && r.templateVersion.template.domain !== p.domain) continue;
    lines.push(
      `${r.code} ${r.title} (${r.templateVersion.template.code} v${r.templateVersion.version}) - ${r.outcome ?? 'not submitted'}${r.outcomeReason ? `: ${r.outcomeReason}` : ''}`,
    );
    for (const f of r.findings) lines.push(`   ${f.controlCode}: ${f.summary} (${f.result})`);
  }
  const actions = await tx.action.findMany({
    where: { status: { not: 'VERIFIED' } },
    orderBy: { deadline: 'asc' },
  });
  lines.push('', '# Open actions');
  for (const a of actions)
    lines.push(`${a.code} ${a.title} - ${a.status}, deadline ${iso(a.deadline)}`);
  if (actions.length === 0) lines.push('None');
  const policies = await tx.policyVersion.findMany({
    where: { status: 'PUBLISHED' },
    include: { document: true, _count: { select: { acks: true } } },
  });
  lines.push('', '# Published policies');
  for (const v of policies)
    lines.push(
      `${v.document.code} ${v.document.title} v${v.version} - approved by ${v.approvedBy ?? 'n/a'}, ${v._count.acks} acknowledgement(s)`,
    );
  lines.push('', `Open gaps: ${gaps}`);

  files['index.pdf'] = await renderPdf('Inspection evidence pack', lines);
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
