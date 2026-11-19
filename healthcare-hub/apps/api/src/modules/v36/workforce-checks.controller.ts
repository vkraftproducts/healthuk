import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import type { Db, TenantTx } from '@hub/db';
import {
  AgencyWorkerArrival,
  AgencyWorkerCreate,
  DvlaCheckCreate,
  HcpcRegistrationCreate,
  type AgencyWorkerDto,
  type DvlaCheckDto,
  type HcpcRegistrationDto,
} from '@hub/contracts';
import { daysUntil, londonDate } from '@hub/rules';
import { RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { audit, body } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import {
  day,
  escalationContext,
  idPipe,
  iso,
  nextRegisterCode,
  ymd,
  type EscalationContext,
} from './shared.js';
import { nextV36Code } from './sync/staff-lib.js';

const VIEW = 'staff.profile.view_basic';
const MANAGE = 'staff.profile.manage';

/** Plain-English role labels for the workforce checks screen. */
const ROLE_LABEL: Record<string, string> = {
  DRIVER: 'Driver',
  CARE_ASSISTANT: 'Care assistant',
  EMERGENCY_CARE_ASSISTANT: 'Emergency care assistant',
  TECHNICIAN: 'Technician',
  PARAMEDIC: 'Paramedic',
  NURSE: 'Nurse',
  CONTROL_ROOM: 'Control room',
  MANAGER: 'Manager',
  OTHER: 'Other',
  DENTIST: 'Dentist',
  DENTAL_NURSE: 'Dental nurse',
  RECEPTIONIST: 'Receptionist',
  SENIOR_CARER: 'Senior carer',
  ACTIVITIES_COORDINATOR: 'Activities coordinator',
};

/** v36 Staff check / document defaults (HANDOVER C5): lead at 3 days, manager at 7. */
interface AgencyRow {
  id: string;
  code: string;
  name: string;
  agency: string;
  role: string;
  confirmation_items: string;
  confirmation_received_on: Date;
  confirmation_recorded_by: string;
  confirmation_verified_by: string | null;
  confirmation_verified_at: Date | null;
  confirmation_expires_on: Date;
  local_induction_done: boolean;
  id_checked_on_arrival: boolean;
  version: number;
}

interface DvlaRow {
  id: string;
  staff_id: string;
  check_code: string;
  categories: string;
  points: number;
  checked_on: Date;
  next_check_on: Date;
  recorded_by: string;
}

interface HcpcRow {
  id: string;
  staff_id: string;
  registration_no: string;
  checked_on: Date;
  expires_on: Date;
  recorded_by: string;
  version: number;
}

async function userNames(tx: TenantTx, ids: (string | null | undefined)[]) {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return new Map<string, string>();
  const rows = await tx.appUser.findMany({
    where: { id: { in: want } },
    select: { id: true, displayName: true },
  });
  return new Map(rows.map((u) => [u.id, u.displayName]));
}

function agencyDto(r: AgencyRow, names: Map<string, string>, today: string): AgencyWorkerDto {
  const expires = ymd(r.confirmation_expires_on)!;
  const verified = !!r.confirmation_verified_by;
  const notExpired = expires >= today;
  const canWork =
    verified && notExpired && r.local_induction_done && r.id_checked_on_arrival;
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    agency: r.agency,
    role: r.role as AgencyWorkerDto['role'],
    roleLabel: ROLE_LABEL[r.role] ?? r.role,
    confirmationItems: r.confirmation_items,
    confirmationReceivedOn: ymd(r.confirmation_received_on)!,
    confirmationRecordedBy: r.confirmation_recorded_by,
    confirmationRecordedByName: names.get(r.confirmation_recorded_by) ?? null,
    confirmationVerifiedBy: r.confirmation_verified_by,
    confirmationVerifiedByName: r.confirmation_verified_by
      ? (names.get(r.confirmation_verified_by) ?? null)
      : null,
    confirmationVerifiedAt: iso(r.confirmation_verified_at),
    confirmationExpiresOn: expires,
    localInductionDone: r.local_induction_done,
    idCheckedOnArrival: r.id_checked_on_arrival,
    canWork,
    version: r.version,
  };
}

