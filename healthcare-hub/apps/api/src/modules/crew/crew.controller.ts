import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';
import type { Db, TenantTx } from '@hub/db';
import {
  activeRoles,
  isRequired,
  requiredTemplates,
  shiftGateFor,
  staffStatusSummary,
} from '@hub/domain';
import {
  ackState,
  classifySync,
  CREW_STATES,
  crewCacheExpiry,
  crewGateCards,
  endOfLondonDay,
  jobNext,
  londonDate,
  type JobState,
} from '@hub/rules';
import {
  CrewAckInput,
  DeviceRegisterInput,
  SyncInput,
  type CrewJobDto,
  type CrewJobSummary,
  type CrewPolicyDto,
  type CrewProfileDto,
  type CrewShiftDto,
  type CrewTodayDto,
  type DeviceDto,
  type SyncItem,
  type SyncItemResult,
  type SyncResultDto,
} from '@hub/contracts';
import { OrgMember, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequest, type HubRequestContext } from '../../common/context.js';
import { audit, body, requireAny } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';

const idPipe = new ParseUUIDPipe({ version: '7', exceptionFactory: () => notFound() });
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const isoDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const crewNext = (s: string): JobState[] =>
  jobNext(s as JobState).filter((x) => CREW_STATES.includes(x));
const TASK = /SUPERVISION|APPRAISAL/;

/** How each offline item type is replayed through the normal endpoint (same checks, same audit). */
const ROUTE: Record<SyncItem['type'], (i: SyncItem) => string | null> = {
  VDI: () => '/api/v1/vdis',
  CLEANING: () => '/api/v1/cleaning-records',
  JOB_STATUS: (i) => (i.ref ? `/api/v1/jobs/${i.ref}/status` : null),
  DEFECT: () => '/api/v1/defects',
  EXPENSE: () => '/api/v1/fuel-expenses',
  POLICY_ACK: (i) => (i.ref ? `/api/v1/crew/policies/${i.ref}/acknowledge` : null),
  // Re-checked against the server gate at sync time: a shift started offline whose gate no longer
  // passes comes back as a conflict for control to resolve (safety gates are never bypassed).
  SHIFT_START: (i) => (i.ref ? `/api/v1/shifts/${i.ref}/start` : null),
};

