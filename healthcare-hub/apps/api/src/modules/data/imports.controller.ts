import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';
import type { Db, Prisma, TenantTx } from '@hub/db';
import { nextCode } from '@hub/domain';
import {
  ImportCreate,
  MAX_IMPORT_ROWS,
  StaffCreate,
  VehicleCreate,
  WorkbookDecisionInput,
  WorkbookItemsQuery,
  WorkbookProposeInput,
  WorkbookStageInput,
  type ExportDto,
  type ImportBatchDto,
  type ImportDetailDto,
  type WorkbookItemDto,
} from '@hub/contracts';
import { findPlaceholders, headerKey, parseCsv, stageWorkbookRow } from '@hub/rules';
import { OrgMember, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequest, type HubRequestContext } from '../../common/context.js';
import { audit, body, requireAny } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import { userNames } from '../evidence/evidence.mapper.js';

const idPipe = new ParseUUIDPipe({ version: '7', exceptionFactory: () => notFound() });
const ROLLBACK_DAYS = 7;

type Kind = 'STAFF' | 'VEHICLES';
const SPEC: Record<
  Kind,
  { required: string[]; optional: string[]; route: string; permission: string }
> = {
  STAFF: {
    required: ['staffno', 'displayname', 'location'],
    optional: ['jobtitle', 'workingpattern'],
    route: '/api/v1/staff',
    permission: 'staff.profile.manage',
  },
  VEHICLES: {
    required: ['registration', 'callsign', 'type', 'location'],
    optional: ['seats', 'wheelchaircapacity', 'stretcher', 'licencecategory', 'ownership', 'vin'],
    route: '/api/v1/vehicles',
    permission: 'fleet.vehicle.manage',
  },
};

const yes = (v: string) => /^(y|yes|true|1)$/i.test(v.trim());
const num = (v: string) => (v.trim() === '' ? undefined : Number(v.trim()));
const opt = (v: string | undefined) => (v && v.trim() !== '' ? v.trim() : undefined);

/** Reads a CSV upload into header-keyed cells; refuses files the importer cannot use. */
function readCsv(csv: string, required: string[], known: string[]) {
  let rows: string[][];
  try {
    rows = parseCsv(csv);
  } catch (e) {
    throw new HubError(
      'VALIDATION_FAILED',
      400,
      `The file is not valid CSV: ${(e as Error).message}`,
    );
  }
  if (rows.length < 2) throw new HubError('VALIDATION_FAILED', 400, 'The file has no data rows');
  if (rows.length - 1 > MAX_IMPORT_ROWS)
    throw new HubError('VALIDATION_FAILED', 400, `At most ${MAX_IMPORT_ROWS} rows per file`);
  const header = rows[0]!.map(headerKey);
  const missing = required.filter((r) => !header.includes(r));
  if (missing.length)
    throw new HubError('VALIDATION_FAILED', 400, `Missing columns: ${missing.join(', ')}`);
  return {
    header,
    unknown: rows[0]!.filter((h) => !known.includes(headerKey(h))),
    data: rows
      .slice(1)
      .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()]))),
  };
}

/**
 * CSV import (PRD 4.12): upload → preview with per-row errors and duplicates → commit through the
 * normal create endpoints (same checks and audit) → rollback that withdraws what was created
 * without deleting history. Compliance workbook sheets are staged for governance mapping.
 */