async function loadAgency(tx: TenantTx, id: string, today: string): Promise<AgencyWorkerDto> {
  const [r] = await tx.$queryRaw<AgencyRow[]>`SELECT * FROM agency_worker WHERE id = ${id}::uuid`;
  if (!r) throw notFound();
  const names = await userNames(tx, [r.confirmation_recorded_by, r.confirmation_verified_by]);
  return agencyDto(r, names, today);
}

function dvlaDto(
  r: DvlaRow,
  staff: { displayName: string; staffNo: string },
  names: Map<string, string>,
  esc: EscalationContext,
): DvlaCheckDto {
  const next = ymd(r.next_check_on)!;
  const left = daysUntil(next, esc.now);
  const overdueDays = -left;
  const escalation = esc.of('STAFF_REQUIREMENT', overdueDays);
  return {
    id: r.id,
    staffId: r.staff_id,
    staffName: staff.displayName,
    staffNo: staff.staffNo,
    checkCode: r.check_code,
    categories: r.categories,
    points: r.points,
    checkedOn: ymd(r.checked_on)!,
    nextCheckOn: next,
    overdueDays,
    recordedBy: r.recorded_by,
    recordedByName: names.get(r.recorded_by) ?? null,
    escalation,
  };
}

/**
 * v36 screen 35 Workforce checks: bank/agency staff, DVLA licence checks and HCPC registrations.
 */