@Controller()
export class CrewController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
  ) {}

  // ---- My shift ----------------------------------------------------------------------------
  @RequirePermission('crew.today.view')
  @Get('crew/today')
  async today(@Hub() hub: HubRequestContext): Promise<CrewTodayDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const now = new Date();
      const staff = await tx.staff.findFirst({ where: { userId: hub.user.id } });
      const policiesPending = (await this.pendingPolicies(tx, hub)).length;
      const base = {
        serverTime: now.toISOString(),
        eligibilityCheckedAt: now.toISOString(),
        staff: staff ? { staffNo: staff.staffNo, displayName: staff.displayName } : null,
        policiesPending,
      };
      if (!staff)
        return {
          ...base,
          cacheUntil: crewCacheExpiry(null, now).toISOString(),
          shift: null,
          upcoming: [],
        };
      const assignments = await tx.crewAssignment.findMany({
        where: {
          staffId: staff.id,
          active: true,
          endsAt: { gt: now },
          shift: { state: { in: ['PLANNED', 'STARTED'] } },
        },
        include: { shift: true },
      });
      const endToday = endOfLondonDay(londonDate(now));
      const ordered = assignments.sort(
        (a, b) =>
          Number(b.shift.state === 'STARTED') - Number(a.shift.state === 'STARTED') ||
          a.shift.startsAt.getTime() - b.shift.startsAt.getTime(),
      );
      const current = ordered.find((a) => a.shift.startsAt <= endToday) ?? null;
      const week = new Date(now.getTime() + 7 * 86_400_000);
      const upcomingRows = ordered.filter(
        (a) => a.shift.id !== current?.shift.id && a.shift.startsAt <= week,
      );
      const vehicles = await tx.vehicle.findMany({
        where: { id: { in: ordered.map((a) => a.shift.vehicleId) } },
      });
      const upcoming = upcomingRows.map((a) => ({
        id: a.shift.id,
        startsAt: a.shift.startsAt.toISOString(),
        endsAt: a.shift.endsAt.toISOString(),
        vehicleCallsign: vehicles.find((v) => v.id === a.shift.vehicleId)?.callsign ?? 'Vehicle',
      }));
      const shift = current ? await this.shiftView(tx, current, staff.id, now) : null;
      return {
        ...base,
        cacheUntil: crewCacheExpiry(current?.shift.endsAt ?? null, now).toISOString(),
        shift,
        upcoming,
      };
    });
  }

  private async shiftView(
    tx: TenantTx,
    a: {
      role: string;
      shift: { id: string; state: string; startsAt: Date; endsAt: Date; vehicleId: string };
    },
    staffId: string,
    now: Date,
  ): Promise<CrewShiftDto> {
    const s = a.shift;
    const v = await tx.vehicle.findUniqueOrThrow({ where: { id: s.vehicleId } });
    const crew = await tx.crewAssignment.findMany({
      where: { shiftId: s.id, active: true },
      orderBy: { startsAt: 'asc' },
    });
    const people = await tx.staff.findMany({
      where: { id: { in: crew.map((c) => c.staffId) } },
      select: { id: true, displayName: true },
    });
    const gate = await shiftGateFor(tx, s.id, staffId, now);
    const templates = await tx.vdiTemplate.findMany({
      where: { active: true, OR: [{ vehicleType: v.type }, { vehicleType: null }] },
      orderBy: { version: 'desc' },
    });
    const tpl = templates.find((t) => t.vehicleType === v.type) ?? templates[0] ?? null;
    const allocations = await tx.jobAllocation.findMany({
      where: { shiftId: s.id, active: true },
      include: { job: true },
      orderBy: { startsAt: 'asc' },
    });
    return {
      id: s.id,
      state: s.state as CrewShiftDto['state'],
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
      myRole: a.role as CrewShiftDto['myRole'],
      vehicle: {
        id: v.id,
        callsign: v.callsign,
        registration: v.registration,
        type: v.type,
        status: v.status,
        statusReason: v.statusReason,
      },
      crew: crew.map((c) => ({
        displayName: people.find((p) => p.id === c.staffId)?.displayName ?? 'Crew member',
        role: c.role as CrewShiftDto['myRole'],
        me: c.staffId === staffId,
      })),
      gate: { canStart: gate.canStart, checks: gate.checks, cards: crewGateCards(gate.checks) },
      vdiTemplate: tpl
        ? {
            id: tpl.id,
            version: tpl.version,
            items: (tpl.items as { code: string; label: string; critical: boolean }[]).map((i) => ({
              code: i.code,
              label: i.label,
              critical: !!i.critical,
            })),
          }
        : null,
      jobs: allocations.map((al) => summary(al.job)),
    };
  }

  // ---- Assigned job --------------------------------------------------------------------------
  @RequirePermission('crew.today.view')
  @Get('crew/jobs/:id')
  async job(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string): Promise<CrewJobDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const al = await tx.jobAllocation.findFirst({ where: { jobId: id, active: true } });
      if (!al || !(await this.onShift(tx, hub, al.shiftId))) throw notFound();
      const j = await tx.job.findUniqueOrThrow({
        where: { id },
        include: { events: { orderBy: { receivedAt: 'asc' } } },
      });
      // The database returns the contact only during this person's shift window (app_crew_on_job).
      const c = await tx.patientContact.findUnique({ where: { jobId: id } });
      if (c)
        await audit(this.db, tx, hub, { action: 'jobs.patient.view', entity: 'job', entityId: id });
      return {
        ...summary(j),
        shiftId: al.shiftId,
        pickupAddress: j.pickupAddress,
        destinationAddress: j.destinationAddress,
        appointmentAt: iso(j.appointmentAt),
        accessNotes: j.accessNotes,
        accessPlanReviewed: j.accessPlanReviewed,
        escorts: j.escorts,
        stairs: j.stairs,
        infectionPrecautions: j.infectionPrecautions,
        commsNeeds: j.commsNeeds,
        requiredEquipment: j.requiredEquipment,
        crewSize: j.crewSize,
        patientContact: c ? { name: c.name, phone: c.phone } : null,
        events: j.events.map((e) => ({
          toState: e.toState,
          capturedAt: e.capturedAt.toISOString(),
          receivedAt: e.receivedAt.toISOString(),
        })),
        version: j.version,
      };
    });
  }

  // ---- Offline sync ---------------------------------------------------------------------------
  /**
   * Replays queued submissions one by one through the normal endpoints (same permission checks,
   * validation, idempotency and audit). Each item gets its own result; one failure never blocks
   * the rest. Conflicts come back with the server's state so the app can reconcile — never a
   * silent overwrite.
   */
  @OrgMember()
  @Post('crew/sync')
  async sync(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Body() raw: unknown,
  ): Promise<SyncResultDto> {
    requireAny(hub, 'crew.today.view');
    const input = body(SyncInput, raw);
    const app = this.host.httpAdapter.getInstance<FastifyInstance>();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    for (const h of ['authorization', 'x-org-id', 'x-location-id', 'x-device-id']) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }
    const results: SyncItemResult[] = [];
    for (const item of input.items) {
      const url = ROUTE[item.type](item);
      const base = {
        clientSubmissionId: item.clientSubmissionId,
        type: item.type,
        entityId: null,
        serverState: null,
      };
      if (!url) {
        results.push({
          ...base,
          outcome: 'REJECTED',
          status: 400,
          code: 'VALIDATION_FAILED',
          detail: 'This item needs a reference',
        });
        continue;
      }
      const payload =
        item.type === 'POLICY_ACK'
          ? item.payload
          : { ...item.payload, clientSubmissionId: item.clientSubmissionId };
      // Job status replies carry no replay flag: note beforehand whether this submission is known.
      const seen =
        item.type === 'JOB_STATUS' &&
        (await this.db.withTenant(tenantOf(hub), (tx) =>
          tx.jobStatusEvent.findFirst({
            where: { clientSubmissionId: item.clientSubmissionId },
            select: { id: true },
          }),
        )) !== null;
      const res = await app.inject({
        method: 'POST',
        url,
        headers,
        payload: JSON.stringify(payload),
      });
      let json: Record<string, unknown>;
      try {
        json = res.json();
      } catch {
        json = {};
      }
      const ok = res.statusCode < 300;
      // A job that is no longer yours (reassigned while offline) is a conflict to reconcile.
      const outcome =
        item.type === 'JOB_STATUS' && res.statusCode === 404
          ? 'CONFLICT'
          : classifySync(
              res.statusCode,
              ok && (seen || json.duplicate === true || json.replayed === true),
            );
      results.push({
        ...base,
        outcome,
        status: res.statusCode,
        code: ok ? null : typeof json.code === 'string' ? json.code : null,
        detail: ok ? null : typeof json.detail === 'string' ? json.detail : null,
        entityId:
          ok && typeof json.id === 'string'
            ? json.id
            : ok && typeof json.versionId === 'string'
              ? json.versionId
              : null,
        serverState: outcome === 'CONFLICT' ? await this.serverState(hub, item) : null,
      });
    }
    return { results };
  }

  private async serverState(
    hub: HubRequestContext,
    item: SyncItem,
  ): Promise<Record<string, unknown> | null> {
    if (item.type !== 'JOB_STATUS' || !item.ref) return null;
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const j = await tx.job.findUnique({ where: { id: item.ref } });
      if (!j) return { jobState: null, assignedToYou: false };
      const al = await tx.jobAllocation.findFirst({ where: { jobId: j.id, active: true } });
      return {
        jobState: j.state,
        assignedToYou: !!al && (await this.onShift(tx, hub, al.shiftId)),
      };
    });
  }

  // ---- Policies --------------------------------------------------------------------------------
  @RequirePermission('compliance.policy.acknowledge')
  @Get('crew/policies/pending')
  async policies(@Hub() hub: HubRequestContext): Promise<{ data: CrewPolicyDto[] }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => ({
      data: await this.pendingPolicies(tx, hub),
    }));
  }

  @RequirePermission('compliance.policy.acknowledge')
  @Post('crew/policies/:versionId/acknowledge')
  async acknowledge(
    @Hub() hub: HubRequestContext,
    @Param('versionId', idPipe) versionId: string,
    @Body() raw: unknown,
  ): Promise<CrewPolicyDto> {
    const input = body(CrewAckInput, raw ?? {});
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const v = await tx.policyVersion.findUnique({
        where: { id: versionId },
        include: { document: true },
      });
      if (!v || !(await this.isReader(tx, hub, v.document.readerRoles))) throw notFound();
      // Acknowledging a version you read offline that has since been replaced is a conflict:
      // the person must read the new version.
      if (v.status !== 'PUBLISHED')
        throw new HubError('CONFLICT', 409, 'This version has been replaced: read the current one');
      const critical = v.document.category === 'CRITICAL_INSTRUCTION';
      if (critical && input.confirmCritical !== true)
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'Confirm you have read and understood this critical instruction',
        );
      const existing = await tx.policyAcknowledgement.findFirst({
        where: { policyVersionId: v.id, userId: hub.user.id },
      });
      if (!existing) {
        await tx.policyAcknowledgement.create({
          data: {
            organisationId: v.organisationId,
            policyVersionId: v.id,
            userId: hub.user.id,
            device: input.device ?? null,
          },
        });
        await audit(this.db, tx, hub, {
          action: 'compliance.policy.acknowledge',
          entity: 'policy_version',
          entityId: v.id,
          summary: { critical },
        });
      }
      return policyDto(v, v.document, null);
    });
  }

  private async pendingPolicies(tx: TenantTx, hub: HubRequestContext): Promise<CrewPolicyDto[]> {
    if (!hub.permissions.has('compliance.policy.acknowledge')) return [];
    const docs = await tx.policyDocument.findMany({
      include: { versions: { orderBy: { version: 'desc' } } },
      orderBy: { code: 'asc' },
    });
    const keys = await this.roleKeys(tx, hub);
    const acks = await tx.policyAcknowledgement.findMany({
      where: { userId: hub.user.id },
      select: { policyVersionId: true },
    });
    const mine = new Set(acks.map((a) => a.policyVersionId));
    const out: CrewPolicyDto[] = [];
    for (const d of docs) {
      if (d.readerRoles.length && !d.readerRoles.some((r) => keys.includes(r))) continue;
      const current = d.versions.find((v) => v.status === 'PUBLISHED');
      if (!current) continue;
      const chain = d.versions
        .filter(
          (v) =>
            (v.status === 'PUBLISHED' || v.status === 'SUPERSEDED' || !!v.publishedAt) &&
            v.version <= current.version,
        )
        .map((v) => ({ id: v.id, material: v.material }));
      if (ackState(chain, mine) !== 'REQUIRED') continue;
      const ev = current.evidenceItemId
        ? await tx.evidenceVersion.findFirst({
            where: { itemId: current.evidenceItemId, uploadedAt: { not: null } },
            orderBy: { versionNo: 'desc' },
            select: { id: true },
          })
        : null;
      out.push(policyDto(current, d, ev?.id ?? null));
    }
    return out;
  }

  private async roleKeys(tx: TenantTx, hub: HubRequestContext): Promise<string[]> {
    const m = await tx.membership.findMany({
      where: { userId: hub.user.id, organisationId: hub.orgId as string, validTo: null },
      include: { role: { select: { key: true } } },
    });
    return m.map((x) => x.role.key);
  }

  private async isReader(tx: TenantTx, hub: HubRequestContext, roles: string[]) {
    if (roles.length === 0) return true;
    const keys = await this.roleKeys(tx, hub);
    return roles.some((r) => keys.includes(r));
  }

  // ---- Profile ---------------------------------------------------------------------------------
  @RequirePermission('staff.self.view')
  @Get('crew/profile')
  async profile(@Hub() hub: HubRequestContext): Promise<CrewProfileDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const s = await tx.staff.findFirst({ where: { userId: hub.user.id } });
      if (!s) throw notFound();
      const now = new Date();
      const roles = await activeRoles(tx, s.id, now);
      const set = await requiredTemplates(tx, roles);
      const sum = (await staffStatusSummary(tx, [s.id], now)).get(s.id);
      const instances = await tx.requirementInstance.findMany({
        where: { subjectType: 'STAFF', subjectId: s.id },
        include: { template: { select: { title: true, code: true } } },
        orderBy: { createdAt: 'asc' },
      });
      const items = await tx.evidenceItem.findMany({
        where: { createdBy: hub.user.id },
        include: {
          versions: { orderBy: { versionNo: 'desc' }, take: 1, include: { verification: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      return {
        staffNo: s.staffNo,
        displayName: s.displayName,
        jobTitle: s.jobTitle,
        roles,
        overallStatus: sum?.overall ?? 'GREY',
        requirements: instances.map((i) => ({
          id: i.id,
          title: i.template.title,
          status: i.status,
          reasonText: i.reasonText,
          dueDate: isoDay(i.dueDate),
          expiryDate: isoDay(i.expiryDate),
          required: isRequired(i.templateId, set),
        })),
        documents: items.map((it) => {
          const v = it.versions[0];
          const state = !v?.uploadedAt
            ? 'UPLOAD_INCOMPLETE'
            : v.verification
              ? v.verification.decision
              : 'PENDING_VERIFICATION';
          return { id: it.id, title: it.title, state, uploadedAt: iso(v?.uploadedAt ?? null) };
        }),
        tasks: instances
          .filter(
            (i) =>
              TASK.test(i.template.code) && i.status !== 'GREEN' && i.status !== 'NOT_APPLICABLE',
          )
          .map((i) => ({
            id: i.id,
            title: i.template.title,
            status: i.status,
            reasonText: i.reasonText,
          })),
      };
    });
  }

  // ---- Devices and push --------------------------------------------------------------------------
  @OrgMember()
  @Post('devices/register-push')
  async register(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<DeviceDto> {
    const input = body(DeviceRegisterInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const prior = await tx.deviceSession.findUnique({
        where: { userId_deviceId: { userId: hub.user.id, deviceId: input.deviceId } },
      });
      // A signed-out device stays signed out: it must not re-register itself (it wipes instead).
      if (prior?.revokedAt) throw new HubError('DEVICE_REVOKED', 401);
      const now = new Date();
      const d = prior
        ? await tx.deviceSession.update({
            where: { id: prior.id },
            data: {
              platform: input.platform,
              pushToken: input.pushToken,
              appVersion: input.appVersion ?? null,
              lastSeenAt: now,
            },
          })
        : await tx.deviceSession.create({
            data: {
              userId: hub.user.id,
              deviceId: input.deviceId,
              platform: input.platform,
              pushToken: input.pushToken,
              appVersion: input.appVersion ?? null,
              lastSeenAt: now,
            },
          });
      if (!prior)
        await audit(this.db, tx, hub, {
          action: 'devices.register',
          entity: 'device_session',
          entityId: d.id,
          summary: { platform: d.platform },
        });
      return deviceDto(d);
    });
  }

  @OrgMember()
  @Get('devices')
  async devices(@Hub() hub: HubRequestContext): Promise<{ data: DeviceDto[] }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => ({
      data: (
        await tx.deviceSession.findMany({
          where: { userId: hub.user.id },
          orderBy: { createdAt: 'desc' },
        })
      ).map(deviceDto),
    }));
  }

  /** People sign out their own devices; administrators revoke a user's devices with the user. */
  @OrgMember()
  @Delete('devices/:id')
  async revoke(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string): Promise<DeviceDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const d = await tx.deviceSession.findUnique({ where: { id } });
      if (!d || d.userId !== hub.user.id) throw notFound();
      const out = d.revokedAt
        ? d
        : await tx.deviceSession.update({
            where: { id },
            data: { revokedAt: new Date(), pushToken: null },
          });
      if (!d.revokedAt)
        await audit(this.db, tx, hub, {
          action: 'devices.revoke',
          entity: 'device_session',
          entityId: id,
        });
      return deviceDto(out);
    });
  }

  private async onShift(tx: TenantTx, hub: HubRequestContext, shiftId: string): Promise<boolean> {
    const staff = await tx.staff.findFirst({
      where: { userId: hub.user.id },
      select: { id: true },
    });
    if (!staff) return false;
    return !!(await tx.crewAssignment.findFirst({
      where: { shiftId, staffId: staff.id, active: true },
      select: { id: true },
    }));
  }
}

