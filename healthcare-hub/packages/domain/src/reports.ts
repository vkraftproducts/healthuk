import type { TenantTx } from '@hub/db';
import {
  AGE_BANDS,
  ageBand,
  endOfLondonDay,
  londonDate,
  monthsIn,
  percent,
  punctual,
  REPORTS,
  startOfLondonDay,
  type ISODate,
  type MeasureDefinition,
  type ReportId,
} from '@hub/rules';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { planStatus } from './fleet.js';
import { staffStatusSummary } from './staff.js';

/** Report output: measures with their documented definitions, plus tables for the detail. */
export interface ReportMeasure {
  key: string;
  label: string;
  value: number | null;
  unit: 'PERCENT' | 'COUNT';
  numerator: number | null;
  denominator: number | null;
  definition: MeasureDefinition;
}
export interface ReportTable {
  key: string;
  title: string;
  columns: string[];
  rows: (string | number | null)[][];
}
export interface ReportData {
  id: ReportId;
  title: string;
  summary: string;
  period: { from: ISODate; to: ISODate };
  locationId: string | null;
  generatedAt: string;
  measures: ReportMeasure[];
  tables: ReportTable[];
}
export interface ReportQuery {
  from: ISODate;
  to: ISODate;
  locationId?: string;
}

const TASK = /SUPERVISION|APPRAISAL/;
const DAY = 86_400_000;

function measure(
  id: ReportId,
  key: string,
  v: { numerator?: number | null; denominator: number; count?: boolean },
): ReportMeasure {
  const def = REPORTS.find((r) => r.id === id)!.measures.find((m) => m.key === key)!;
  const n = v.numerator ?? null;
  return {
    key,
    label: def.label,
    value: v.count ? v.denominator : percent(n ?? 0, v.denominator),
    unit: v.count ? 'COUNT' : 'PERCENT',
    numerator: v.count ? null : n,
    denominator: v.denominator,
    definition: def,
  };
}

/**
 * Computes one report inside the caller's tenant transaction, so row-level security limits it to
 * what the viewer may see (restricted events, location scope). Pure counting rules live in
 * @hub/rules (reports.ts); this function only gathers rows.
 */