@Controller()
export class ImportsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
  ) {}

  @RequirePermission('admin.import.manage')
  @Post('imports')
  async create(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<ImportDetailDto> {
    const input = body(ImportCreate, raw);
    const spec = SPEC[input.kind];
    if (!hub.permissions.has(spec.permission))
      throw new HubError('FORBIDDEN', 403, 'You cannot create these records');
    const { data } = readCsv(input.csv, spec.required, [...spec.required, ...spec.optional]);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const locations = await tx.location.findMany({ select: { id: true, name: true } });
      const locId = (name: string) =>
        locations.find((l) => l.name.toLowerCase() === name.toLowerCase())?.id;
      const seen = new Map<string, number>();
      const rows = [];
      for (const [i, c] of data.entries()) {
        const rowNo = i + 2; // spreadsheet row (header is row 1)
        const errors: string[] = [];
        const loc = locId(c.location ?? '');
        if (!loc) errors.push(`Location "${c.location ?? ''}" not found`);
        const payload =
          input.kind === 'STAFF'
            ? {
                staffNo: c.staffno,
                displayName: c.displayname,
                primaryLocationId: loc ?? '00000000-0000-7000-8000-000000000000',
                jobTitle: opt(c.jobtitle),
                workingPattern: opt(c.workingpattern),
              }
            : {
                registration: c.registration,
                callsign: c.callsign,
                type: (c.type ?? '').toUpperCase().replace(/[\s-]+/g, '_'),
                baseLocationId: loc ?? '00000000-0000-7000-8000-000000000000',
                seats: num(c.seats ?? ''),
                wheelchairCapacity: num(c.wheelchaircapacity ?? ''),
                stretcher: c.stretcher ? yes(c.stretcher) : undefined,
                licenceCategory: opt(c.licencecategory)?.toUpperCase(),
                ownership: opt(c.ownership)?.toUpperCase(),
                vin: opt(c.vin)?.toUpperCase(),
              };
        const clean = Object.fromEntries(
          Object.entries(payload).filter(([, v]) => v !== undefined),
        );
        const parsed = (input.kind === 'STAFF' ? StaffCreate : VehicleCreate).safeParse(clean);
        if (!parsed.success)
          for (const iss of parsed.error.issues)
            if (!(iss.path[0] === 'primaryLocationId' || iss.path[0] === 'baseLocationId') || loc)
              errors.push(`${iss.path.join('.') || 'row'}: ${iss.message}`);
        let duplicateOf: string | null = null;
        if (parsed.success) {
          const p = parsed.data as Record<string, string>;
          const keys =
            input.kind === 'STAFF'
              ? [`staffNo:${p.staffNo}`]
              : [`reg:${p.registration}`, `call:${p.callsign}`];
          for (const k of keys) {
            const earlier = seen.get(k);
            if (earlier && !duplicateOf) duplicateOf = `Same ${k.split(':')[0]} as row ${earlier}`;
            seen.set(k, seen.get(k) ?? rowNo);
          }
          if (!duplicateOf) {
            const existing =
              input.kind === 'STAFF'
                ? await tx.staff.findFirst({
                    where: { staffNo: p.staffNo },
                    select: { staffNo: true },
                  })
                : await tx.vehicle.findFirst({
                    where: { OR: [{ registration: p.registration }, { callsign: p.callsign }] },
                    select: { callsign: true },
                  });
            if (existing)
              duplicateOf = `Already exists: ${'staffNo' in existing ? existing.staffNo : existing.callsign}`;
          }
        }
        rows.push({
          rowNo,
          data: {
            cells: c,
            payload: parsed.success ? parsed.data : clean,
          } as Prisma.InputJsonObject,
          errors,
          duplicateOf,
          status: errors.length ? 'ERROR' : duplicateOf ? 'DUPLICATE' : 'VALID',
        });
      }
      const b = await tx.importBatch.create({
        data: {
          organisationId: hub.orgId as string,
          code: await nextCode(tx, hub.orgId as string, 'IMP'),
          kind: input.kind,
          filename: input.filename,
          rowCount: rows.length,
          validCount: rows.filter((r) => r.status === 'VALID').length,
          errorCount: rows.filter((r) => r.status === 'ERROR').length,
          duplicateCount: rows.filter((r) => r.status === 'DUPLICATE').length,
          createdBy: hub.user.id,
        },
      });
      await tx.importRow.createMany({
        data: rows.map((r) => ({ ...r, organisationId: b.organisationId, batchId: b.id })),
      });
      await audit(this.db, tx, hub, {
        action: 'data.import.preview',
        entity: 'import_batch',
        entityId: b.id,
        summary: {
          kind: b.kind,
          rows: b.rowCount,
          errors: b.errorCount,
          duplicates: b.duplicateCount,
        },
      });
      return this.detail(tx, b.id);
    });
  }

  @RequirePermission('admin.import.manage')
  @Get('imports')
  async list(@Hub() hub: HubRequestContext): Promise<{ data: ImportBatchDto[] }> {
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.importBatch.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }),
    );
    return { data: rows.map(batchDto) };
  }

  @RequirePermission('admin.import.manage')
  @Get('imports/:id')
  get(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string): Promise<ImportDetailDto> {
    return this.db.withTenant(tenantOf(hub), (tx) => this.detail(tx, id));
  }

  /** Creates each valid row through the normal endpoint (same validation, permissions and audit). */
  @RequirePermission('admin.import.manage')
  @Post('imports/:id/commit')
  async commit(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id', idPipe) id: string,
  ): Promise<ImportDetailDto> {
    const b = await this.claim(
      hub,
      id,
      ['PREVIEWED'],
      'COMMITTED',
      'Only a preview can be imported',
    );
    const spec = SPEC[b.kind as Kind];
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.importRow.findMany({ where: { batchId: id, status: 'VALID' }, orderBy: { rowNo: 'asc' } }),
    );
    let ok = 0;
    for (const r of rows) {
      const res = await this.replay(
        req,
        'POST',
        spec.route,
        (r.data as { payload: unknown }).payload,
      );
      if (res.status < 300) ok += 1;
      await this.db.withTenant(tenantOf(hub), (tx) =>
        tx.importRow.update({
          where: { id: r.id },
          data:
            res.status < 300
              ? { status: 'IMPORTED', entityId: String(res.body.id) }
              : {
                  status: 'FAILED',
                  resultDetail: String(res.body.detail ?? res.body.code ?? res.status),
                },
        }),
      );
    }
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      await tx.importBatch.update({
        where: { id },
        data: {
          status: ok === rows.length ? 'COMMITTED' : 'PARTIAL',
          importedCount: ok,
          committedAt: new Date(),
          committedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'data.import.commit',
        entity: 'import_batch',
        entityId: id,
        summary: { imported: ok, failed: rows.length - ok },
      });
      return this.detail(tx, id);
    });
  }

  /**
   * Withdraws what the import created, within 7 days. Nothing is deleted (history is immutable):
   * staff still at candidate stage become leavers and untouched vehicles are taken off the road,
   * both with an "import rolled back" reason. Anything used since the import is kept and listed.
   */
  @RequirePermission('admin.import.manage')
  @Post('imports/:id/rollback')
  async rollback(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id', idPipe) id: string,
  ): Promise<ImportDetailDto> {
    const before = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.importBatch.findUnique({ where: { id } }),
    );
    if (!before || before.kind === 'WORKBOOK') throw notFound();
    if (
      before.committedAt &&
      Date.now() - before.committedAt.getTime() > ROLLBACK_DAYS * 86_400_000
    )
      throw new HubError('CONFLICT', 409, `Imports can be rolled back for ${ROLLBACK_DAYS} days`);
    const b = await this.claim(
      hub,
      id,
      ['COMMITTED', 'PARTIAL'],
      'ROLLED_BACK',
      'Only an import that ran can be rolled back',
    );
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.importRow.findMany({
        where: { batchId: id, status: 'IMPORTED' },
        orderBy: { rowNo: 'asc' },
      }),
    );
    const reason = `Import ${b.code} rolled back`;
    for (const r of rows) {
      const why = await this.db.withTenant(tenantOf(hub), (tx) =>
        inUse(tx, b.kind as Kind, r.entityId!),
      );
      let status = 'KEPT';
      let detail = why;
      if (!why) {
        const res =
          b.kind === 'STAFF'
            ? await this.replay(req, 'POST', `/api/v1/staff/${r.entityId}/transition`, {
                to: 'LEAVER',
                reason,
              })
            : await this.replay(req, 'POST', `/api/v1/vehicles/${r.entityId}/off-road`, {
                on: true,
                reason,
              });
        status = res.status < 300 ? 'ROLLED_BACK' : 'KEPT';
        detail = res.status < 300 ? reason : String(res.body.detail ?? res.status);
      }
      await this.db.withTenant(tenantOf(hub), (tx) =>
        tx.importRow.update({ where: { id: r.id }, data: { status, resultDetail: detail } }),
      );
    }
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      await tx.importBatch.update({
        where: { id },
        data: { rolledBackAt: new Date(), rolledBackBy: hub.user.id },
      });
      await audit(this.db, tx, hub, {
        action: 'data.import.rollback',
        entity: 'import_batch',
        entityId: id,
        summary: { rows: rows.length },
      });
      return this.detail(tx, id);
    });
  }

  @RequirePermission('admin.import.manage')
  @Post('imports/:id/discard')
  async discard(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
  ): Promise<ImportDetailDto> {
    await this.claim(hub, id, ['PREVIEWED'], 'DISCARDED', 'Only a preview can be discarded');
    return this.db.withTenant(tenantOf(hub), (tx) => this.detail(tx, id));
  }

  // ---- compliance workbook staging (MIG-01..03) ------------------------------------------
  @RequirePermission('admin.import.manage')
  @Post('workbook-imports')
  async stage(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<ImportBatchDto> {
    const input = body(WorkbookStageInput, raw);
    const col = {
      code: headerKey(input.columns.code),
      text: headerKey(input.columns.text),
      status: input.columns.status ? headerKey(input.columns.status) : null,
      kloe: input.columns.kloe ? headerKey(input.columns.kloe) : null,
    };
    const required = [
      col.code,
      col.text,
      ...(col.status ? [col.status] : []),
      ...(col.kloe ? [col.kloe] : []),
    ];
    const { data } = readCsv(input.csv, required, required);
    const staged = data
      .map((c, i) => ({
        rowNo: i + 2,
        s: stageWorkbookRow({
          code: c[col.code] ?? '',
          text: c[col.text] ?? '',
          status: col.status ? (c[col.status] ?? '') : '',
          kloe: col.kloe ? (c[col.kloe] ?? '') : '',
        }),
      }))
      .filter((x): x is { rowNo: number; s: NonNullable<typeof x.s> } => x.s !== null);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const b = await tx.importBatch.create({
        data: {
          organisationId: hub.orgId as string,
          code: await nextCode(tx, hub.orgId as string, 'IMP'),
          kind: 'WORKBOOK',
          filename: input.filename,
          sheet: input.sheet,
          status: 'COMMITTED',
          rowCount: staged.length,
          validCount: staged.filter((x) => x.s.kind === 'PROMPT').length,
          importedCount: staged.length,
          committedAt: new Date(),
          committedBy: hub.user.id,
          createdBy: hub.user.id,
        },
      });
      await tx.workbookItem.createMany({
        data: staged.map(({ rowNo, s }) => ({
          organisationId: b.organisationId,
          batchId: b.id,
          sheet: input.sheet,
          rowNo,
          ...s,
        })),
      });
      await audit(this.db, tx, hub, {
        action: 'data.workbook.stage',
        entity: 'import_batch',
        entityId: b.id,
        summary: { sheet: input.sheet, rows: staged.length },
      });
      return batchDto(b);
    });
  }

  /** Importers and the governance reviewers who decide the mappings. */
  @OrgMember()
  @Get('workbook-items')
  async items(
    @Hub() hub: HubRequestContext,
    @Query() q: unknown,
  ): Promise<{ data: WorkbookItemDto[] }> {
    requireAny(hub, 'admin.import.manage', 'admin.requirements.publish');
    const f = body(WorkbookItemsQuery, q);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.workbookItem.findMany({
        where: {
          ...(f.batchId ? { batchId: f.batchId } : {}),
          ...(f.status ? { mappingStatus: f.status } : {}),
        },
        orderBy: [{ sheet: 'asc' }, { rowNo: 'asc' }],
        take: 2000,
      });
      const names = await userNames(
        tx,
        rows.flatMap((r) => [r.proposedBy, r.decidedBy]),
      );
      return {
        data: rows.map((r) => ({
          ...itemDto(r),
          proposedByName: r.proposedBy ? (names.get(r.proposedBy) ?? null) : null,
          decidedByName: r.decidedBy ? (names.get(r.decidedBy) ?? null) : null,
        })),
      };
    });
  }

  @RequirePermission('admin.import.manage')
  @Post('workbook-items/:id/propose')
  async propose(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<WorkbookItemDto> {
    const input = body(WorkbookProposeInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const it = await tx.workbookItem.findUnique({ where: { id } });
      if (!it) throw notFound();
      if (it.kind === 'HEADER')
        throw new HubError(
          'TRANSITION_NOT_ALLOWED',
          422,
          'Header rows are structure and are not mapped',
        );
      if (it.mappingStatus === 'APPROVED' || it.mappingStatus === 'PUBLISHED')
        throw new HubError('CONFLICT', 409, 'This mapping has already been approved');
      const out = input.classification === 'OUT_OF_SCOPE';
      const u = await tx.workbookItem.update({
        where: { id },
        data: {
          classification: input.classification,
          mappingStatus: out ? 'UNMAPPED' : 'PROPOSED',
          proposedCode: out ? null : input.proposedCode!,
          proposedTitle: out ? null : input.proposedTitle!,
          proposedSubject: out ? null : input.proposedSubject!,
          proposedBy: hub.user.id,
          proposedAt: new Date(),
          decidedBy: null,
          decidedAt: null,
          decisionNote: null,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'data.workbook.propose',
        entity: 'workbook_item',
        entityId: id,
        summary: { classification: input.classification, code: input.proposedCode ?? null },
      });
      return itemDto(u);
    });
  }

  /** A governance reviewer approves or rejects; never the person who proposed it. */
  @RequirePermission('admin.requirements.publish')
  @Post('workbook-items/:id/decision')
  async decide(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<WorkbookItemDto> {
    const input = body(WorkbookDecisionInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const it = await tx.workbookItem.findUnique({ where: { id } });
      if (!it) throw notFound();
      if (it.mappingStatus !== 'PROPOSED')
        throw new HubError('CONFLICT', 409, 'Only a proposed mapping can be decided');
      if (it.proposedBy === hub.user.id)
        throw new HubError('SELF_APPROVAL', 422, 'Someone other than the proposer must decide');
      const u = await tx.workbookItem.update({
        where: { id },
        data: {
          mappingStatus: input.decision,
          decidedBy: hub.user.id,
          decidedAt: new Date(),
          decisionNote: input.note ?? null,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'data.workbook.decide',
        entity: 'workbook_item',
        entityId: id,
        summary: { decision: input.decision },
      });
      return itemDto(u);
    });
  }

  /**
   * Only approved mappings publish, and only as a DRAFT library template: it becomes active
   * through the normal version approval and publishing flow.
   */
  @RequirePermission('admin.requirements.publish', 'admin.settings.manage')
  @Post('workbook-items/:id/publish')
  async publish(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id', idPipe) id: string,
  ): Promise<WorkbookItemDto> {
    const it = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.workbookItem.findUnique({ where: { id } }),
    );
    if (!it) throw notFound();
    if (it.mappingStatus !== 'APPROVED')
      throw new HubError('CONFLICT', 409, 'Only an approved mapping can be published');
    if (findPlaceholders(it.proposedTitle ?? '').length > 0)
      throw new HubError('VALIDATION_FAILED', 400, 'Resolve the placeholders in the title first');
    const ref = `${it.sheet}!${it.rowNo}${it.promptCode ? `:${it.promptCode}` : ''}`.slice(0, 60);
    const res = await this.replay(req, 'POST', '/api/v1/requirements/templates', {
      code: it.proposedCode,
      title: it.proposedTitle,
      version: {
        basisType: 'GOOD_PRACTICE',
        subjectType: it.proposedSubject,
        recurrence: { type: 'EVENT_TRIGGERED' },
        frameworkMappings: [
          { framework: 'WORKBOOK', key: ref },
          ...it.legacyKloe.slice(0, 19).map((k) => ({ framework: 'CQC_KLOE_LEGACY', key: k })),
        ],
      },
    });
    if (res.status >= 300)
      throw new HubError(
        res.status === 409 ? 'CONFLICT' : 'VALIDATION_FAILED',
        res.status === 409 ? 409 : 400,
        String(res.body.detail ?? 'Could not publish'),
      );
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const u = await tx.workbookItem.update({
        where: { id },
        data: { mappingStatus: 'PUBLISHED', publishedTemplateId: String(res.body.id) },
      });
      await audit(this.db, tx, hub, {
        action: 'data.workbook.publish',
        entity: 'workbook_item',
        entityId: id,
        summary: { templateId: String(res.body.id) },
      });
      return itemDto(u);
    });
  }

  // ---- full export (data portability) -------------------------------------------------------
  @RequirePermission('admin.export.full')
  @Post('exports/full')
  async fullExport(@Hub() hub: HubRequestContext): Promise<ExportDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const pending = await tx.exportJob.count({
        where: { requestedBy: hub.user.id, status: { in: ['QUEUED', 'RUNNING'] } },
      });
      if (pending >= 3)
        throw new HubError('RATE_LIMITED', 429, 'Wait for your earlier exports to finish');
      const j = await tx.exportJob.create({
        data: {
          organisationId: hub.orgId as string,
          kind: 'FULL_EXPORT',
          params: {},
          requestedBy: hub.user.id,
          requesterPermissions: [...hub.permissions],
        },
      });
      await audit(this.db, tx, hub, {
        action: 'data.export.full.request',
        entity: 'export_job',
        entityId: j.id,
      });
      return {
        id: j.id,
        kind: j.kind,
        status: j.status,
        bytes: null,
        error: null,
        createdAt: j.createdAt.toISOString(),
        finishedAt: null,
        download: null,
      };
    });
  }

  // ---- helpers --------------------------------------------------------------------------------
  /** Moves a batch from one of `from` to `to`, refusing concurrent or repeated actions. */
  private async claim(hub: HubRequestContext, id: string, from: string[], to: string, msg: string) {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const b = await tx.importBatch.findUnique({ where: { id } });
      if (!b || b.kind === 'WORKBOOK') throw notFound();
      const n = await tx.importBatch.updateMany({
        where: { id, status: { in: from }, version: b.version },
        data: { status: to },
      });
      if (n.count === 0) throw new HubError('CONFLICT', 409, msg);
      return b;
    });
  }

  private async replay(req: HubRequest, method: 'POST', url: string, payload: unknown) {
    const app = this.host.httpAdapter.getInstance<FastifyInstance>();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    for (const h of ['authorization', 'x-org-id', 'x-location-id']) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }
    const res = await app.inject({ method, url, headers, payload: JSON.stringify(payload) });
    let json: Record<string, unknown>;
    try {
      json = res.json();
    } catch {
      json = {};
    }
    return { status: res.statusCode, body: json };
  }

  private async detail(tx: TenantTx, id: string): Promise<ImportDetailDto> {
    const b = await tx.importBatch.findUnique({
      where: { id },
      include: { rows: { orderBy: { rowNo: 'asc' } } },
    });
    if (!b) throw notFound();
    return {
      ...batchDto(b),
      rows: b.rows.map((r) => ({
        rowNo: r.rowNo,
        status: r.status as ImportDetailDto['rows'][number]['status'],
        data: ((r.data as { cells?: Record<string, unknown> }).cells ?? {}) as Record<
          string,
          unknown
        >,
        errors: r.errors,
        duplicateOf: r.duplicateOf,
        entityId: r.entityId,
        resultDetail: r.resultDetail,
      })),
    };
  }
}