function summary(j: {
  id: string;
  code: string;
  state: string;
  plannedStart: Date;
  plannedEnd: Date;
  pickupFrom: Date;
  pickupTo: Date;
  mobility: string;
}): CrewJobSummary {
  return {
    id: j.id,
    code: j.code,
    state: j.state as JobState,
    plannedStart: j.plannedStart.toISOString(),
    plannedEnd: j.plannedEnd.toISOString(),
    pickupFrom: j.pickupFrom.toISOString(),
    pickupTo: j.pickupTo.toISOString(),
    mobility: j.mobility as CrewJobSummary['mobility'],
    nextStates: crewNext(j.state),
  };
}

function policyDto(
  v: { id: string; version: number; summary: string; publishedAt: Date | null },
  d: { id: string; code: string; title: string; category: string },
  evidenceVersionId: string | null,
): CrewPolicyDto {
  return {
    documentId: d.id,
    versionId: v.id,
    code: d.code,
    title: d.title,
    category: d.category,
    version: v.version,
    summary: v.summary,
    critical: d.category === 'CRITICAL_INSTRUCTION',
    publishedAt: iso(v.publishedAt),
    documentEvidenceVersionId: evidenceVersionId,
  };
}

function deviceDto(d: {
  id: string;
  deviceId: string;
  platform: 'IOS' | 'ANDROID';
  pushToken: string | null;
  appVersion: string | null;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}): DeviceDto {
  return {
    id: d.id,
    deviceId: d.deviceId,
    platform: d.platform,
    pushEnabled: !!d.pushToken && !d.revokedAt,
    appVersion: d.appVersion,
    lastSeenAt: iso(d.lastSeenAt),
    revokedAt: iso(d.revokedAt),
  };
}
