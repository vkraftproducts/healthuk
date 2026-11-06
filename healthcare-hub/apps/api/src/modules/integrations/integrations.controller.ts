import { Body, Controller, Get, Inject, Param, Post, Query, StreamableFile } from '@nestjs/common';
import type { Db, TenantTx } from '@hub/db';
import { recordOdometer } from '@hub/domain';
import { londonDate } from '@hub/rules';
import {
  IntegrationAdapter,
  IntegrationConnect,
  IntegrationSync,
  PayrollQuery,
  type IntegrationDto,
  type IntegrationList,
  type IntegrationRunDto,
} from '@hub/contracts';
import { RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { audit, body } from '../../common/http.js';
import { toCsv } from '../../common/csv.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import {
  externalId,
  fuelTransaction,
  icsStamp,
  icsText,
  telematicsDelta,
  trainingCompletions,
} from './mock-feeds.js';

const PERM = 'admin.settings.manage';
const NOTICE =
  'Mock integrations only. No external system is contacted and every record is synthetic. Live ' +
  'connections need confirmed API access and credentials, which are not available yet.';

interface AdapterInfo {
  name: string;
  direction: 'INBOUND' | 'OUTBOUND';
  summary: string;
  treatment: string;
}
const ADAPTERS: Record<IntegrationAdapter, AdapterInfo> = {
  TELEMATICS: {
    name: 'Vehicle telematics',
    direction: 'INBOUND',
    summary: 'Daily odometer readings for each active vehicle.',
    treatment:
      'Stored as readings from source TELEMATICS and checked like any other reading: a decrease or an implausible jump is flagged and never moves the vehicle odometer.',
  },
  FLEETX: {
    name: 'FleetX fuel cards',
    direction: 'INBOUND',
    summary: 'Fuel-card transactions matched to vehicles.',
    treatment:
      'Created as submitted fuel expenses. Someone with approval rights still decides each one; possible duplicates are marked.',
  },
  TRAINING: {
    name: 'Training provider',
    direction: 'INBOUND',
    summary: 'Course completions matched to staff numbers.',
    treatment:
      'Stored as unverified training records, not linked to any requirement. A reviewer must verify evidence before a requirement can turn green.',
  },
  PAYROLL: {
    name: 'Payroll export',
    direction: 'OUTBOUND',
    summary: 'CSV of planned shift hours per staff member for a period.',
    treatment: 'Hours only. No pay rates, no sensitive HR data. Every export is audited.',
  },
  CALENDAR: {
    name: 'Calendar feed',
    direction: 'OUTBOUND',
    summary: 'iCalendar file of upcoming shifts.',
    treatment: 'Shift times and vehicle callsign only. No patient or job details.',
  },
};
const ORDER: IntegrationAdapter[] = ['TELEMATICS', 'FLEETX', 'TRAINING', 'PAYROLL', 'CALENDAR'];

const parseAdapter = (v: string): IntegrationAdapter => {
  const r = IntegrationAdapter.safeParse(v);
  if (!r.success) throw notFound();
  return r.data;
};
const dayOf = (s: string) => new Date(`${s}T00:00:00.000Z`);

interface Outcome {
  seen: number;
  applied: number;
  flagged: number;
  skipped: number;
  notes: string[];
}

type Run = Awaited<ReturnType<TenantTx['integrationRun']['create']>>;
const runDto = (r: Run): IntegrationRunDto => ({
  id: r.id,
  adapter: r.adapter as IntegrationAdapter,
  direction: r.direction as IntegrationRunDto['direction'],
  status: r.status as IntegrationRunDto['status'],
  scenario: r.scenario,
  startedAt: r.startedAt.toISOString(),
  finishedAt: r.finishedAt.toISOString(),
  recordsSeen: r.recordsSeen,
  recordsApplied: r.recordsApplied,
  recordsFlagged: r.recordsFlagged,
  recordsSkipped: r.recordsSkipped,
  notes: r.notes,
  error: r.error,
});

/**
 * INT-01. Mock adapters only: each reads a deterministic synthetic feed and writes through the
 * same domain rules as manual entry. Inbound data never verifies anything by itself.
 */