/** Why an imported record can no longer be withdrawn (null when it is untouched). */
async function inUse(tx: TenantTx, kind: Kind, id: string): Promise<string | null> {
  if (kind === 'STAFF') {
    const s = await tx.staff.findUnique({
      where: { id },
      select: { lifecycleState: true, userId: true },
    });
    if (!s) return 'Record not found';
    if (s.lifecycleState !== 'CANDIDATE') return 'Moved past candidate stage since the import';
    if (s.userId) return 'Linked to a user account since the import';
    if (await tx.staffRecord.findFirst({ where: { staffId: id }, select: { id: true } }))
      return 'Has records added since the import';
    if (await tx.staffRoleApproval.findFirst({ where: { staffId: id }, select: { id: true } }))
      return 'Has role approvals since the import';
    return null;
  }
  const v = await tx.vehicle.findUnique({ where: { id }, select: { version: true } });
  if (!v) return 'Record not found';
  if (v.version > 1) return 'Changed since the import';
  const used = await Promise.all([
    tx.vdi.findFirst({ where: { vehicleId: id }, select: { id: true } }),
    tx.defect.findFirst({ where: { vehicleId: id }, select: { id: true } }),
    tx.shift.findFirst({ where: { vehicleId: id }, select: { id: true } }),
    tx.odometerReading.findFirst({ where: { vehicleId: id }, select: { id: true } }),
  ]);
  return used.some(Boolean) ? 'Used since the import (checks, defects, shifts or mileage)' : null;
}

