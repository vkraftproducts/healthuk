// S.people – the people file (v36 Staff › People, person file, onboarding, checks), from the staff,
// lifecycle, approval, restriction, requirement-instance and evidence tables.
import type { TenantTx } from '@hub/db';
import { recomputeInstance } from '@hub/domain';
import { londonDate } from '@hub/rules';
import { HubError } from '../../../common/problem.filter.js';
import { loadPeople, stamp, type People } from './lookup.js';
import type { V36Adapter, V36Ctx, V36Record } from './types.js';
import {
  CHECK_TEMPLATE,
  CONTRACT,
  CONTRACT_TYPE,
  JOB_ROLE,
  RESTRICTION_TYPE,
  RESTRICTION_WORDS,
  ROLE_JOB,
  SENSITIVE_CHECKS,
  STAGE,
  STAGE_STATE,
  TEMPLATE_CHECK,
  arr,
  auditSql,
  clean,
  d10,
  endOfDay,
  fromStamp,
  isDay,
  ld,
  rec,
  refuse,
  same,
  str,
} from './staff-lib.js';

/** Lifecycle reasons written by seeds/moves, not by a person's decision (not shown as v36 notes). */
const SYSTEM_REASONS = /^(v36 sample record|Entered this stage|Seeded synthetic record|Record created|Moved in from the v36 copy|Checks started for )/;
/** Buttons whose people-side effects are made by another collection's adapter. */
const OTHERS_DO_IT = new Set([
  'absNew',
  'absRtw',
  'lvNew',
  'lvTick',
  'lvDone',
  'sesNew',
  'sesVer',
  'sesRej',
  'tpAtt',
]);

type Level = 'full' | 'clearance' | 'min';
function level(ctx: V36Ctx): Level {
  const p = ctx.hub.permissions;
  if (p.has('staff.profile.view_basic')) return 'full';
  if (p.has('staff.profile.view_clearance')) return 'clearance';
  return 'min';
}

interface StaffRow {
  id: string;
  staff_no: string;
  user_id: string | null;
  display_name: string;
  lifecycle_state: string;
  job_title: string | null;
  start_date: Date | null;
  contract_type: string | null;
  line_manager_user_id: string | null;
  line_manager_name: string | null;
  version: number;
}
interface EventRow {
  staff_id: string;
  from_state: string | null;
  to_state: string;
  reason: string;
  actor_user_id: string | null;
  at: Date;
}
interface RestrRow {
  id: string;
  staff_id: string;
  code: string | null;
  type: string;
  detail: string | null;
  reason: string;
  applied_by: string;
  valid_from: Date;
  valid_to: Date | null;
  lifted_at: Date | null;
  lifted_by: string | null;
  created_at: Date;
}
interface InstRow {
  id: string;
  staff_id: string;
  tcode: string;
  applicability: string;
  review_date: Date | null;
}
interface VerRow {
  instance_id: string;
  version_id: string;
  uploaded_by: string;
  uploaded_at: Date;
  valid_to: Date | null;
  channel: string | null;
  sensitivity: string;
  decision: string | null;
  reason: string | null;
  reviewer_id: string | null;
  decided_at: Date | null;
  confirmed_valid_to: Date | null;
  file_name: string | null;
  supplied_by: string | null;
  note: string | null;
  session_code: string | null;
}
interface ChaseRow {
  id: string;
  staff_id: string;
  check_code: string;
  requested_on: Date | null;
  received_on: Date | null;
  due_on: Date | null;
  chased_dates: Date[];
  note: string | null;
}
interface CommentRow {
  staff_id: string;
  check_code: string;
  body: string;
  author_name: string | null;
  created_by: string;
  created_at: Date;
}