export async function computeReport(
  tx: TenantTx,
  id: ReportId,
  q: ReportQuery,
  now: Date,
): Promise<ReportData> {
  const def = REPORTS.find((r) => r.id === id)!;
  const start = startOfLondonDay(q.from);
  const end = endOfLondonDay(q.to);
  const loc = q.locationId;
  const base = {
    id,
    title: def.title,
    summary: def.summary,
    period: { from: q.from, to: q.to },
    locationId: loc ?? null,
    generatedAt: now.toISOString(),
  };
  const out = (measures: ReportMeasure[], tables: ReportTable[]): ReportData => ({
    ...base,
    measures,
    tables,
  });

  switch (id) {
    case 'WORKFORCE_READINESS': {
      const staff = await tx.staff.findMany({
        where: { lifecycleState: { not: 'LEAVER' }, ...(loc ? { primaryLocationId: loc } : {}) },
        select: { id: true },
      });
      const summary = await staffStatusSummary(
        tx,
        staff.map((s) => s.id),
        now,
      );
      const ready = [...summary.values()].filter(
        (s) => s.counts.red + s.counts.amber + s.counts.grey === 0,
      ).length;
      const gaps = await tx.requirementInstance.findMany({
        where: {
          subjectType: 'STAFF',
          subjectId: { in: staff.map((s) => s.id) },
          status: { in: ['RED', 'AMBER', 'GREY'] },
        },
        select: { status: true, template: { select: { title: true } } },
      });
      const byTitle = new Map<string, { red: number; amber: number; grey: number }>();
      for (const g of gaps) {
        const c = byTitle.get(g.template.title) ?? { red: 0, amber: 0, grey: 0 };
        c[g.status.toLowerCase() as 'red' | 'amber' | 'grey'] += 1;
        byTitle.set(g.template.title, c);
      }
      return out(
        [
          measure(id, 'ready', { numerator: ready, denominator: staff.length }),
          measure(id, 'gaps', { denominator: gaps.length, count: true }),
        ],
        [
          {
            key: 'gaps',
            title: 'Gaps by requirement',
            columns: ['Requirement', 'Red', 'Amber', 'Awaiting verification', 'Total'],
            rows: [...byTitle.entries()]
              .map(([t, c]) => [t, c.red, c.amber, c.grey, c.red + c.amber + c.grey])
              .sort(
                (a, b) =>
                  (b[4] as number) - (a[4] as number) || String(a[0]).localeCompare(String(b[0])),
              ),
          },
        ],
      );
    }

    case 'SUPERVISION': {
      const staff = await tx.staff.findMany({
        where: { lifecycleState: { not: 'LEAVER' }, ...(loc ? { primaryLocationId: loc } : {}) },
        select: { id: true },
      });
      const items = (
        await tx.requirementInstance.findMany({
          where: { subjectType: 'STAFF', subjectId: { in: staff.map((s) => s.id) } },
          select: { status: true, template: { select: { code: true, title: true } } },
        })
      ).filter((i) => TASK.test(i.template.code) && i.status !== 'NOT_APPLICABLE');
      const by = new Map<string, { planned: number; done: number; overdue: number }>();
      for (const i of items) {
        const c = by.get(i.template.title) ?? { planned: 0, done: 0, overdue: 0 };
        c.planned += 1;
        if (i.status === 'GREEN') c.done += 1;
        if (i.status === 'RED') c.overdue += 1;
        by.set(i.template.title, c);
      }
      const done = items.filter((i) => i.status === 'GREEN').length;
      return out(
        [measure(id, 'completed', { numerator: done, denominator: items.length })],
        [
          {
            key: 'byType',
            title: 'By supervision or appraisal type',
            columns: ['Type', 'Planned', 'Completed and current', 'Overdue'],
            rows: [...by.entries()].map(([t, c]) => [t, c.planned, c.done, c.overdue]),
          },
        ],
      );
    }

    case 'FLEET': {
      const vehicles = await tx.vehicle.findMany({
        where: loc ? { baseLocationId: loc } : {},
        select: { id: true, callsign: true, status: true, statusReason: true },
        orderBy: { callsign: 'asc' },
      });
      const ids = vehicles.map((v) => v.id);
      const defects = await tx.defect.findMany({
        where: {
          discoveredAt: { gte: start, lte: end },
          ...(loc ? { vehicleId: { in: ids } } : {}),
        },
        select: { severity: true, vehicleId: true, status: true },
      });
      const open = await tx.defect.groupBy({
        by: ['vehicleId'],
        where: { status: { in: ['OPEN', 'REPAIRING'] }, vehicleId: { in: ids } },
        _count: { _all: true },
      });
      const plans = await tx.maintenancePlan.findMany({
        where: { active: true, vehicleId: { in: ids } },
      });
      const overdue: (string | number | null)[][] = [];
      for (const p of plans) {
        const odo = await tx.odometerReading.findFirst({
          where: {
            vehicleId: p.vehicleId,
            NOT: { flags: { hasSome: ['ODOMETER_DECREASED', 'ODOMETER_IMPLAUSIBLE_JUMP'] } },
          },
          orderBy: [{ readOn: 'desc' }, { createdAt: 'desc' }],
        });
        const st = planStatus(p, odo?.reading ?? null, now);
        if (st.state === 'OVERDUE')
          overdue.push([
            vehicles.find((v) => v.id === p.vehicleId)?.callsign ?? 'Vehicle',
            p.title,
            st.dueDate,
            st.dueOdometer,
            st.text,
          ]);
      }
      const sev = (s: string) => defects.filter((d) => d.severity === s).length;
      return out(
        [
          measure(id, 'available', {
            numerator: vehicles.filter((v) => v.status === 'AVAILABLE').length,
            denominator: vehicles.length,
          }),
          measure(id, 'defects', { denominator: defects.length, count: true }),
          measure(id, 'maintenance', { numerator: overdue.length, denominator: plans.length }),
        ],
        [
          {
            key: 'vehicles',
            title: 'Vehicles',
            columns: ['Vehicle', 'Status', 'Reason', 'Open defects'],
            rows: vehicles.map((v) => [
              v.callsign,
              v.status,
              v.statusReason,
              open.find((o) => o.vehicleId === v.id)?._count._all ?? 0,
            ]),
          },
          {
            key: 'defects',
            title: 'Defects reported in the period',
            columns: ['Severity', 'Count'],
            rows: [
              ['Critical', sev('CRITICAL')],
              ['Major', sev('MAJOR')],
              ['Minor', sev('MINOR')],
            ],
          },
          {
            key: 'maintenance',
            title: 'Maintenance overdue',
            columns: ['Vehicle', 'Plan', 'Due date', 'Due mileage', 'Reason'],
            rows: overdue,
          },
        ],
      );
    }

    case 'AUDITS_ACTIONS': {
      const runs = await tx.auditRun.findMany({
        where: {
          dueDate: { gte: startOfLondonDay(q.from), lte: startOfLondonDay(q.to) },
          ...(loc ? { locationId: loc } : {}),
        },
        select: { code: true, title: true, dueDate: true, status: true, submittedAt: true },
        orderBy: { dueDate: 'asc' },
      });
      const late = runs.filter((r) => {
        const due = endOfLondonDay(londonDate(r.dueDate));
        return r.submittedAt ? r.submittedAt > due : due < now && r.status !== 'CLOSED';
      });
      const actions = await tx.action.findMany({
        where: { status: { not: 'VERIFIED' } },
        select: { createdAt: true, deadline: true },
      });
      const today = startOfLondonDay(londonDate(now)).getTime();
      const band = new Map(AGE_BANDS.map((b) => [b, { open: 0, overdue: 0 }]));
      for (const a of actions) {
        const age = Math.max(
          0,
          Math.floor((today - startOfLondonDay(londonDate(a.createdAt)).getTime()) / DAY),
        );
        const c = band.get(ageBand(age))!;
        c.open += 1;
        if (endOfLondonDay(londonDate(a.deadline)) < now) c.overdue += 1;
      }
      return out(
        [
          measure(id, 'auditsOverdue', { numerator: late.length, denominator: runs.length }),
          measure(id, 'actionAge', { denominator: actions.length, count: true }),
        ],
        [
          {
            key: 'lateAudits',
            title: 'Audits late',
            columns: ['Audit', 'Title', 'Due', 'Status', 'Submitted'],
            rows: late.map((r) => [
              r.code,
              r.title,
              londonDate(r.dueDate),
              r.status,
              r.submittedAt ? londonDate(r.submittedAt) : null,
            ]),
          },
          {
            key: 'actionAge',
            title: 'Open actions by age (days since raised)',
            columns: ['Age (days)', 'Open', 'Past deadline'],
            rows: AGE_BANDS.map((b) => [b, band.get(b)!.open, band.get(b)!.overdue]),
          },
        ],
      );
    }

    case 'EVENTS': {
      const events = await tx.event.findMany({
        where: { occurredAt: { gte: start, lte: end }, ...(loc ? { locationId: loc } : {}) },
        select: { types: true, occurredAt: true },
      });
      const months = monthsIn(q.from, q.to);
      const TYPES = [
        'INCIDENT',
        'ACCIDENT',
        'NEAR_MISS',
        'SAFEGUARDING',
        'COMPLAINT',
        'COMPLIMENT',
        'DEFECT',
      ];
      const grid = months.map((m) => [
        m,
        ...TYPES.map(
          (t) =>
            events.filter((e) => londonDate(e.occurredAt).startsWith(m) && e.types.includes(t))
              .length,
        ),
      ]);
      const complaints = await tx.complaintDetail.findMany({
        where: {
          receivedOn: { gte: startOfLondonDay(q.from), lte: startOfLondonDay(q.to) },
          ...(loc ? { event: { locationId: loc } } : {}),
        },
        select: { respondBy: true, respondedOn: true },
      });
      const todayIso = londonDate(now);
      const measurable = complaints.filter(
        (c) => c.respondedOn || londonDate(c.respondBy) < todayIso,
      );
      const onTime = measurable.filter(
        (c) => c.respondedOn && londonDate(c.respondedOn) <= londonDate(c.respondBy),
      ).length;
      return out(
        [
          measure(id, 'byMonth', { denominator: events.length, count: true }),
          measure(id, 'complaintsOnTime', { numerator: onTime, denominator: measurable.length }),
        ],
        [
          {
            key: 'byMonth',
            title: 'Events by month and type',
            columns: [
              'Month',
              'Incident',
              'Accident',
              'Near miss',
              'Safeguarding',
              'Complaint',
              'Compliment',
              'Defect',
            ],
            rows: grid,
          },
        ],
      );
    }

    case 'POLICY_ACK': {
      const versions = await tx.policyVersion.findMany({
        where: { status: { in: ['PUBLISHED', 'SUPERSEDED'] } },
        include: { document: true },
        orderBy: [{ documentId: 'asc' }, { version: 'desc' }],
      });
      const members = await tx.membership.findMany({
        where: {
          validFrom: { lte: now },
          OR: [{ validTo: null }, { validTo: { gt: now } }],
        },
        select: { userId: true, role: { select: { key: true } } },
      });
      const acks = await tx.policyAcknowledgement.findMany({
        where: { policyVersionId: { in: versions.map((v) => v.id) } },
        select: { policyVersionId: true, userId: true },
      });
      const rows: (string | number | null)[][] = [];
      let num = 0;
      let den = 0;
      for (const v of versions) {
        const readers = new Set(
          members.filter((m) => v.document.readerRoles.includes(m.role.key)).map((m) => m.userId),
        );
        const done = new Set(
          acks
            .filter((a) => a.policyVersionId === v.id && readers.has(a.userId))
            .map((a) => a.userId),
        ).size;
        if (v.status === 'PUBLISHED') {
          num += done;
          den += readers.size;
        }
        rows.push([
          v.document.code,
          v.document.title,
          v.version,
          v.status,
          done,
          readers.size,
          percent(done, readers.size),
        ]);
      }
      return out(
        [measure(id, 'acknowledged', { numerator: num, denominator: den })],
        [
          {
            key: 'versions',
            title: 'By policy version',
            columns: ['Policy', 'Title', 'Version', 'Status', 'Acknowledged', 'Readers', '%'],
            rows,
          },
        ],
      );
    }

    case 'PREMISES': {
      const items = await tx.premisesItem.findMany({
        where: loc ? { locationId: loc } : {},
        orderBy: [{ locationId: 'asc' }, { controlArea: 'asc' }, { title: 'asc' }],
      });
      const inst = await tx.requirementInstance.findMany({
        where: {
          id: { in: items.map((i) => i.requirementInstanceId).filter((x): x is string => !!x) },
        },
        select: { id: true, status: true, reasonText: true },
      });
      const locations = await tx.location.findMany({ select: { id: true, name: true } });
      const applicable = items.filter((i) => i.applicable);
      const green = applicable.filter(
        (i) => inst.find((r) => r.id === i.requirementInstanceId)?.status === 'GREEN',
      ).length;
      return out(
        [measure(id, 'compliant', { numerator: green, denominator: applicable.length })],
        [
          {
            key: 'items',
            title: 'Premises checks',
            columns: ['Location', 'Area', 'Check', 'Status', 'Reason'],
            rows: items.map((i) => {
              const r = inst.find((x) => x.id === i.requirementInstanceId);
              return [
                locations.find((l) => l.id === i.locationId)?.name ?? 'Location',
                i.controlArea,
                i.title,
                i.applicable ? (r?.status ?? 'GREY') : 'NOT_APPLICABLE',
                i.applicable
                  ? (r?.reasonText ?? 'No requirement linked')
                  : (i.applicabilityReason ?? 'Not applicable'),
              ];
            }),
          },
        ],
      );
    }

    case 'JOURNEYS': {
      const jobs = await tx.job.findMany({
        where: {
          journeyDate: { gte: startOfLondonDay(q.from), lte: startOfLondonDay(q.to) },
          ...(loc ? { locationId: loc } : {}),
        },
        select: { id: true, state: true, pickupTo: true },
      });
      const arrivals = await tx.jobStatusEvent.findMany({
        where: { jobId: { in: jobs.map((j) => j.id) }, toState: 'ARRIVED' },
        select: { jobId: true, capturedAt: true },
        orderBy: { capturedAt: 'asc' },
      });
      const first = new Map<string, Date>();
      for (const a of arrivals) if (!first.has(a.jobId)) first.set(a.jobId, a.capturedAt);
      const withArrival = jobs.filter((j) => first.has(j.id));
      const onTime = withArrival.filter((j) => punctual(first.get(j.id)!, j.pickupTo)).length;
      const OUTCOMES: [string, string[]][] = [
        ['Completed', ['COMPLETED', 'HANDOVER_COMPLETE']],
        ['Cancelled', ['CANCELLED']],
        ['Aborted', ['ABORTED']],
        ['Refused', ['REFUSED']],
        ['No access', ['NO_ACCESS']],
      ];
      const counted = OUTCOMES.flatMap(([, s]) => s);
      return out(
        [
          measure(id, 'punctual', { numerator: onTime, denominator: withArrival.length }),
          measure(id, 'outcomes', { denominator: jobs.length, count: true }),
        ],
        [
          {
            key: 'outcomes',
            title: 'Journeys by outcome',
            columns: ['Outcome', 'Journeys', '%'],
            rows: [
              ...OUTCOMES.map(([label, states]) => {
                const n = jobs.filter((j) => states.includes(j.state)).length;
                return [label, n, percent(n, jobs.length)];
              }),
              (() => {
                const n = jobs.filter((j) => !counted.includes(j.state)).length;
                return ['Open or in progress', n, percent(n, jobs.length)];
              })(),
            ],
          },
        ],
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Monthly management pack (PDF): every report for one month, with definitions.
// ---------------------------------------------------------------------------
const safe = (s: string) =>
  s
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/£/g, 'GBP ')
    .replace(/[^\x20-\x7E]/g, '?');

class Writer {
  page!: PDFPage;
  y = 0;
  constructor(
    private doc: PDFDocument,
    private font: PDFFont,
    private bold: PDFFont,
    private footer: string,
  ) {
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage([595, 842]);
    this.y = 800;
    this.page.drawText(safe(this.footer), {
      x: 40,
      y: 24,
      size: 8,
      font: this.font,
      color: rgb(0.3, 0.3, 0.3),
    });
  }
  text(s: string, o: { size?: number; bold?: boolean; indent?: number; gap?: number } = {}) {
    const size = o.size ?? 10;
    const font = o.bold ? this.bold : this.font;
    const width = 515 - (o.indent ?? 0);
    const words = safe(s).split(' ');
    let line = '';
    const lines: string[] = [];
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        lines.push(line);
        line = w;
      } else line = next;
    }
    lines.push(line);
    for (const l of lines) {
      if (this.y < 50) this.newPage();
      this.page.drawText(l, { x: 40 + (o.indent ?? 0), y: this.y, size, font });
      this.y -= size + 4;
    }
    this.y -= o.gap ?? 0;
  }
}

/** Builds the PDF for one month. Internal measures only: never a CQC rating. */
export async function buildManagementPack(
  tx: TenantTx,
  p: { month: string; from: ISODate; to: ISODate; locationId?: string },
  now: Date,
): Promise<{ pdf: Uint8Array; reports: number }> {
  const org = await tx.organisation.findFirst({ select: { name: true } });
  const loc = p.locationId
    ? await tx.location.findUnique({ where: { id: p.locationId }, select: { name: true } })
    : null;
  const doc = await PDFDocument.create();
  doc.setTitle(`Management pack ${p.month}`);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(
    doc,
    font,
    bold,
    `Internal measure - not a CQC rating. Generated ${now.toISOString()} for ${p.from} to ${p.to}.`,
  );
  w.text(`Monthly management pack - ${p.month}`, { size: 18, bold: true, gap: 4 });
  w.text(`${org?.name ?? 'Organisation'} - ${loc?.name ?? 'All locations'}`, { size: 12, gap: 2 });
  w.text(
    `Period ${p.from} to ${p.to} (London dates). Snapshot measures are as at ${londonDate(now)}.`,
    { gap: 2 },
  );
  w.text('Internal measures to support management review. They are not CQC ratings.', {
    bold: true,
    gap: 10,
  });
  for (const r of REPORTS) {
    const d = await computeReport(
      tx,
      r.id,
      { from: p.from, to: p.to, ...(p.locationId ? { locationId: p.locationId } : {}) },
      now,
    );
    if (w.y < 200) w.newPage();
    w.text(d.title, { size: 14, bold: true, gap: 2 });
    for (const m of d.measures) {
      const value =
        m.value === null
          ? 'no data'
          : m.unit === 'PERCENT'
            ? `${m.value}% (${m.numerator} of ${m.denominator})`
            : String(m.value);
      w.text(`${m.label}: ${value}`, { bold: true });
      w.text(
        `Denominator: ${m.definition.denominator}. Period: ${m.definition.period}. Includes: ${m.definition.inclusion}.`,
        { size: 8, indent: 10, gap: 2 },
      );
    }
    for (const t of d.tables) {
      if (t.rows.length === 0) continue;
      w.text(t.title, { size: 10, bold: true, gap: 1 });
      w.text(t.columns.join(' | '), { size: 8, bold: true, indent: 10 });
      for (const row of t.rows.slice(0, 40))
        w.text(row.map((c) => (c === null ? '-' : String(c))).join(' | '), { size: 8, indent: 10 });
      if (t.rows.length > 40)
        w.text(`... ${t.rows.length - 40} more rows in the CSV export`, { size: 8, indent: 10 });
      w.y -= 4;
    }
    w.y -= 8;
  }
  return { pdf: await doc.save(), reports: REPORTS.length };
}
