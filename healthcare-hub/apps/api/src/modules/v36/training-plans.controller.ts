import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import type { Db, TenantTx } from '@hub/db';
import { TrainingPlanCreate, type TrainingPlanDto } from '@hub/contracts';
import { daysUntil, matrixCellState } from '@hub/rules';
import { RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { audit, body } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import { day, idPipe, nextRegisterCode, ymd } from './shared.js';

const VIEW = 'staff.profile.view_basic';
const MANAGE = 'staff.profile.manage';

/** training_course.code → requirement template code used by the training matrix. */
const COURSE_TO_TPL: Record<string, string> = {
  'TR-MH': 'AMB-STF-05',
  'TR-BLS': 'AMB-STF-06',
  'TR-SG': 'AMB-STF-07',
  'TR-IPC': 'AMB-STF-08',
  'TR-IG': 'ORG-STF-06',
};

interface PlanRow {
  id: string;
  code: string;
  course_code: string;
  planned_on: Date;
  places: number;
  invited_staff_ids: string[];
  status: 'PLANNED' | 'HELD' | 'CANCELLED';
  created_by: string;
  version: number;
}

async function courseTitle(tx: TenantTx, code: string): Promise<string> {
  const [c] = await tx.$queryRaw<{ title: string }[]>`
    SELECT title FROM training_course WHERE code = ${code} AND retired_at IS NULL LIMIT 1`;
  return c?.title ?? code;
}

async function planDto(tx: TenantTx, r: PlanRow, now: Date): Promise<TrainingPlanDto> {
  const ids = r.invited_staff_ids ?? [];
  const staff = ids.length
    ? await tx.staff.findMany({
        where: { id: { in: ids } },
        select: { id: true, displayName: true },
      })
    : [];
  const byId = new Map(staff.map((s) => [s.id, s.displayName]));
  const [creator] = await tx.appUser.findMany({
    where: { id: r.created_by },
    select: { displayName: true },
  });
  const plannedOn = ymd(r.planned_on)!;
  return {
    id: r.id,
    code: r.code,
    courseCode: r.course_code,
    courseTitle: await courseTitle(tx, r.course_code),
    plannedOn,
    places: r.places,
    invitedStaffIds: ids,
    invitedNames: ids.map((id) => byId.get(id) ?? 'Staff member'),
    status: r.status,
    daysUntil: daysUntil(plannedOn, now),
    createdByName: creator?.displayName ?? null,
    version: r.version,
  };
}

async function load(tx: TenantTx, id: string, now: Date): Promise<TrainingPlanDto> {
  const [r] = await tx.$queryRaw<PlanRow[]>`SELECT * FROM training_plan WHERE id = ${id}::uuid`;
  if (!r) throw notFound();
  return planDto(tx, r, now);
}

/** Staff whose matrix cell for the course is due soon, overdue or missing. */
async function dueStaffIds(tx: TenantTx, courseCode: string): Promise<string[]> {
  const tplCode = COURSE_TO_TPL[courseCode] ?? courseCode;
  const [tpl] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM requirement_template WHERE code = ${tplCode} LIMIT 1`;
  if (!tpl) return [];
  const staff = await tx.staff.findMany({
    where: { lifecycleState: { not: 'LEAVER' } },
    select: { id: true },
  });
  const map = await tx.roleRequirement.findMany({ where: { templateId: tpl.id } });
  const rolesForTpl = new Set(map.map((m) => m.role));
  const approvals = await tx.staffRoleApproval.findMany({
    where: { revokedAt: null, role: { in: [...rolesForTpl] } },
    select: { staffId: true, role: true },
  });
  const rolesByStaff = new Map<string, (typeof approvals)[number]['role'][]>();
  for (const a of approvals) {
    const list = rolesByStaff.get(a.staffId) ?? [];
    list.push(a.role);
    rolesByStaff.set(a.staffId, list);
  }
  const instances = await tx.requirementInstance.findMany({
    where: {
      subjectType: 'STAFF',
      templateId: tpl.id,
      subjectId: { in: staff.map((s) => s.id) },
    },
    select: { subjectId: true, status: true, reasonCode: true },
  });
  const byStaff = new Map(instances.map((i) => [i.subjectId, i]));
  const due: string[] = [];
  for (const s of staff) {
    const roles = rolesByStaff.get(s.id) ?? [];
    const required = roles.some((r) => rolesForTpl.has(r));
    const i = byStaff.get(s.id);
    const state = matrixCellState({
      required,
      status: i?.status ?? null,
      reasonCode: i?.reasonCode ?? null,
    });
    if (state === 'DUE_SOON' || state === 'OVERDUE' || state === 'MISSING') due.push(s.id);
  }
  return due;
}

/**
 * v36 Staff › Training › Planned sessions. Plan a course date, invite who is due, cancel.
 */
@Controller('training-plans')
export class TrainingPlansController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission(VIEW)
  @Get()
  list(@Hub() hub: HubRequestContext): Promise<{ data: TrainingPlanDto[] }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const now = new Date();
      const rows = await tx.$queryRaw<PlanRow[]>`
        SELECT * FROM training_plan ORDER BY planned_on DESC, code DESC`;
      return { data: await Promise.all(rows.map((r) => planDto(tx, r, now))) };
    });
  }

  @RequirePermission(MANAGE)
  @Post()
  create(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<TrainingPlanDto> {
    const input = body(TrainingPlanCreate, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const [course] = await tx.$queryRaw<{ code: string }[]>`
        SELECT code FROM training_course
         WHERE code = ${input.courseCode} AND retired_at IS NULL LIMIT 1`;
      if (!course) throw new HubError('VALIDATION_FAILED', 400, 'That course is not in the catalogue');
      let invited: string[] = [];
      if (input.inviteDue) {
        invited = (await dueStaffIds(tx, input.courseCode)).slice(0, input.places);
      }
      const code = await nextRegisterCode(tx, hub.orgId as string, 'TP', 1);
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO training_plan (
          organisation_id, code, course_code, planned_on, places, invited_staff_ids, created_by
        ) VALUES (
          ${hub.orgId}::uuid, ${code}, ${input.courseCode}, ${day(input.plannedOn)},
          ${input.places}, ${invited}::uuid[], ${hub.user.id}::uuid
        ) RETURNING id`;
      await audit(this.db, tx, hub, {
        action: 'staff.trainingplan.create',
        entity: 'training_plan',
        entityId: row!.id,
        summary: { code, course: input.courseCode, invited: invited.length },
      });
      return load(tx, row!.id, new Date());
    });
  }

  @RequirePermission(MANAGE)
  @Post(':id/invite-due')
  inviteDue(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
  ): Promise<TrainingPlanDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const [r] = await tx.$queryRaw<PlanRow[]>`SELECT * FROM training_plan WHERE id = ${id}::uuid`;
      if (!r) throw notFound();
      if (r.status !== 'PLANNED')
        throw new HubError('CONFLICT', 409, 'Only a planned session can invite more people');
      const have = new Set(r.invited_staff_ids ?? []);
      const room = r.places - have.size;
      if (room <= 0)
        throw new HubError('CONFLICT', 409, 'This session is already full');
      const add = (await dueStaffIds(tx, r.course_code))
        .filter((sid) => !have.has(sid))
        .slice(0, room);
      const next = [...have, ...add];
      await tx.$executeRaw`
        UPDATE training_plan
           SET invited_staff_ids = ${next}::uuid[], updated_at = now()
         WHERE id = ${id}::uuid`;
      await audit(this.db, tx, hub, {
        action: 'staff.trainingplan.invite',
        entity: 'training_plan',
        entityId: id,
        summary: { code: r.code, added: add.length },
      });
      return load(tx, id, new Date());
    });
  }

  @RequirePermission(MANAGE)
  @Post(':id/cancel')
  cancel(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
  ): Promise<TrainingPlanDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const [r] = await tx.$queryRaw<PlanRow[]>`SELECT * FROM training_plan WHERE id = ${id}::uuid`;
      if (!r) throw notFound();
      if (r.status !== 'PLANNED')
        throw new HubError('CONFLICT', 409, 'Only a planned session can be cancelled');
      await tx.$executeRaw`
        UPDATE training_plan
           SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = ${hub.user.id}::uuid,
               updated_at = now()
         WHERE id = ${id}::uuid`;
      await audit(this.db, tx, hub, {
        action: 'staff.trainingplan.cancel',
        entity: 'training_plan',
        entityId: id,
        summary: { code: r.code },
      });
      return load(tx, id, new Date());
    });
  }
}