// ---- load ------------------------------------------------------------------------------------------
async function loadPeopleMap(ctx: V36Ctx): Promise<Record<string, V36Record>> {
  const lvl = level(ctx);
  const today = ctx.today;
  return ctx.tx(async (tx) => {
    const P = await loadPeople(tx);
    const staff = await tx.$queryRaw<StaffRow[]>`
      SELECT id, staff_no, user_id, display_name, lifecycle_state::text, job_title, start_date,
             contract_type, line_manager_user_id, line_manager_name, version
        FROM staff ORDER BY staff_no`;
    const events = await tx.$queryRaw<EventRow[]>`
      SELECT staff_id, from_state::text, to_state::text, reason, actor_user_id, at
        FROM staff_lifecycle_event ORDER BY at, id`;
    const restr = await tx.$queryRaw<RestrRow[]>`
      SELECT id, staff_id, code, type::text, detail, reason, applied_by, valid_from, valid_to,
             lifted_at, lifted_by, created_at
        FROM staff_restriction ORDER BY valid_from, created_at, id`;
    const appr = await tx.$queryRaw<
      { staff_id: string; role: string; reason: string; approved_by: string; valid_from: Date }[]
    >`SELECT staff_id, role::text, reason, approved_by, valid_from FROM staff_role_approval
       WHERE revoked_at IS NULL ORDER BY valid_from`;
    const leavers = await tx.$queryRaw<{ staff_id: string; last_day: Date }[]>`
      SELECT staff_id, last_day FROM leaver_record WHERE status <> 'CANCELLED' ORDER BY created_at`;
    const insts = await tx.$queryRaw<InstRow[]>`
      SELECT ri.id, ri.subject_id AS staff_id, t.code AS tcode, ri.applicability::text,
             ri.review_date
        FROM requirement_instance ri JOIN requirement_template t ON t.id = ri.template_id
       WHERE ri.subject_type = 'STAFF' AND t.code = ANY(${Object.values(CHECK_TEMPLATE)}::text[])`;
    const vers = await tx.$queryRaw<VerRow[]>`
      SELECT l.instance_id, v.id AS version_id, v.uploaded_by, v.uploaded_at, v.valid_to, v.channel,
             i.sensitivity, vf.decision::text, vf.reason, vf.reviewer_id, vf.created_at AS decided_at,
             vf.confirmed_valid_to, r.file_name, r.supplied_by, r.note, r.session_code
        FROM evidence_link l
        JOIN evidence_item i ON i.id = l.item_id
        JOIN evidence_version v ON v.item_id = l.item_id
        LEFT JOIN verification vf ON vf.evidence_version_id = v.id
        LEFT JOIN staff_check_receipt r ON r.evidence_version_id = v.id
       WHERE v.uploaded_at IS NOT NULL AND v.scan_status = 'CLEAN'
         AND l.instance_id IN (
           SELECT ri.id FROM requirement_instance ri WHERE ri.subject_type = 'STAFF')
       ORDER BY v.uploaded_at, v.version_no`;
    const chases = await tx.$queryRaw<ChaseRow[]>`
      SELECT id, staff_id, check_code, requested_on, received_on, due_on, chased_dates, note
        FROM staff_chase_log WHERE check_code IS NOT NULL ORDER BY created_at`;
    const comments = await tx.$queryRaw<CommentRow[]>`
      SELECT staff_id, check_code, body, author_name, created_by, created_at
        FROM staff_check_comment ORDER BY created_at, id`;

    const group = <T extends { staff_id: string }>(rows: T[]) => {
      const m = new Map<string, T[]>();
      for (const r of rows) m.set(r.staff_id, [...(m.get(r.staff_id) ?? []), r]);
      return m;
    };
    const evBy = group(events);
    const rsBy = group(restr);
    const apBy = group(appr);
    const lvBy = group(leavers);
    const inBy = group(insts);
    const chBy = group(chases);
    const cmBy = group(comments);
    const verBy = new Map<string, VerRow[]>();
    for (const v of vers) verBy.set(v.instance_id, [...(verBy.get(v.instance_id) ?? []), v]);
    const me = ctx.userId;
    const seeAll =
      ctx.hub.permissions.has('staff.sensitive.view') ||
      ctx.hub.permissions.has('compliance.evidence.verify');

    const out: Record<string, V36Record> = {};
    for (const s of staff) {
      const own = s.user_id === me;
      const L: Level = own ? 'full' : lvl;
      const stage = STAGE[s.lifecycle_state] ?? s.lifecycle_state;
      const p: V36Record = {
        id: s.staff_no,
        name: s.display_name,
        job: s.job_title ?? '',
        stage,
        start: d10(s.start_date) ?? '',
        contract: (s.contract_type && CONTRACT[s.contract_type]) || 'Not recorded',
        lm: P.nameOf(s.line_manager_user_id) ?? s.line_manager_name ?? '',
        restr: [],
        items: {},
      };
      if (L === 'min') {
        out[s.staff_no] = p;
        continue;
      }
      // Restrictions.
      p.restr = (rsBy.get(s.id) ?? []).map((r) => {
        const abs = /Sickness absence (ABS-\d+)/.exec(r.reason)?.[1];
        return clean({
          id: r.code ?? r.id,
          t: r.detail ?? RESTRICTION_WORDS[r.type] ?? r.type,
          until: r.valid_to ? (ld(r.valid_to) ?? undefined) : undefined,
          reason: L === 'full' ? r.reason : undefined,
          by: P.nameOf(r.applied_by) ?? undefined,
          on: stamp(r.valid_from) ?? undefined,
          ended: r.lifted_at
            ? { by: P.nameOf(r.lifted_by) ?? '', on: stamp(r.lifted_at) ?? '' }
            : undefined,
          abs,
        });
      });
      const ev = evBy.get(s.id) ?? [];
      const human = ev.filter((e) => !SYSTEM_REASONS.test(e.reason));
      // When they entered the current stage (v36 setStage): the last real move into it.
      const stageEv = ev
        .filter(
          (e) =>
            e.to_state === s.lifecycle_state &&
            (e.from_state !== null || e.reason === 'Entered this stage'),
        )
        .at(-1);
      if (stageEv) p.stageOn = ld(stageEv.at);
      if (L === 'full') {
        const sub = human.filter((e) => e.to_state === 'READY_FOR_REVIEW').at(-1);
        if (sub)
          p.submitted = { by: P.nameOf(sub.actor_user_id) ?? '', on: stamp(sub.at), note: sub.reason };
        const ret = human
          .filter((e) => e.from_state === 'READY_FOR_REVIEW' && e.to_state === 'CHECKS_IN_PROGRESS')
          .at(-1);
        if (ret && (!sub || ret.at > sub.at))
          p.returned = { by: P.nameOf(ret.actor_user_id) ?? '', on: stamp(ret.at), why: ret.reason };
        const sus = human.filter((e) => e.to_state === 'SUSPENDED').at(-1);
        if (sus)
          p.susp = { by: P.nameOf(sus.actor_user_id) ?? '', on: stamp(sus.at), why: sus.reason };
        const aps = apBy.get(s.id) ?? [];
        const main = aps.find((a) => a.role === JOB_ROLE[s.job_title ?? '']) ?? aps.at(-1);
        if (main) {
          const atAppr = (rsBy.get(s.id) ?? []).find((r) => r.reason === 'Set at approval');
          p.approved = clean({
            by: P.nameOf(main.approved_by) ?? '',
            on: stamp(main.valid_from),
            role: ROLE_JOB[main.role] ?? s.job_title ?? main.role,
            note: /^(Approved for role|Seeded synthetic approval)/.test(main.reason)
              ? undefined
              : main.reason,
            restr: atAppr ? (atAppr.detail ?? undefined) : undefined,
          });
        }
      }
      if (s.lifecycle_state === 'LEAVER') {
        const lv = (lvBy.get(s.id) ?? []).at(-1);
        if (lv) p.left = d10(lv.last_day);
      }
      // Checks.
      const items: Record<string, V36Record> = {};
      for (const i of inBy.get(s.id) ?? []) {
        const code = TEMPLATE_CHECK[i.tcode];
        if (!code) continue;
        const it = buildItem({
          code,
          inst: i,
          versions: verBy.get(i.id) ?? [],
          chase: (chBy.get(s.id) ?? []).filter((c) => c.check_code === code).at(-1),
          comments: (cmBy.get(s.id) ?? []).filter((c) => c.check_code === code),
          staffName: s.display_name,
          P,
          today,
          hideFile: L !== 'full' || (SENSITIVE_CHECKS.has(code) && !seeAll && !own),
        });
        items[code] =
          L === 'full' ? it : clean({ s: it.s, exp: it.exp, review: it.review } as V36Record);
      }
      p.items = items;
      out[s.staff_no] = p;
    }
    return out;
  });
}