@Controller()
export class WorkforceChecksController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission(VIEW)
  @Get('agency-workers')
  listAgency(@Hub() hub: HubRequestContext): Promise<{ data: AgencyWorkerDto[] }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const today = londonDate(new Date());
      const rows = await tx.$queryRaw<AgencyRow[]>`
        SELECT * FROM agency_worker ORDER BY code`;
      const names = await userNames(
        tx,
        rows.flatMap((r) => [r.confirmation_recorded_by, r.confirmation_verified_by]),
      );
      return { data: rows.map((r) => agencyDto(r, names, today)) };
    });
  }

  @RequirePermission(MANAGE)
  @Post('agency-workers')
  createAgency(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<AgencyWorkerDto> {
    const input = body(AgencyWorkerCreate, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (input.confirmationExpiresOn < input.confirmationReceivedOn)
        throw new HubError('VALIDATION_FAILED', 400, 'The confirmation cannot expire before it was received');
      const code = await nextV36Code(tx, hub.orgId as string, 'AG', 'agency_worker', 2);
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO agency_worker (
          organisation_id, code, name, agency, role, confirmation_items,
          confirmation_received_on, confirmation_recorded_by, confirmation_expires_on,
          local_induction_done, id_checked_on_arrival
        ) VALUES (
          ${hub.orgId}::uuid, ${code}, ${input.name}, ${input.agency}, ${input.role}::staff_role,
          ${input.confirmationItems}, ${day(input.confirmationReceivedOn)}, ${hub.user.id}::uuid,
          ${day(input.confirmationExpiresOn)},
          ${input.localInductionDone ?? false}, ${input.idCheckedOnArrival ?? false}
        ) RETURNING id`;
      await audit(this.db, tx, hub, {
        action: 'staff.agency.create',
        entity: 'agency_worker',
        entityId: row!.id,
        summary: { code, name: input.name },
      });
      return loadAgency(tx, row!.id, londonDate(new Date()));
    });
  }

  @RequirePermission(MANAGE)
  @Post('agency-workers/:id/verify')
  verifyAgency(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
  ): Promise<AgencyWorkerDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const [r] = await tx.$queryRaw<AgencyRow[]>`SELECT * FROM agency_worker WHERE id = ${id}::uuid`;
      if (!r) throw notFound();
      if (r.confirmation_verified_by)
        throw new HubError('CONFLICT', 409, 'This confirmation is already verified');
      if (r.confirmation_recorded_by === hub.user.id)
        throw new HubError(
          'FOUR_EYES_REQUIRED',
          409,
          'Someone other than the person who recorded it must verify the confirmation',
        );
      await tx.$executeRaw`
        UPDATE agency_worker
           SET confirmation_verified_by = ${hub.user.id}::uuid,
               confirmation_verified_at = now(),
               updated_at = now()
         WHERE id = ${id}::uuid`;
      await audit(this.db, tx, hub, {
        action: 'staff.agency.verify',
        entity: 'agency_worker',
        entityId: id,
        summary: { code: r.code },
      });
      return loadAgency(tx, id, londonDate(new Date()));
    });
  }

  @RequirePermission(MANAGE)
  @Post('agency-workers/:id/arrival')
  arrivalAgency(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<AgencyWorkerDto> {
    const input = body(AgencyWorkerArrival, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const [r] = await tx.$queryRaw<AgencyRow[]>`SELECT * FROM agency_worker WHERE id = ${id}::uuid`;
      if (!r) throw notFound();
      await tx.$executeRaw`
        UPDATE agency_worker
           SET local_induction_done = ${input.localInductionDone},
               id_checked_on_arrival = ${input.idCheckedOnArrival},
               updated_at = now()
         WHERE id = ${id}::uuid`;
      await audit(this.db, tx, hub, {
        action: 'staff.agency.arrival',
        entity: 'agency_worker',
        entityId: id,
        summary: {
          code: r.code,
          induction: input.localInductionDone,
          idChecked: input.idCheckedOnArrival,
        },
      });
      return loadAgency(tx, id, londonDate(new Date()));
    });
  }

  @RequirePermission(VIEW)
  @Get('dvla-checks')
  listDvla(@Hub() hub: HubRequestContext): Promise<{ data: DvlaCheckDto[] }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const now = new Date();
      const rows = await tx.$queryRaw<DvlaRow[]>`
        SELECT DISTINCT ON (staff_id) *
          FROM dvla_check
         ORDER BY staff_id, checked_on DESC, created_at DESC`;
      const staffIds = rows.map((r) => r.staff_id);
      const staff = await tx.staff.findMany({
        where: { id: { in: staffIds } },
        select: { id: true, displayName: true, staffNo: true },
      });
      const byId = new Map(staff.map((s) => [s.id, s]));
      const names = await userNames(tx, rows.map((r) => r.recorded_by));
      const esc = await escalationContext(tx, now);
      return {
        data: rows
          .map((r) => {
            const s = byId.get(r.staff_id);
            if (!s) return null;
            return dvlaDto(r, s, names, esc);
          })
          .filter((x): x is DvlaCheckDto => !!x)
          .sort((a, b) => a.staffNo.localeCompare(b.staffNo)),
      };
    });
  }

  @RequirePermission(MANAGE)
  @Post('dvla-checks')
  createDvla(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<DvlaCheckDto> {
    const input = body(DvlaCheckCreate, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (input.nextCheckOn < input.checkedOn)
        throw new HubError('VALIDATION_FAILED', 400, 'The next check cannot be before the check date');
      const s = await tx.staff.findUnique({
        where: { id: input.staffId },
        select: { id: true, displayName: true, staffNo: true, lifecycleState: true },
      });
      if (!s) throw notFound();
      if (s.lifecycleState === 'LEAVER')
        throw new HubError('VALIDATION_FAILED', 400, 'This person has left');
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO dvla_check (
          organisation_id, staff_id, check_code, categories, points,
          checked_on, next_check_on, recorded_by
        ) VALUES (
          ${hub.orgId}::uuid, ${input.staffId}::uuid, ${input.checkCode}, ${input.categories},
          ${input.points}, ${day(input.checkedOn)}, ${day(input.nextCheckOn)}, ${hub.user.id}::uuid
        ) RETURNING id`;
      await audit(this.db, tx, hub, {
        action: 'staff.dvla.create',
        entity: 'dvla_check',
        entityId: row!.id,
        summary: { staffNo: s.staffNo, checkCode: input.checkCode },
      });
      const [r] = await tx.$queryRaw<DvlaRow[]>`SELECT * FROM dvla_check WHERE id = ${row!.id}::uuid`;
      const names = await userNames(tx, [r!.recorded_by]);
      return dvlaDto(r!, s, names, await escalationContext(tx));
    });
  }

  @RequirePermission(VIEW)
  @Get('hcpc-registrations')
  listHcpc(@Hub() hub: HubRequestContext): Promise<{ data: HcpcRegistrationDto[] }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.$queryRaw<HcpcRow[]>`
        SELECT * FROM hcpc_registration ORDER BY expires_on`;
      const staff = await tx.staff.findMany({
        where: { id: { in: rows.map((r) => r.staff_id) } },
        select: { id: true, displayName: true, staffNo: true },
      });
      const byId = new Map(staff.map((s) => [s.id, s]));
      const names = await userNames(tx, rows.map((r) => r.recorded_by));
      return {
        data: rows
          .map((r) => {
            const s = byId.get(r.staff_id);
            if (!s) return null;
            return {
              id: r.id,
              staffId: r.staff_id,
              staffName: s.displayName,
              staffNo: s.staffNo,
              registrationNo: r.registration_no,
              checkedOn: ymd(r.checked_on)!,
              expiresOn: ymd(r.expires_on)!,
              recordedByName: names.get(r.recorded_by) ?? null,
              version: r.version,
            };
          })
          .filter((x): x is HcpcRegistrationDto => !!x),
      };
    });
  }

  @RequirePermission(MANAGE)
  @Post('hcpc-registrations')
  createHcpc(
    @Hub() hub: HubRequestContext,
    @Body() raw: unknown,
  ): Promise<HcpcRegistrationDto> {
    const input = body(HcpcRegistrationCreate, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (input.expiresOn < input.checkedOn)
        throw new HubError('VALIDATION_FAILED', 400, 'Registration cannot expire before it was checked');
      const s = await tx.staff.findUnique({
        where: { id: input.staffId },
        select: { id: true, displayName: true, staffNo: true, lifecycleState: true },
      });
      if (!s) throw notFound();
      if (s.lifecycleState === 'LEAVER')
        throw new HubError('VALIDATION_FAILED', 400, 'This person has left');
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO hcpc_registration (
          organisation_id, staff_id, registration_no, checked_on, expires_on, recorded_by
        ) VALUES (
          ${hub.orgId}::uuid, ${input.staffId}::uuid, ${input.registrationNo},
          ${day(input.checkedOn)}, ${day(input.expiresOn)}, ${hub.user.id}::uuid
        )
        ON CONFLICT (organisation_id, staff_id) DO UPDATE
          SET registration_no = EXCLUDED.registration_no,
              checked_on = EXCLUDED.checked_on,
              expires_on = EXCLUDED.expires_on,
              recorded_by = EXCLUDED.recorded_by,
              updated_at = now()
        RETURNING id`;
      await audit(this.db, tx, hub, {
        action: 'staff.hcpc.upsert',
        entity: 'hcpc_registration',
        entityId: row!.id,
        summary: { staffNo: s.staffNo, registrationNo: input.registrationNo },
      });
      const [r] = await tx.$queryRaw<HcpcRow[]>`
        SELECT * FROM hcpc_registration WHERE id = ${row!.id}::uuid`;
      const names = await userNames(tx, [r!.recorded_by]);
      return {
        id: r!.id,
        staffId: r!.staff_id,
        staffName: s.displayName,
        staffNo: s.staffNo,
        registrationNo: r!.registration_no,
        checkedOn: ymd(r!.checked_on)!,
        expiresOn: ymd(r!.expires_on)!,
        recordedByName: names.get(r!.recorded_by) ?? null,
        version: r!.version,
      };
    });
  }
}