function batchDto(b: Prisma.ImportBatchGetPayload<object>): ImportBatchDto {
  return {
    id: b.id,
    code: b.code,
    kind: b.kind as ImportBatchDto['kind'],
    filename: b.filename,
    sheet: b.sheet,
    status: b.status as ImportBatchDto['status'],
    rowCount: b.rowCount,
    validCount: b.validCount,
    errorCount: b.errorCount,
    duplicateCount: b.duplicateCount,
    importedCount: b.importedCount,
    createdAt: b.createdAt.toISOString(),
    committedAt: b.committedAt?.toISOString() ?? null,
    rolledBackAt: b.rolledBackAt?.toISOString() ?? null,
    version: b.version,
  };
}

function itemDto(i: Prisma.WorkbookItemGetPayload<object>): WorkbookItemDto {
  return {
    id: i.id,
    batchId: i.batchId,
    sheet: i.sheet,
    rowNo: i.rowNo,
    promptCode: i.promptCode,
    kind: i.kind as WorkbookItemDto['kind'],
    text: i.text,
    placeholders: i.placeholders,
    sourceStatus: i.sourceStatus,
    legacyKloe: i.legacyKloe,
    classification: i.classification as WorkbookItemDto['classification'],
    mappingStatus: i.mappingStatus as WorkbookItemDto['mappingStatus'],
    proposedCode: i.proposedCode,
    proposedTitle: i.proposedTitle,
    proposedSubject: i.proposedSubject,
    proposedBy: i.proposedBy,
    decidedBy: i.decidedBy,
    decisionNote: i.decisionNote,
    publishedTemplateId: i.publishedTemplateId,
    version: i.version,
  };
}