function buildItem(a: {
  code: string;
  inst: InstRow;
  versions: VerRow[];
  chase: ChaseRow | undefined;
  comments: CommentRow[];
  staffName: string;
  P: People;
  today: string;
  hideFile: boolean;
}): V36Record {
  const { P, chase } = a;
  const com = a.comments.length
    ? a.comments.map((c) => ({
        by: c.author_name ?? P.nameOf(c.created_by) ?? '',
        on: stamp(c.created_at),
        t: c.body,
      }))
    : undefined;
  if (a.inst.applicability === 'APPROVED_NOT_APPLICABLE') return clean({ s: 'na', com });
  const who = (v: VerRow) =>
    v.supplied_by ??
    (v.channel === 'CANDIDATE_PORTAL'
      ? `${a.staffName} (candidate portal)`
      : (P.nameOf(v.uploaded_by) ?? ''));
  const expOf = (v: VerRow) => d10(v.confirmed_valid_to ?? v.valid_to);
  const dbsReview = a.code === 'DBS' ? d10(a.inst.review_date) : null;
  const doc = (v: VerRow) =>
    clean({
      by: who(v),
      rcv: ld(v.uploaded_at),
      file: a.hideFile ? undefined : (v.file_name ?? undefined),
      note: a.hideFile ? undefined : (v.note ?? undefined),
      sess: v.session_code ?? undefined,
    });
  const okOf = (v: VerRow): V36Record =>
    clean({
      ...doc(v),
      vby: P.nameOf(v.reviewer_id) ?? '',
      von: ld(v.decided_at),
      ...(dbsReview ? { review: dbsReview } : { exp: expOf(v) }),
      vnote: v.reason ?? undefined,
    });
  const latest = a.versions.at(-1);
  const accepted = a.versions.filter((v) => v.decision === 'ACCEPTED');
  const chaseFields = (open: boolean) =>
    chase
      ? clean({
          req: d10(chase.requested_on) ?? undefined,
          due: open || !chase.received_on ? (d10(chase.due_on) ?? undefined) : undefined,
          chase: open ? chase.chased_dates.map((x) => d10(x)!) : undefined,
          note: open ? (chase.note ?? undefined) : undefined,
        })
      : {};
  if (!latest) {
    if (chase && !chase.received_on) return clean({ s: 'req', ...chaseFields(true), com });
    return clean({ s: 'none', com });
  }
  if (!latest.decision) {
    const prevV = accepted.at(-1);
    const prev = prevV
      ? clean({ exp: expOf(prevV), vby: P.nameOf(prevV.reviewer_id) ?? '', von: ld(prevV.decided_at) })
      : undefined;
    return clean({
      s: 'rcv',
      ...doc(latest),
      exp: expOf(latest),
      req: chase ? (d10(chase.requested_on) ?? undefined) : undefined,
      prev,
      com,
    });
  }
  if (latest.decision === 'ACCEPTED') return clean({ ...okOf(latest), s: 'ok', com });
  // Rejected: an earlier verified document that is still in date stands.
  const rej = {
    why: latest.reason ?? '',
    by: P.nameOf(latest.reviewer_id) ?? '',
    on: ld(latest.decided_at),
  };
  const due = chase ? (d10(chase.due_on) ?? undefined) : undefined;
  const prevV = accepted.at(-1);
  if (prevV && (!expOf(prevV) || expOf(prevV)! >= a.today))
    return clean({ ...okOf(prevV), s: 'ok', rej, due, com });
  return clean({ s: 'rej', ...doc(latest), rej, due, com });
}