@Controller('integrations')
export class IntegrationsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission(PERM)
  @Get()
  async list(@Hub() hub: HubRequestContext): Promise<IntegrationList> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const conns = await tx.integrationConnection.findMany();
      const by = new Map(conns.map((c) => [c.adapter, c]));
      const runs = await tx.integrationRun.findMany({ orderBy: { startedAt: 'desc' }, take: 20 });
      const data: IntegrationDto[] = ORDER.map((a) => {
        const c = by.get(a);
        return {
          adapter: a,
          ...ADAPTERS[a],
          connected: !!c?.enabled,
          mode: c ? 'MOCK' : null,
          lastRunAt: c?.lastRunAt?.toISOString() ?? null,
          lastStatus: (c?.lastStatus as IntegrationDto['lastStatus']) ?? null,
        };
      });
      return { data, recentRuns: runs.map(runDto), notice: NOTICE };
    });
  }

  @RequirePermission(PERM)
  @Post(':adapter/connect')
  async connect(
    @Hub() hub: HubRequestContext,
    @Param('adapter') adapterRaw: string,
    @Body() raw: unknown,
  ): Promise<IntegrationDto> {
    const adapter = parseAdapter(adapterRaw);
    const input = body(IntegrationConnect, raw ?? {});
    if (input.mode === 'LIVE')
      throw new HubError(
        'CONFLICT',
        409,
        'Live connections are not available: API access and credentials are not confirmed. Use the mock connection.',
      );
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const c = await tx.integrationConnection.upsert({
        where: { organisationId_adapter: { organisationId: hub.orgId as string, adapter } },
        update: { enabled: true },
        create: { organisationId: hub.orgId as string, adapter, createdBy: hub.user.id },
      });
      await audit(this.db, tx, hub, {
        action: 'integrations.connect',
        entity: 'integration_connection',
        entityId: c.id,
        summary: { adapter, mode: 'MOCK' },
      });
      return {
        adapter,
        ...ADAPTERS[adapter],
        connected: true,
        mode: 'MOCK',
        lastRunAt: c.lastRunAt?.toISOString() ?? null,
        lastStatus: (c.lastStatus as IntegrationDto['lastStatus']) ?? null,
      };
    });
  }

  @RequirePermission(PERM)
  @Post(':adapter/disconnect')
  async disconnect(
    @Hub() hub: HubRequestContext,
    @Param('adapter') adapterRaw: string,
  ): Promise<{ ok: true }> {
    const adapter = parseAdapter(adapterRaw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const c = await tx.integrationConnection.findUnique({
        where: { organisationId_adapter: { organisationId: hub.orgId as string, adapter } },
      });
      if (!c) throw notFound();
      await tx.integrationConnection.update({ where: { id: c.id }, data: { enabled: false } });
      await audit(this.db, tx, hub, {
        action: 'integrations.disconnect',
        entity: 'integration_connection',
        entityId: c.id,
        summary: { adapter },
      });
      return { ok: true as const };
    });
  }

  @RequirePermission(PERM)
  @Post(':adapter/sync')
  async sync(
    @Hub() hub: HubRequestContext,
    @Param('adapter') adapterRaw: string,
    @Body() raw: unknown,
  ): Promise<IntegrationRunDto> {
    const adapter = parseAdapter(adapterRaw);
    if (ADAPTERS[adapter].direction !== 'INBOUND')
      throw new HubError('VALIDATION_FAILED', 400, 'This integration only sends data out');
    const input = body(IntegrationSync, raw ?? {});
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const conn = await tx.integrationConnection.findUnique({
        where: { organisationId_adapter: { organisationId: hub.orgId as string, adapter } },
      });
      if (!conn?.enabled)
        throw new HubError('CONFLICT', 409, 'Connect this integration (mock) before syncing');
      const startedAt = new Date();
      const today = londonDate(startedAt);
      // A database error aborts the whole transaction, so nothing is half-applied and no run is logged.
      const out: Outcome =
        adapter === 'TELEMATICS'
          ? await this.telematics(tx, hub, today, input.scenario)
          : adapter === 'FLEETX'
            ? await this.fleetx(tx, hub, today, input.scenario)
            : await this.training(tx, hub, today, input.scenario);
      const error: string | null = null;
      const status = out.flagged + out.skipped > 0 ? 'PARTIAL' : 'SUCCEEDED';
      const run = await tx.integrationRun.create({
        data: {
          organisationId: hub.orgId as string,
          connectionId: conn.id,
          adapter,
          direction: 'INBOUND',
          status,
          scenario: input.scenario,
          startedAt,
          finishedAt: new Date(),
          recordsSeen: out.seen,
          recordsApplied: out.applied,
          recordsFlagged: out.flagged,
          recordsSkipped: out.skipped,
          notes: out.notes.slice(0, 20),
          error,
          requestedBy: hub.user.id,
        },
      });
      await tx.integrationConnection.update({
        where: { id: conn.id },
        data: { lastRunAt: run.finishedAt, lastStatus: status },
      });
      await audit(this.db, tx, hub, {
        action: 'integrations.sync',
        entity: 'integration_run',
        entityId: run.id,
        summary: {
          adapter,
          status,
          applied: out.applied,
          flagged: out.flagged,
          skipped: out.skipped,
        },
      });
      return runDto(run);
    });
  }

  @RequirePermission(PERM)
  @Get('payroll/export')
  async payroll(@Hub() hub: HubRequestContext, @Query() q: unknown): Promise<StreamableFile> {
    const { from, to } = body(PayrollQuery, q);
    if (from > to) throw new HubError('VALIDATION_FAILED', 400, 'From must not be after to');
    const lines = await this.db.withTenant(tenantOf(hub), async (tx) => {
      const conn = await tx.integrationConnection.findUnique({
        where: {
          organisationId_adapter: { organisationId: hub.orgId as string, adapter: 'PAYROLL' },
        },
      });
      if (!conn?.enabled)
        throw new HubError('CONFLICT', 409, 'Connect the payroll export (mock) first');
      const crew = await tx.crewAssignment.findMany({
        where: {
          active: true,
          startsAt: { gte: dayOf(from), lt: new Date(dayOf(to).getTime() + 86_400_000) },
        },
        orderBy: { startsAt: 'asc' },
        take: 50_000,
      });
      const staff = await tx.staff.findMany({
        where: { id: { in: [...new Set(crew.map((c) => c.staffId))] } },
        select: { id: true, staffNo: true, displayName: true },
      });
      const sm = new Map(staff.map((s) => [s.id, s]));
      const rows = new Map<string, { no: string; name: string; ms: number; shifts: number }>();
      for (const c of crew) {
        const s = sm.get(c.staffId);
        if (!s) continue;
        const r = rows.get(s.id) ?? { no: s.staffNo, name: s.displayName, ms: 0, shifts: 0 };
        r.ms += c.endsAt.getTime() - c.startsAt.getTime();
        r.shifts += 1;
        rows.set(s.id, r);
      }
      await audit(this.db, tx, hub, {
        action: 'integrations.payroll.export',
        entity: 'integration_connection',
        entityId: conn.id,
        summary: { from, to, staff: rows.size },
      });
      return [...rows.values()].sort((a, b) => a.no.localeCompare(b.no));
    });
    const csv = toCsv(
      ['Staff number', 'Name', 'From', 'To', 'Shifts', 'Planned hours'],
      lines.map((l) => [l.no, l.name, from, to, l.shifts, (l.ms / 3_600_000).toFixed(2)]),
    );
    return new StreamableFile(Buffer.from(csv, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: 'attachment; filename="payroll-hours-mock.csv"',
    });
  }

  @RequirePermission(PERM)
  @Get('calendar/feed')
  async calendar(@Hub() hub: HubRequestContext): Promise<StreamableFile> {
    const text = await this.db.withTenant(tenantOf(hub), async (tx) => {
      const conn = await tx.integrationConnection.findUnique({
        where: {
          organisationId_adapter: { organisationId: hub.orgId as string, adapter: 'CALENDAR' },
        },
      });
      if (!conn?.enabled)
        throw new HubError('CONFLICT', 409, 'Connect the calendar feed (mock) first');
      const now = new Date();
      const shifts = await tx.shift.findMany({
        where: {
          startsAt: { gte: now, lt: new Date(now.getTime() + 28 * 86_400_000) },
          state: { not: 'CANCELLED' },
        },
        orderBy: { startsAt: 'asc' },
        take: 1000,
      });
      const vs = await tx.vehicle.findMany({
        where: { id: { in: [...new Set(shifts.map((s) => s.vehicleId))] } },
        select: { id: true, callsign: true },
      });
      const vm = new Map(vs.map((v) => [v.id, v.callsign]));
      await audit(this.db, tx, hub, {
        action: 'integrations.calendar.export',
        entity: 'integration_connection',
        entityId: conn.id,
        summary: { shifts: shifts.length },
      });
      const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Healthcare Hub//Mock calendar feed//EN',
        'CALSCALE:GREGORIAN',
      ];
      for (const s of shifts) {
        lines.push(
          'BEGIN:VEVENT',
          `UID:${s.id}@healthcare-hub.invalid`,
          `DTSTAMP:${icsStamp(now)}`,
          `DTSTART:${icsStamp(s.startsAt)}`,
          `DTEND:${icsStamp(s.endsAt)}`,
          `SUMMARY:${icsText(`Shift ${vm.get(s.vehicleId) ?? ''}`.trim())}`,
          'END:VEVENT',
        );
      }
      lines.push('END:VCALENDAR');
      return lines.join('\r\n') + '\r\n';
    });
    return new StreamableFile(Buffer.from(text, 'utf8'), {
      type: 'text/calendar; charset=utf-8',
      disposition: 'attachment; filename="shifts-mock.ics"',
    });
  }

  // ---- inbound adapters -------------------------------------------------------

  private async telematics(
    tx: TenantTx,
    hub: HubRequestContext,
    today: string,
    scenario: 'normal' | 'faults',
  ): Promise<Outcome> {
    const vehicles = await tx.vehicle.findMany({
      where: {
        offRoad: false,
        ...(hub.locationIds ? { baseLocationId: { in: [...hub.locationIds] } } : {}),
      },
      orderBy: { callsign: 'asc' },
      take: 200,
    });
    const o: Outcome = { seen: 0, applied: 0, flagged: 0, skipped: 0, notes: [] };
    let first = true;
    for (const v of vehicles) {
      o.seen += 1;
      const dup = await tx.odometerReading.findFirst({
        where: { vehicleId: v.id, source: 'TELEMATICS', readOn: dayOf(today) },
      });
      if (dup) {
        o.skipped += 1;
        o.notes.push(`${v.callsign}: already received for ${today}`);
        continue;
      }
      const base = v.currentOdometer ?? 10_000;
      let reading = base + telematicsDelta(v.callsign, today);
      if (scenario === 'faults' && first) reading = Math.max(0, base - 500); // a reading that goes backwards
      first = false;
      const r = await recordOdometer(tx, {
        vehicleId: v.id,
        organisationId: hub.orgId as string,
        reading,
        readOn: today,
        source: 'TELEMATICS',
        by: hub.user.id,
      });
      o.applied += 1;
      if (r.flags.length) {
        o.flagged += 1;
        o.notes.push(
          `${v.callsign}: reading flagged (${r.flags.join(', ')}); vehicle odometer unchanged`,
        );
      }
    }
    return o;
  }

  private async fleetx(
    tx: TenantTx,
    hub: HubRequestContext,
    today: string,
    scenario: 'normal' | 'faults',
  ): Promise<Outcome> {
    const vehicles = await tx.vehicle.findMany({
      where: {
        offRoad: false,
        ...(hub.locationIds ? { baseLocationId: { in: [...hub.locationIds] } } : {}),
      },
      orderBy: { callsign: 'asc' },
      take: 200,
    });
    const o: Outcome = { seen: 0, applied: 0, flagged: 0, skipped: 0, notes: [] };
    const items = vehicles.map((v) => ({ v, t: fuelTransaction(v.callsign, today) }));
    if (scenario === 'faults' && items[0]) {
      // The same card swipe delivered twice with a different reference: a possible duplicate.
      items.push({ v: items[0].v, t: fuelTransaction(items[0].v.callsign, today, '-B') });
      // A transaction for a vehicle the platform does not know.
      o.seen += 1;
      o.skipped += 1;
      o.notes.push('ZZ-999: no vehicle with this callsign, record skipped');
    }
    for (const { v, t } of items) {
      o.seen += 1;
      const clientSubmissionId = externalId(`fleetx:${hub.orgId}`, t.ref);
      if (await tx.fuelExpense.findFirst({ where: { clientSubmissionId } })) {
        o.skipped += 1;
        o.notes.push(`${t.ref}: already imported`);
        continue;
      }
      const dupe = await tx.fuelExpense.findFirst({
        where: {
          vehicleId: v.id,
          spentOn: dayOf(today),
          amountPence: t.amountPence,
          category: 'FUEL',
        },
      });
      await tx.fuelExpense.create({
        data: {
          organisationId: hub.orgId as string,
          vehicleId: v.id,
          submittedBy: hub.user.id,
          spentOn: dayOf(today),
          category: 'FUEL',
          quantity: t.litres,
          unit: 'LITRES',
          amountPence: t.amountPence,
          supplier: t.supplier,
          duplicateOf: dupe?.id ?? null,
          clientSubmissionId,
        },
      });
      o.applied += 1;
      if (dupe) {
        o.flagged += 1;
        o.notes.push(`${t.ref}: possible duplicate of an existing expense, marked for review`);
      }
    }
    return o;
  }

  private async training(
    tx: TenantTx,
    hub: HubRequestContext,
    today: string,
    scenario: 'normal' | 'faults',
  ): Promise<Outcome> {
    const staff = await tx.staff.findMany({
      where: { lifecycleState: 'ACTIVE' },
      orderBy: { staffNo: 'asc' },
      take: 200,
    });
    const yesterday = new Date(dayOf(today).getTime() - 86_400_000).toISOString().slice(0, 10);
    const items = trainingCompletions(
      staff.map((s) => s.staffNo),
      yesterday,
    );
    const o: Outcome = { seen: 0, applied: 0, flagged: 0, skipped: 0, notes: [] };
    if (scenario === 'faults') {
      items.push({
        staffNo: 'NO-SUCH-STAFF',
        courseCode: 'MH-REFRESH',
        title: 'Moving and handling refresher',
        completedOn: yesterday,
        expiresOn: today,
      });
    }
    const byNo = new Map(staff.map((s) => [s.staffNo, s]));
    for (const it of items) {
      o.seen += 1;
      const s = byNo.get(it.staffNo);
      if (!s) {
        o.skipped += 1;
        o.notes.push('A completion for an unknown staff number was skipped');
        continue;
      }
      const ext = externalId(
        `training:${hub.orgId}`,
        `${it.staffNo}:${it.courseCode}:${it.completedOn}`,
      );
      const dup = await tx.staffRecord.findFirst({
        where: { staffId: s.id, kind: 'TRAINING', data: { path: ['externalId'], equals: ext } },
      });
      if (dup) {
        o.skipped += 1;
        continue;
      }
      await tx.staffRecord.create({
        data: {
          organisationId: hub.orgId as string,
          staffId: s.id,
          kind: 'TRAINING',
          data: {
            externalId: ext,
            source: 'MOCK_TRAINING_PROVIDER',
            verified: false,
            courseCode: it.courseCode,
            title: it.title,
            completedOn: it.completedOn,
          },
          validFrom: dayOf(it.completedOn),
          validTo: dayOf(it.expiresOn),
          createdBy: hub.user.id,
        },
      });
      o.applied += 1;
    }
    if (o.applied > 0)
      o.notes.push('Stored as unverified training records. A reviewer must verify evidence.');
    return o;
  }
}