// ---- apply -----------------------------------------------------------------------------------------
async function staffRow(ctx: V36Ctx, code: string) {
  const rows = await ctx.tx(
    (tx) =>
      tx.$queryRaw<
        { id: string; version: number; lifecycle_state: string }[]
      >`SELECT id, version, lifecycle_state::text FROM staff WHERE staff_no = ${code}`,
  );
  if (!rows[0]) throw new HubError('NOT_FOUND', 404, `No person ${code}`);
  return rows[0];
}

async function setLineManager(ctx: V36Ctx, staffId: string, lm: unknown) {
  const name = str(lm);
  const userId = name ? await ctx.tx(async (tx) => (await loadPeople(tx)).userIdOf(name)) : null;
  await ctx.api('POST', `/staff/${staffId}/line-manager`, { userId, name: userId ? null : name });
}

async function applyPeople(ctx: V36Ctx, c: { id: string; before: V36Record | null; after: V36Record | null }) {
  if (ctx.act && OTHERS_DO_IT.has(ctx.act)) return;
  if (ctx.act && ['impGo', 'impUndo', 'bigOn', 'bigOff'].includes(ctx.act))
    throw refuse('Import people from Settings › Import (CSV); demo data cannot be added here');
  const b = c.before;
  const a = c.after;
  if (!a) throw refuse('People are never deleted; move them to Left instead', 403);
  if (!b) return newStarter(ctx, c.id, a);

  const row = await staffRow(ctx, c.id);
  const sid = row.id;
  // 1. Profile fields.
  const patch: Record<string, unknown> = {};
  if (a.name !== b.name && str(a.name)) patch.displayName = str(a.name);
  if (a.job !== b.job && str(a.job)) patch.jobTitle = str(a.job);
  if (a.start !== b.start) patch.startDate = isDay(a.start) ? a.start : null;
  if (a.contract !== b.contract)
    patch.contractType = CONTRACT_TYPE[String(a.contract)] ?? null;
  if (Object.keys(patch).length) await ctx.api('PATCH', `/staff/${sid}`, patch, row.version);
  if (a.lm !== b.lm) await setLineManager(ctx, sid, a.lm);

  // 2. Stage.
  if (a.stage !== b.stage) await moveStage(ctx, sid, b, a);

  // 3. Restrictions.
  const before = new Map(arr(b.restr).map((r) => [String(r.id ?? JSON.stringify(r)), r]));
  for (const r of arr(a.restr)) {
    const key = String(r.id ?? JSON.stringify(r));
    const old = before.get(key);
    if (!old) {
      if (r.abs) continue; // the absence record adds it
      const t = str(r.t) ?? 'Restriction';
      const type = RESTRICTION_TYPE[t] ?? 'OTHER';
      const until = isDay(r.until) ? r.until : null;
      await ctx.api('POST', `/staff/${sid}/restrictions`, {
        type,
        detail: t.slice(0, 200),
        reason: (str(r.reason) ?? t).slice(0, 500),
        ...(until ? { validTo: endOfDay(until).toISOString() } : {}),
      });
      continue;
    }
    if (r.ended && !old.ended) {
      const rid = await ctx.tx(async (tx) => {
        const x = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM staff_restriction WHERE staff_id = ${sid}::uuid
             AND (code = ${key} OR id::text = ${key}) LIMIT 1`;
        return x[0]?.id;
      });
      if (!rid) throw new HubError('NOT_FOUND', 404, 'That restriction is not on record');
      await ctx.api('POST', `/staff/${sid}/restrictions/${rid}/lift`, {
        reason: 'Restriction ended',
      });
    }
  }

  // 4. Checks.
  const bi = rec(b.items);
  const ai = rec(a.items);
  for (const code of Object.keys(ai)) {
    if (!CHECK_TEMPLATE[code]) continue;
    const o = rec(bi[code]);
    const n = rec(ai[code]);
    if (same(o, n)) continue;
    await applyItem(ctx, sid, code, o, n);
  }
}

async function newStarter(ctx: V36Ctx, code: string, a: V36Record) {
  if (a.stage !== 'Candidate')
    throw refuse('A new person starts as a candidate; add them with "Add a new starter"');
  if (!/^ST-\d{4,6}$/.test(code)) throw refuse('Staff numbers look like ST-0123');
  const loc = await ctx.tx(
    (tx) =>
      tx.$queryRaw<{ id: string }[]>`SELECT id FROM location ORDER BY created_at, id LIMIT 1`,
  );
  if (!loc[0]) throw refuse('Add a location in Settings first');
  const s = await ctx.api<{ id: string }>('POST', '/staff', {
    staffNo: code,
    displayName: str(a.name) ?? code,
    primaryLocationId: loc[0].id,
    ...(str(a.job) ? { jobTitle: str(a.job) } : {}),
    ...(isDay(a.start) ? { startDate: a.start } : {}),
    ...(CONTRACT_TYPE[String(a.contract)] ? { contractType: CONTRACT_TYPE[String(a.contract)] } : {}),
  });
  if (str(a.lm)) await setLineManager(ctx, s.id, a.lm);
}

async function moveStage(ctx: V36Ctx, sid: string, b: V36Record, a: V36Record) {
  const to = STAGE_STATE[String(a.stage)];
  if (!to) throw refuse(`Unknown stage ${String(a.stage)}`);
  const go = (reason: string) =>
    ctx.api('POST', `/staff/${sid}/transition`, { to, reason: reason.slice(0, 500) });
  switch (to) {
    case 'CHECKS_IN_PROGRESS': {
      if (b.stage === 'Candidate') {
        const role = JOB_ROLE[String(a.job)];
        if (!role) throw refuse(`No checks are set up for the role ${String(a.job)}`);
        await ctx.api('POST', `/staff/${sid}/role-checks`, { role });
        return;
      }
      const why = str(rec(a.returned).why);
      return void (await go(why ?? 'Returned to checks'));
    }
    case 'READY_FOR_REVIEW':
      return void (await go(str(rec(a.submitted).note) ?? 'Submitted for approval'));
    case 'APPROVED_FOR_ROLE': {
      const role = JOB_ROLE[String(a.job)];
      if (!role) throw refuse(`${String(a.job)} is not a role that can be approved here`);
      const note = str(rec(a.approved).note);
      await ctx.api('POST', `/staff/${sid}/role-approvals`, {
        role,
        reason: (note ?? 'Approved for role').slice(0, 500),
      });
      return void (await go(note ?? 'Approved for role'));
    }
    case 'ACTIVE':
      return void (await go(b.stage === 'Suspended' ? 'Suspension lifted' : 'Marked active'));
    case 'SUSPENDED':
      return void (await go(str(rec(a.susp).why) ?? 'Suspended'));
    case 'LEAVER':
      return; // the leaver record does it (lvTick / lvDone)
    default:
      return void (await go('Stage changed'));
  }
}

async function pendingVersion(ctx: V36Ctx, sid: string, code: string) {
  const rows = await ctx.tx(
    (tx) =>
      tx.$queryRaw<{ id: string }[]>`
      SELECT v.id FROM requirement_instance ri
        JOIN requirement_template t ON t.id = ri.template_id
        JOIN evidence_link l ON l.instance_id = ri.id
        JOIN evidence_version v ON v.item_id = l.item_id
        LEFT JOIN verification vf ON vf.evidence_version_id = v.id
       WHERE ri.subject_type = 'STAFF' AND ri.subject_id = ${sid}::uuid
         AND t.code = ${CHECK_TEMPLATE[code]!} AND vf.id IS NULL
         AND v.uploaded_at IS NOT NULL AND v.scan_status = 'CLEAN'
       ORDER BY v.uploaded_at DESC LIMIT 1`,
  );
  if (!rows[0]) throw refuse('There is no document waiting for verification on this check');
  return rows[0].id;
}

async function applyItem(ctx: V36Ctx, sid: string, code: string, o: V36Record, n: V36Record) {
  const base = `/staff/${sid}/checks/${code}`;
  // Comments added.
  const oc = arr(o.com);
  for (const x of arr(n.com).slice(oc.length)) {
    const t = str(x.t);
    if (t) await ctx.api('POST', `${base}/comments`, { text: t });
  }
  const s0 = String(o.s ?? 'none');
  const s1 = String(n.s ?? 'none');
  // Received (itUp, candUp).
  if (s1 === 'rcv' && (s0 !== 'rcv' || n.rcv !== o.rcv || n.file !== o.file)) {
    const file = str(n.file);
    if (!file) throw refuse('Give the document name');
    await ctx.api('POST', `${base}/received`, {
      fileName: file.slice(0, 200),
      ...(isDay(n.exp) ? { validTo: n.exp } : {}),
      ...(str(n.note) ? { note: str(n.note) } : {}),
    });
    return;
  }
  // Verified (itVer).
  if (s1 === 'ok' && s0 === 'rcv' && !n.rej) {
    const vid = await pendingVersion(ctx, sid, code);
    const vnote = str(n.vnote);
    await ctx.api('POST', `/evidence/${vid}/verify`, {
      decision: 'ACCEPTED',
      ...(isDay(n.exp) ? { confirmedValidTo: n.exp } : {}),
      ...(vnote && vnote.length >= 3 ? { reason: vnote.slice(0, 1000) } : {}),
    });
    return;
  }
  // Rejected (itRej) – v36 keeps an earlier verified document that is still in date.
  if (n.rej && !same(n.rej, o.rej)) {
    const why = str(rec(n.rej).why);
    if (!why || why.length < 3) throw refuse('Give a reason (at least 3 characters)');
    const vid = await pendingVersion(ctx, sid, code);
    await ctx.api('POST', `/evidence/${vid}/verify`, { decision: 'REJECTED', reason: why });
    if (isDay(n.due)) await ctx.api('POST', `${base}/follow-up`, { due: n.due });
    return;
  }
  // Requested (itReq, startChecks "send portal link").
  if (s1 === 'req' && s0 !== 'req') {
    await ctx.api('POST', `${base}/request`, {
      due: isDay(n.due) ? n.due : londonDate(new Date()),
      ...(str(n.note) ? { note: str(n.note) } : {}),
    });
    return;
  }
  // Chased (itChase).
  if (arr(n.chase).length > arr(o.chase).length) {
    await ctx.api('POST', `${base}/chase`, {
      due: isDay(n.due) ? n.due : londonDate(new Date()),
      ...(str(n.note) && n.note !== o.note ? { note: str(n.note) } : {}),
    });
    return;
  }
  // Only the follow-up date or note changed (e.g. referee details from the candidate portal).
  if ((n.due !== o.due || n.note !== o.note) && s1 === s0 && (s1 === 'req' || s1 === 'rej')) {
    await ctx.api('POST', `${base}/follow-up`, {
      due: isDay(n.due) ? n.due : null,
      ...(str(n.note) ? { note: str(n.note) } : {}),
    });
    return;
  }
  if (s1 === 'none' && s0 === 'none') return;
  if (arr(n.com).length > oc.length) return; // only a comment
  throw refuse(`This change to ${code} cannot be saved here`);
}

// ---- import ----------------------------------------------------------------------------------------
async function importPeople(ctx: V36Ctx, records: Record<string, V36Record>) {
  await ctx.tx(async (tx) => {
    const P = await loadPeople(tx);
    const me = ctx.userId;
    const loc = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM location ORDER BY created_at, id LIMIT 1`;
    if (!loc[0]) throw refuse('Add a location before moving people in');
    const tpl = await tx.$queryRaw<{ code: string; template_id: string; version_id: string }[]>`
      SELECT DISTINCT ON (t.code) t.code, t.id AS template_id, v.id AS version_id
        FROM requirement_template t JOIN requirement_template_version v ON v.template_id = t.id
       WHERE t.organisation_id = app_org_id() AND v.status = 'EFFECTIVE'
       ORDER BY t.code, v.version DESC`;
    const tplOf = new Map(tpl.map((t) => [t.code, t]));
    const linked = new Set(
      (await tx.$queryRaw<{ user_id: string }[]>`SELECT user_id FROM staff WHERE user_id IS NOT NULL`).map(
        (r) => r.user_id,
      ),
    );
    const now = new Date();
    let n = 0;
    for (const [code, p] of Object.entries(records)) {
      if (!/^ST-\d{4,6}$/.test(code)) continue;
      const state = STAGE_STATE[String(p.stage)] ?? 'CANDIDATE';
      const lmId = P.userIdOf(str(p.lm));
      let userId = P.userIdOf(str(p.name));
      if (userId && linked.has(userId)) userId = null;
      if (userId) linked.add(userId);
      const [s] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO staff (organisation_id, staff_no, user_id, display_name, lifecycle_state,
                           primary_location_id, job_title, start_date, contract_type,
                           line_manager_user_id, line_manager_name, created_by, updated_by)
        VALUES (app_org_id(), ${code}, ${userId}::uuid, ${str(p.name) ?? code},
                ${state}::staff_lifecycle, ${loc[0].id}::uuid, ${str(p.job)},
                ${isDay(p.start) ? p.start : null}::date, ${CONTRACT_TYPE[String(p.contract)] ?? null},
                ${lmId}::uuid, ${lmId ? null : str(p.lm)}, ${me}::uuid, ${me}::uuid)
        RETURNING id`;
      const sid = s!.id;
      const ev = async (from: string | null, to: string, reason: string, by: unknown, at: Date) =>
        tx.$executeRaw`
          INSERT INTO staff_lifecycle_event (organisation_id, staff_id, from_state, to_state, reason,
                                             actor_user_id, at)
          VALUES (app_org_id(), ${sid}::uuid, ${from}::staff_lifecycle, ${to}::staff_lifecycle,
                  ${reason.slice(0, 500)}, ${P.userIdOf(str(by)) ?? me}::uuid, ${at})`;
      const stageAt = isDay(p.stageOn) ? fromStamp(p.stageOn)! : now;
      await ev(null, state, 'Moved in from the v36 copy', null, stageAt);
      const sub = rec(p.submitted);
      if (fromStamp(sub.on))
        await ev('CHECKS_IN_PROGRESS', 'READY_FOR_REVIEW', str(sub.note) ?? 'Submitted for approval', sub.by, fromStamp(sub.on)!);
      const ret = rec(p.returned);
      if (fromStamp(ret.on))
        await ev('READY_FOR_REVIEW', 'CHECKS_IN_PROGRESS', str(ret.why) ?? 'Returned', ret.by, fromStamp(ret.on)!);
      const sus = rec(p.susp);
      if (fromStamp(sus.on))
        await ev('ACTIVE', 'SUSPENDED', str(sus.why) ?? 'Suspended', sus.by, fromStamp(sus.on)!);
      if (isDay(p.stageOn))
        await ev(null, state, 'Entered this stage', null, stageAt);
      const ap = rec(p.approved);
      const role = JOB_ROLE[String(ap.role ?? p.job)];
      if (fromStamp(ap.on) && role)
        await tx.$executeRaw`
          INSERT INTO staff_role_approval (organisation_id, staff_id, role, reason, approved_by, valid_from)
          VALUES (app_org_id(), ${sid}::uuid, ${role}::staff_role,
                  ${(str(ap.note) ?? 'Approved for role').slice(0, 500)},
                  ${P.userIdOf(str(ap.by)) ?? me}::uuid, ${fromStamp(ap.on)})`;
      for (const r of arr(p.restr)) {
        const t = str(r.t) ?? 'Restriction';
        const from = fromStamp(r.on) ?? now;
        const to = isDay(r.until) ? endOfDay(r.until) : null;
        const ended = r.ended ? (fromStamp(rec(r.ended).on ?? r.ended) ?? now) : null;
        const reason = r.abs ? `Sickness absence ${String(r.abs)}` : (str(r.reason) ?? t);
        await tx.$executeRaw`
          INSERT INTO staff_restriction (organisation_id, staff_id, code, type, detail, reason,
                                         applied_by, valid_from, valid_to, lifted_at, lifted_by, lift_reason)
          VALUES (app_org_id(), ${sid}::uuid, ${str(r.id)}, ${RESTRICTION_TYPE[t] ?? 'OTHER'}::staff_restriction_type,
                  ${t.slice(0, 200)}, ${reason.slice(0, 500)}, ${P.userIdOf(str(r.by)) ?? me}::uuid,
                  ${from}, ${to && to > from ? to : null}, ${ended},
                  ${ended ? (P.userIdOf(str(rec(r.ended).by)) ?? me) : null}::uuid,
                  ${ended ? 'Restriction ended' : null})`;
      }
      for (const [c, raw] of Object.entries(rec(p.items))) {
        const t = tplOf.get(CHECK_TEMPLATE[c] ?? '');
        if (!t) continue; // the organisation has no such check: nothing to attach it to
        await importItem(tx, P, me, { sid, code: c, name: str(p.name) ?? code, loc: loc[0].id, t, it: rec(raw), now });
      }
      n++;
    }
    await auditSql(ctx, tx, 'staff.workspace_import', 'staff', ctx.orgId, { collection: 'people', records: n });
    return n;
  });
}

async function importItem(
  tx: TenantTx,
  P: People,
  me: string,
  x: {
    sid: string;
    code: string;
    name: string;
    loc: string;
    t: { template_id: string; version_id: string };
    it: V36Record;
    now: Date;
  },
) {
  const it = x.it;
  const s = String(it.s ?? 'none');
  const [inst] = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO requirement_instance (organisation_id, location_id, template_id, template_version_id,
                                      subject_type, subject_id, applicability, status, reason_code,
                                      reason_text, currently_verified, review_date, created_by)
    VALUES (app_org_id(), ${x.loc}::uuid, ${x.t.template_id}::uuid, ${x.t.version_id}::uuid, 'STAFF',
            ${x.sid}::uuid, ${s === 'na' ? 'APPROVED_NOT_APPLICABLE' : 'APPLICABLE'}::applicability,
            'GREY', 'MISSING', 'No verified evidence on record', false,
            ${x.code === 'DBS' && isDay(it.review) ? it.review : null}::date, ${me}::uuid)
    ON CONFLICT (organisation_id, template_id, subject_type, subject_id) DO UPDATE
      SET review_date = EXCLUDED.review_date
    RETURNING id`;
  const instId = inst!.id;
  const addDoc = async (d: V36Record, decided: 'ACCEPTED' | 'REJECTED' | null, why?: string) => {
    const byName = str(d.by) ?? '';
    const portal = /\(candidate portal\)$/.test(byName);
    const upId = P.userIdOf(portal ? byName.replace(/\s*\(candidate portal\)$/, '') : byName) ?? me;
    const supplied = !portal && byName && !P.userIdOf(byName) ? byName : null;
    const at = fromStamp(d.rcv) ?? x.now;
    const [item] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO evidence_item (organisation_id, title, type, sensitivity, created_by, created_at)
      VALUES (app_org_id(), ${`${x.code} – ${x.name}`.slice(0, 200)}, 'DOCUMENT',
              ${SENSITIVE_CHECKS.has(x.code) ? 'HR' : 'NORMAL'}, ${upId}::uuid, ${at})
      RETURNING id`;
    const exp = isDay(d.exp) ? d.exp : null;
    const [ver] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO evidence_version (organisation_id, item_id, version_no, blob_key, declared_mime,
                                    declared_size, mime, size_bytes, sha256, scan_status, uploaded_at,
                                    scanned_at, uploaded_by, captured_at, valid_from, valid_to,
                                    created_at, channel)
      VALUES (app_org_id(), ${item!.id}::uuid, 1, ${`v36-import/${item!.id}`}, 'text/plain', 1,
              'text/plain', 1, ${'0'.repeat(64)}, 'CLEAN', ${at}, ${at}, ${upId}::uuid, ${at},
              ${d10(at)}::date, ${exp}::date, ${at},
              ${portal ? 'CANDIDATE_PORTAL' : 'OFFICE'})
      RETURNING id`;
    await tx.$executeRaw`
      INSERT INTO evidence_link (organisation_id, item_id, instance_id, created_by)
      VALUES (app_org_id(), ${item!.id}::uuid, ${instId}::uuid, ${upId}::uuid)`;
    await tx.$executeRaw`
      INSERT INTO staff_check_receipt (organisation_id, staff_id, check_code, evidence_version_id,
                                       file_name, supplied_by, note, session_code, created_by, created_at)
      VALUES (app_org_id(), ${x.sid}::uuid, ${x.code}, ${ver!.id}::uuid,
              ${str(d.file)?.slice(0, 200) ?? null}, ${supplied}, ${str(d.note)}, ${str(d.sess)},
              ${me}::uuid, ${at})`;
    if (decided) {
      const vby = decided === 'ACCEPTED' ? d.vby : rec(it.rej).by;
      let rev = P.userIdOf(str(vby)) ?? me;
      if (rev === upId) rev = rev === me ? '' : me;
      if (!rev) return; // nobody else to record as the verifier: stays awaiting verification
      const on = fromStamp(decided === 'ACCEPTED' ? d.von : rec(it.rej).on) ?? at;
      await tx.$executeRaw`
        INSERT INTO verification (organisation_id, evidence_version_id, decision, reason, reviewer_id,
                                  confirmed_valid_to, created_at)
        VALUES (app_org_id(), ${ver!.id}::uuid, ${decided}::verification_decision,
                ${decided === 'ACCEPTED' ? (str(d.vnote) ?? null) : (why ?? 'Rejected')},
                ${rev}::uuid, ${decided === 'ACCEPTED' ? exp : null}::date, ${on})`;
    }
  };
  if (s === 'ok') {
    await addDoc(it, 'ACCEPTED');
    if (it.rej) {
      // A rejected newer document behind the verified one.
      await addDoc({ by: it.by, rcv: rec(it.rej).on ?? it.rcv }, 'REJECTED', str(rec(it.rej).why) ?? 'Rejected');
    }
  } else if (s === 'rcv') {
    const prev = rec(it.prev);
    if (prev.von) await addDoc({ by: it.by, rcv: prev.von, vby: prev.vby, von: prev.von, exp: prev.exp }, 'ACCEPTED');
    await addDoc(it, null);
  } else if (s === 'rej') {
    await addDoc(it, 'REJECTED', str(rec(it.rej).why) ?? 'Rejected');
  }
  if (s === 'req' || isDay(it.req) || isDay(it.due)) {
    const received = s === 'rcv' || s === 'ok' ? (fromStamp(it.rcv) ?? x.now) : null;
    await tx.$executeRaw`
      INSERT INTO staff_chase_log (organisation_id, staff_id, kind, subject, requested_on, chased_on,
                                   received_on, note, created_by, check_code, due_on, chased_dates)
      VALUES (app_org_id(), ${x.sid}::uuid,
              ${{ REF: 'REFERENCE', DBS: 'DBS', RTW: 'RIGHT_TO_WORK' }[x.code] ?? 'OTHER'},
              ${x.code}, ${isDay(it.req) ? it.req : null}::date,
              ${arr<string>(it.chase).filter(isDay).at(-1) ?? null}::date, ${d10(received)}::date,
              ${s === 'req' || s === 'rej' ? str(it.note) : null}, ${me}::uuid, ${x.code},
              ${isDay(it.due) ? it.due : null}::date, ${arr<string>(it.chase).filter(isDay)}::date[])`;
  }
  for (const cm of arr(it.com)) {
    const body = str(cm.t);
    if (!body) continue;
    const by = P.userIdOf(str(cm.by));
    await tx.$executeRaw`
      INSERT INTO staff_check_comment (organisation_id, staff_id, check_code, body, author_name,
                                       created_by, created_at)
      VALUES (app_org_id(), ${x.sid}::uuid, ${x.code}, ${body.slice(0, 2000)},
              ${by ? null : str(cm.by)}, ${by ?? me}::uuid, ${fromStamp(cm.on) ?? x.now})`;
  }
  await recomputeInstance(tx, instId, x.now);
}

export const peopleAdapter: V36Adapter = {
  key: 'people',
  shape: 'map',
  load: loadPeopleMap,
  apply: (ctx, c) => applyPeople(ctx, c),
  isEmpty: (ctx) =>
    ctx.tx(async (tx) => {
      const r = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM staff`;
      return r[0]!.n === 0;
    }),
  import: async (ctx, records) => {
    if (!ctx.hub.permissions.has('staff.profile.manage'))
      throw new HubError('FORBIDDEN', 403, 'Only HR or a manager can move people in');
    await importPeople(ctx, records as Record<string, V36Record>);
  },
};
