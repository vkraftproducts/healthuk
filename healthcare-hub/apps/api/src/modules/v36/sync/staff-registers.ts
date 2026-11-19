// v36 staff registers connected to their tables: user accounts (acct), probation & appraisals (rev),
// sickness (sick), leavers (leave), bank & agency workers (agency), DVLA/HCPC checks (lic),
// correction requests (corr), supervision (sup), planned training (tplan), support access (sg),
// the 48-hour opt-out (optOut) and the fixed rule values v36 reads (supRule, stageT).
import { addDays, londonDate } from '@hub/rules';
import { HubError } from '../../../common/problem.filter.js';
import { mfaRequiredFor } from '../../../auth/mfa.js';
import { loadPeople, stamp } from './lookup.js';
import type { V36Adapter, V36Change, V36Ctx, V36Record } from './types.js';
import {
  JOB_ROLE,
  ROLE_WORDS,
  arr,
  auditSql,
  bumpCounter,
  clean,
  d10,
  fromStamp,
  isDay,
  ld,
  rec,
  refuse,
  str,
} from './staff-lib.js';

const has = (ctx: V36Ctx, p: string) => ctx.hub.permissions.has(p);
const count = (ctx: V36Ctx, table: string) =>
  ctx.tx(async (tx) => {
    const r = await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`);
    return r[0]!.n === 0;
  });
async function staffIdOf(ctx: V36Ctx, code: unknown): Promise<string> {
  const id = await ctx.tx(async (tx) => (await loadPeople(tx)).staffIdOf(str(code)));
  if (!id) throw new HubError('NOT_FOUND', 404, `No person ${String(code)}`);
  return id;
}
async function userIdOf(ctx: V36Ctx, name: unknown, what: string): Promise<string> {
  return ctx.tx(async (tx) => (await loadPeople(tx)).needUserId(str(name), what));
}
/** The row id behind a v36 reference (code column) of a register. */
async function rowId(ctx: V36Ctx, table: string, code: string): Promise<string> {
  const r = await ctx.tx((tx) =>
    tx.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM ${table} WHERE code = $1 OR id::text = $1 LIMIT 1`,
      code,
    ),
  );
  if (!r[0]) throw new HubError('NOT_FOUND', 404, `${code} is not on record`);
  return r[0].id;
}
const ten = (date: string) => fromStamp(`${date} 10:00`)!.toISOString();

// ================================================================================================
// acct – Settings › Users and access
const ROLE_LABEL: Record<string, string> = {
  REGISTERED_MANAGER: 'Registered Manager',
  DIRECTOR: 'Director (deputy Registered Manager)',
  HR_LEAD: 'HR Lead',
  FLEET_LEAD: 'Fleet Lead',
  GOVERNANCE_LEAD: 'Governance & IPC Lead',
  DISPATCHER: 'Dispatcher',
  CREW: 'Crew – Paramedic / Driver',
  AUDITOR: 'External auditor (read-only)',
};
const acct: V36Adapter = {
  key: 'acct',
  shape: 'list',
  canRead: (ctx) => has(ctx, 'admin.users.manage'),
  load: (ctx) =>
    ctx.tx(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          user_id: string;
          name: string;
          status: string;
          role_key: string;
          role_name: string;
          loc: string | null;
          current: boolean;
          staff_no: string | null;
        }[]
      >`
        SELECT u.id AS user_id, u.display_name AS name, u.status::text, r.key AS role_key,
               r.name AS role_name, l.name AS loc,
               (m.valid_to IS NULL OR m.valid_to > now()) AS current,
               (SELECT s.staff_no FROM staff s WHERE s.user_id = u.id LIMIT 1) AS staff_no
          FROM membership m JOIN app_user u ON u.id = m.user_id JOIN role r ON r.id = m.role_id
          LEFT JOIN location l ON l.id = m.location_id
         ORDER BY m.created_at, m.id`;
      // A membership for all locations shows the organisation's location when it has only one.
      const locs = await tx.$queryRaw<{ name: string }[]>`SELECT name FROM location`;
      const allLoc = locs.length === 1 ? locs[0]!.name : 'All locations';
      const by = new Map<string, typeof rows>();
      for (const r of rows) by.set(r.user_id, [...(by.get(r.user_id) ?? []), r]);
      return [...by.values()].map((ms) => {
        const cur = ms.filter((m) => m.current);
        const m = cur[0] ?? ms.at(-1)!;
        return {
          id: m.user_id,
          n: m.name,
          role: ROLE_LABEL[m.role_key] ?? m.role_name,
          loc: m.loc ?? allLoc,
          state: m.status === 'INVITED' ? 'Invited' : cur.length ? 'Active' : 'Deactivated',
          mfa: mfaRequiredFor(cur.map((x) => x.role_key)),
          pid: m.staff_no,
        };
      });
    }),
  apply: async (ctx, c) => {
    if (ctx.act === 'lvTick') return; // the leaver record ends access (move to leaver)
    if (!c.before)
      throw refuse(
        'Invite people from Settings › Users and access in the hub: an email address is needed',
      );
    if (!c.after) throw refuse('Accounts are never deleted; turn them off instead', 403);
    const was = c.before.state;
    const now = c.after.state;
    if (was === now) throw refuse('Only turning an account off or on can be saved here');
    if (now === 'Deactivated') {
      await ctx.api('POST', `/admin/users/${c.id}/revoke`, {
        reason: 'Account turned off in Users and access',
      });
      return;
    }
    if (now === 'Active' && was === 'Deactivated') {
      // Back on with the role and location they last had.
      const last = await ctx.tx(
        (tx) =>
          tx.$queryRaw<{ role_id: string; location_id: string | null }[]>`
          SELECT role_id, location_id FROM membership WHERE user_id = ${c.id}::uuid
           ORDER BY valid_from DESC LIMIT 1`,
      );
      if (!last[0]) throw new HubError('NOT_FOUND', 404);
      await ctx.api('POST', `/admin/users/${c.id}/memberships`, {
        roleId: last[0].role_id,
        locationId: last[0].location_id,
      });
      return;
    }
    throw refuse('That change cannot be saved here');
  },
};

// ================================================================================================
// rev – Staff › Probation & appraisals
const REV_TYPE: Record<string, string> = {
  PROBATION_3M: 'Probation – 3 months',
  PROBATION_6M: 'Probation – 6 months',
  APPRAISAL: 'Annual appraisal',
  OTHER: 'Other',
};
const REV_KIND = Object.fromEntries(Object.entries(REV_TYPE).map(([k, v]) => [v, k]));
const REV_OUT: Record<string, string> = {
  PASSED: 'Passed',
  EXTENDED: 'Extended',
  NOT_PASSED: 'Concerns – not passed',
  MEETS: 'Meets expectations',
  EXCEEDS: 'Exceeds expectations',
  NEEDS_SUPPORT: 'Needs support',
  RECORDED: 'Recorded',
};
const REV_OUTCOME = Object.fromEntries(Object.entries(REV_OUT).map(([k, v]) => [v, k]));
const rev: V36Adapter = {
  key: 'rev',
  shape: 'list',
  canRead: (ctx) => has(ctx, 'staff.profile.view_basic') || has(ctx, 'staff.self.view'),
  load: (ctx) =>
    ctx.tx(async (tx) => {
      const all = has(ctx, 'staff.profile.view_basic');
      const P = await loadPeople(tx);
      const rows = await tx.$queryRaw<
        {
          code: string;
          staff_id: string;
          kind: string;
          due_on: Date;
          status: string;
          outcome: string | null;
          objectives: string | null;
          reviewed_on: Date | null;
          reviewer_user_id: string | null;
        }[]
      >`
        SELECT r.code, r.staff_id, r.kind, r.due_on, r.status, r.outcome, r.objectives,
               r.reviewed_on, r.reviewer_user_id
          FROM staff_review r JOIN staff s ON s.id = r.staff_id
         WHERE r.status <> 'CANCELLED' AND (${all} OR s.user_id = ${ctx.userId}::uuid)
         ORDER BY r.created_at, r.code`;
      return rows.map((r) =>
        clean({
          id: r.code,
          pid: P.staffCodeOf(r.staff_id),
          type: REV_TYPE[r.kind] ?? r.kind,
          due: d10(r.due_on),
          state: r.status === 'DONE' ? 'Done' : 'Due',
          on: d10(r.reviewed_on) ?? undefined,
          by: P.nameOf(r.reviewer_user_id) ?? undefined,
          obj: r.kind === 'APPRAISAL' ? (r.objectives ?? undefined) : undefined,
          // RECORDED: done in v36 without an outcome (only 'Other' reviews show it as 'Recorded')
          out: r.outcome && (r.outcome !== 'RECORDED' || r.kind === 'OTHER') ? (REV_OUT[r.outcome] ?? r.outcome) : undefined,
        }),
      );
    }),
  apply: async (ctx, c) => {
    const a = c.after;
    if (!a) throw refuse('Reviews are cancelled, not deleted', 403);
    if (!c.before) {
      if (ctx.act === 'revRec') return; // the next review is scheduled by the recording itself
      const kind = REV_KIND[String(a.type)];
      if (!kind || !isDay(a.due)) throw refuse('Choose the type and due date');
      await ctx.api('POST', '/staff-reviews', {
        staffId: await staffIdOf(ctx, a.pid),
        kind,
        dueOn: a.due,
      });
      return;
    }
    if (a.state === 'Done' && c.before.state !== 'Done') {
      const id = await rowId(ctx, 'staff_review', c.id);
      const outcome = REV_OUTCOME[String(a.out)];
      if (!outcome) throw refuse('Choose an outcome');
      const appraisal = REV_KIND[String(a.type)] === 'APPRAISAL';
      await ctx.api('POST', `/staff-reviews/${id}/record`, {
        outcome,
        reviewedOn: isDay(a.on) ? a.on : ctx.today,
        reviewerUserId: await userIdOf(ctx, a.by, 'The reviewer'),
        ...(appraisal && str(a.obj) ? { objectives: str(a.obj) } : {}),
      });
      return;
    }
    throw refuse('That change to a review cannot be saved here');
  },
  isEmpty: (ctx) => count(ctx, 'staff_review'),
  import: (ctx, records) =>
    ctx.tx(async (tx) => {
      const P = await loadPeople(tx);
      const list = arr(records);
      let n = 0;
      for (const r of list) {
        const sid = P.staffIdOf(str(r.pid));
        const kind = REV_KIND[String(r.type)] ?? 'OTHER';
        if (!sid || !isDay(r.due) || !str(r.id)) continue;
        const done = r.state === 'Done';
        await tx.$executeRaw`
          INSERT INTO staff_review (organisation_id, code, staff_id, kind, due_on, status, outcome,
                                    objectives, reviewed_on, reviewer_user_id, recorded_by, created_by, created_at)
          VALUES (app_org_id(), ${str(r.id)}, ${sid}::uuid, ${kind}, ${r.due}::date,
                  ${done ? 'DONE' : 'SCHEDULED'}, ${done ? (REV_OUTCOME[String(r.out)] ?? 'RECORDED') : null},
                  ${str(r.obj)}, ${done && isDay(r.on) ? r.on : null}::date,
                  ${done ? (P.userIdOf(str(r.by)) ?? ctx.userId) : null}::uuid,
                  ${done ? ctx.userId : null}::uuid, ${ctx.userId}::uuid, clock_timestamp())`;
        n++;
      }
      for (const p of ['REV', 'APR'])
        await bumpCounter(tx, ctx.orgId, p, list.map((r) => String(r.id)));
      await auditSql(ctx, tx, 'staff.workspace_import', 'staff_review', ctx.orgId, { collection: 'rev', records: n });
    }),
};

// ================================================================================================
// sick – Staff › Sickness & return to work
const ABS_CAT: Record<string, string> = {
  MUSCULOSKELETAL: 'Musculoskeletal',
  RESPIRATORY: 'Respiratory',
  GASTROINTESTINAL: 'Gastrointestinal',
  MENTAL_HEALTH: 'Mental health',
  INJURY_AT_WORK: 'Injury at work',
  INFECTION: 'Infection',
  OTHER: 'Other',
};
const ABS_CATEGORY = Object.fromEntries(Object.entries(ABS_CAT).map(([k, v]) => [v, k]));
const sick: V36Adapter = {
  key: 'sick',
  shape: 'list',
  canRead: (ctx) => has(ctx, 'staff.sensitive.view') || has(ctx, 'staff.self.view'),
  load: (ctx) =>
    ctx.tx(async (tx) => {
      const all = has(ctx, 'staff.sensitive.view');
      const P = await loadPeople(tx);
      const rows = await tx.$queryRaw<
        {
          code: string;
          staff_id: string;
          first_day: Date;
          last_day: Date | null;
          category: string;
          rtw_on: Date | null;
          rtw_by_user_id: string | null;
          rtw_note: string | null;
          phased: boolean;
          phased_terms: string | null;
        }[]
      >`
        SELECT a.code, a.staff_id, a.first_day, a.last_day, a.category, a.rtw_on, a.rtw_by_user_id,
               a.rtw_note, a.phased, a.phased_terms
          FROM staff_absence a JOIN staff s ON s.id = a.staff_id
         WHERE ${all} OR s.user_id = ${ctx.userId}::uuid
         ORDER BY a.first_day DESC, a.code`;
      return rows.map((r) => ({
        id: r.code,
        pid: P.staffCodeOf(r.staff_id),
        from: d10(r.first_day),
        to: d10(r.last_day),
        cat: ABS_CAT[r.category] ?? r.category,
        rtw: r.rtw_on
          ? clean({
              on: d10(r.rtw_on),
              by: P.nameOf(r.rtw_by_user_id) ?? '',
              phased: r.phased || undefined,
              note: r.phased ? (r.phased_terms ?? '') : (r.rtw_note ?? undefined),
            })
          : null,
      }));
    }),
  apply: async (ctx, c) => {
    const a = c.after;
    if (!a) throw refuse('Absence records are never deleted', 403);
    if (!c.before) {
      // absNew
      const category = ABS_CATEGORY[String(a.cat)] ?? 'OTHER';
      await ctx.api('POST', '/staff-absences', {
        staffId: await staffIdOf(ctx, a.pid),
        firstDay: a.from,
        ...(isDay(a.to) ? { lastDay: a.to } : {}),
        category,
      });
      return;
    }
    const rtw = rec(a.rtw);
    if (a.rtw && !c.before.rtw) {
      // absRtw: v36 asks "Back on" for an open absence; the last day off is the day before the
      // interview at the latest.
      const id = await rowId(ctx, 'staff_absence', c.id);
      const rtwOn = isDay(rtw.on) ? rtw.on : ctx.today;
      let lastDay: string | undefined;
      if (!c.before.to) {
        const to = isDay(a.to) ? a.to : rtwOn;
        lastDay = to >= rtwOn ? addDays(rtwOn, -1) : to;
        if (lastDay < String(a.from))
          throw refuse('The person was off from today: record the interview from tomorrow');
      }
      const phased = !!rtw.phased;
      const note = str(rtw.note);
      await ctx.api('POST', `/staff-absences/${id}/return`, {
        ...(lastDay ? { lastDay } : {}),
        rtwOn,
        rtwByUserId: await userIdOf(ctx, rtw.by, 'The interviewer'),
        phased,
        ...(phased
          ? { phasedTerms: note ?? 'Phased return', phasedUntil: addDays(rtwOn, 14) }
          : note && note.length >= 3
            ? { note }
            : {}),
      });
      return;
    }
    throw refuse('That change to an absence cannot be saved here');
  },
  isEmpty: (ctx) => count(ctx, 'staff_absence'),
  import: (ctx, records) =>
    ctx.tx(async (tx) => {
      const P = await loadPeople(tx);
      const list = arr(records);
      let n = 0;
      for (const r of list) {
        const sid = P.staffIdOf(str(r.pid));
        if (!sid || !isDay(r.from) || !str(r.id)) continue;
        const rtw = r.rtw ? rec(r.rtw) : null;
        const code = str(r.id)!;
        const off = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM staff_restriction WHERE staff_id = ${sid}::uuid
             AND reason = ${`Sickness absence ${code}`} LIMIT 1`;
        await tx.$executeRaw`
          INSERT INTO staff_absence (organisation_id, code, staff_id, first_day, last_day, category,
                                     off_restriction_id, rtw_on, rtw_by_user_id, rtw_recorded_by,
                                     rtw_note, phased, phased_terms, phased_until, recorded_by)
          VALUES (app_org_id(), ${code}, ${sid}::uuid, ${r.from}::date,
                  ${isDay(r.to) ? r.to : null}::date, ${ABS_CATEGORY[String(r.cat)] ?? 'OTHER'},
                  ${off[0]?.id ?? null}::uuid, ${rtw && isDay(rtw.on) ? rtw.on : null}::date,
                  ${rtw ? (P.userIdOf(str(rtw.by)) ?? ctx.userId) : null}::uuid,
                  ${rtw ? ctx.userId : null}::uuid, ${rtw && !rtw.phased ? str(rtw.note) : null},
                  ${!!rtw?.phased}, ${rtw?.phased ? (str(rtw.note) ?? 'Phased return') : null},
                  ${rtw?.phased && isDay(rtw.on) ? addDays(rtw.on, 14) : null}::date,
                  ${ctx.userId}::uuid)`;
        n++;
      }
      await bumpCounter(tx, ctx.orgId, 'ABS', list.map((r) => String(r.id)));
      await auditSql(ctx, tx, 'staff.workspace_import', 'staff_absence', ctx.orgId, { collection: 'sick', records: n });
    }),
};

// ================================================================================================
// leave – Staff › Leavers
const LEAVER_REASON = (why: string) =>
  /^resign/i.test(why)
    ? 'RESIGNED'
    : /^retir/i.test(why)
      ? 'RETIRED'
      : /end of contract/i.test(why)
        ? 'END_OF_CONTRACT'
        : /redundan/i.test(why)
          ? 'REDUNDANCY'
          : /dismiss/i.test(why)
            ? 'DISMISSED'
            : 'OTHER';
const LEAVER_WORDS: Record<string, string> = {
  RESIGNED: 'Resigned',
  RETIRED: 'Retired',
  END_OF_CONTRACT: 'End of contract',
  DISMISSED: 'Dismissed',
  REDUNDANCY: 'Redundancy',
  OTHER: 'Other',
};
const leave: V36Adapter = {
  key: 'leave',
  shape: 'list',
  canRead: (ctx) => has(ctx, 'staff.profile.view_basic'),
  load: (ctx) =>
    ctx.tx(async (tx) => {
      const P = await loadPeople(tx);
      const rows = await tx.$queryRaw<
        {
          code: string;
          staff_id: string;
          last_day: Date;
          reason: string;
          reason_note: string | null;
          started_by: string;
          created_at: Date;
          lifecycle: string;
          badge: boolean;
          kit: boolean;
          pay: boolean;
          exit: boolean;
          completed_at: Date | null;
          keep_until: Date | null;
        }[]
      >`
        SELECT l.code, l.staff_id, l.last_day, l.reason, l.reason_note, l.started_by, l.created_at,
               s.lifecycle_state::text AS lifecycle, l.badge_returned_at IS NOT NULL AS badge,
               l.kit_returned_at IS NOT NULL AS kit, l.payroll_told_at IS NOT NULL AS pay,
               l.exit_interview IS NOT NULL AS exit, l.completed_at, l.keep_until
          FROM leaver_record l JOIN staff s ON s.id = l.staff_id
         WHERE l.status <> 'CANCELLED' ORDER BY l.created_at, l.code`;
      return rows.map((r) =>
        clean({
          id: r.code,
          pid: P.staffCodeOf(r.staff_id),
          last: d10(r.last_day),
          why: r.reason_note ?? LEAVER_WORDS[r.reason] ?? r.reason,
          by: P.nameOf(r.started_by) ?? '',
          on: ld(r.created_at),
          ck: { acc: r.lifecycle === 'LEAVER', badge: r.badge, kit: r.kit, pay: r.pay, exit: r.exit },
          done: ld(r.completed_at) ?? undefined,
          keep: d10(r.keep_until) ?? undefined,
        }),
      );
    }),
  apply: async (ctx, c) => {
    const a = c.after;
    if (!a) throw refuse('Leaver records are never deleted', 403);
    if (!c.before) {
      const why = str(a.why) ?? 'Other';
      await ctx.api('POST', '/leavers', {
        staffId: await staffIdOf(ctx, a.pid),
        lastDay: a.last,
        reason: LEAVER_REASON(why),
        ...(why.length >= 3 ? { reasonNote: why.slice(0, 500) } : {}),
      });
      return;
    }
    const id = await rowId(ctx, 'leaver_record', c.id);
    const b = rec(c.before.ck);
    const n = rec(a.ck);
    if (n.acc && !b.acc) {
      const sid = await staffIdOf(ctx, a.pid);
      await ctx.api('POST', `/staff/${sid}/transition`, {
        to: 'LEAVER',
        reason: `Leaver ${c.id}`,
        lastWorkingDay: a.last,
      });
    }
    const items: [string, string][] = [
      ['badge', 'BADGE'],
      ['kit', 'KIT'],
      ['pay', 'PAYROLL'],
      ['exit', 'EXIT_INTERVIEW'],
    ];
    for (const [k, item] of items)
      if (n[k] && !b[k])
        await ctx.api('POST', `/leavers/${id}/tick`, {
          item,
          ...(item === 'EXIT_INTERVIEW' ? { exitInterview: 'DONE' } : {}),
        });
    for (const [k] of [['acc'], ...items])
      if (b[k!] && !n[k!]) throw refuse('A finished checklist item cannot be undone');
    if (a.done && !c.before.done) await ctx.api('POST', `/leavers/${id}/complete`);
  },
  isEmpty: (ctx) => count(ctx, 'leaver_record'),
  import: (ctx, records) =>
    ctx.tx(async (tx) => {
      const P = await loadPeople(tx);
      const list = arr(records);
      let n = 0;
      for (const r of list) {
        const sid = P.staffIdOf(str(r.pid));
        if (!sid || !isDay(r.last) || !str(r.id)) continue;
        const ck = rec(r.ck);
        const by = P.userIdOf(str(r.by)) ?? ctx.userId;
        const at = fromStamp(r.on) ?? new Date();
        const done = isDay(r.done) ? fromStamp(r.done) : null;
        const why = str(r.why) ?? 'Other';
        await tx.$executeRaw`
          INSERT INTO leaver_record (organisation_id, code, staff_id, last_day, reason, reason_note,
                                     status, badge_returned_at, badge_returned_by, kit_returned_at,
                                     kit_returned_by, payroll_told_at, payroll_told_by, exit_interview,
                                     exit_interview_at, exit_interview_by, keep_until, completed_at,
                                     completed_by, started_by, created_at)
          VALUES (app_org_id(), ${str(r.id)}, ${sid}::uuid, ${r.last}::date, ${LEAVER_REASON(why)},
                  ${why.length >= 3 ? why : null}, ${done ? 'COMPLETED' : 'OPEN'},
                  ${ck.badge ? at : null}, ${ck.badge ? by : null}::uuid,
                  ${ck.kit ? at : null}, ${ck.kit ? by : null}::uuid,
                  ${ck.pay ? at : null}, ${ck.pay ? by : null}::uuid,
                  ${ck.exit ? 'DONE' : null}, ${ck.exit ? at : null}, ${ck.exit ? by : null}::uuid,
                  ${isDay(r.keep) ? r.keep : null}::date, ${done},
                  ${done ? ctx.userId : null}::uuid, ${by}::uuid, ${at})`;
        n++;
      }
      await bumpCounter(tx, ctx.orgId, 'LV', list.map((r) => String(r.id)));
      await auditSql(ctx, tx, 'staff.workspace_import', 'leaver_record', ctx.orgId, { collection: 'leave', records: n });
    }),
};

// ================================================================================================
// agency – Staff › Bank & agency
const agency: V36Adapter = {
  key: 'agency',
  shape: 'list',
  canRead: (ctx) => has(ctx, 'staff.profile.view_basic'),
  load: (ctx) =>
    ctx.tx(async (tx) => {
      const P = await loadPeople(tx);
      const rows = await tx.$queryRaw<
        {
          code: string;
          name: string;
          agency: string;
          role: string;
          confirmation_items: string;
          confirmation_received_on: Date;
          confirmation_recorded_by: string;
          confirmation_verified_by: string | null;
          confirmation_expires_on: Date;
          local_induction_done: boolean;
          id_checked_on_arrival: boolean;
        }[]
      >`SELECT code, name, agency, role::text, confirmation_items, confirmation_received_on,
               confirmation_recorded_by, confirmation_verified_by, confirmation_expires_on,
               local_induction_done, id_checked_on_arrival
          FROM agency_worker ORDER BY code`;
      return rows.map((r) => {
        const exp = d10(r.confirmation_expires_on)!;
        const vby = P.nameOf(r.confirmation_verified_by);
        const ok = !!vby && exp >= ctx.today && r.local_induction_done && r.id_checked_on_arrival;
        return {
          id: r.code,
          name: r.name,
          agency: r.agency,
          job: ROLE_WORDS[r.role] ?? r.role,
          conf: clean({
            on: d10(r.confirmation_received_on),
            by: P.nameOf(r.confirmation_recorded_by) ?? '',
            vby: vby ?? undefined,
            exp,
            items: r.confirmation_items,
          }),
          ind: r.local_induction_done,
          idOnArrival: r.id_checked_on_arrival,
          state: ok ? 'Cleared' : vby ? 'Not cleared' : 'Agency confirmation awaiting verification',
        };
      });
    }),
  apply: async (ctx, c) => {
    const a = c.after;
    if (!a) throw refuse('Agency workers are never deleted', 403);
    const conf = rec(a.conf);
    if (!c.before) {
      await ctx.api('POST', '/agency-workers', {
        name: str(a.name),
        agency: str(a.agency),
        role: JOB_ROLE[String(a.job)] ?? 'OTHER',
        confirmationItems: str(conf.items) ?? 'Not stated',
        confirmationReceivedOn: isDay(conf.on) ? conf.on : ctx.today,
        confirmationExpiresOn: conf.exp,
      });
      return;
    }
    const id = await rowId(ctx, 'agency_worker', c.id);
    if (conf.vby && !rec(c.before.conf).vby) await ctx.api('POST', `/agency-workers/${id}/verify`);
    if (a.ind !== c.before.ind || a.idOnArrival !== c.before.idOnArrival)
      await ctx.api('POST', `/agency-workers/${id}/arrival`, {
        localInductionDone: !!a.ind,
        idCheckedOnArrival: !!a.idOnArrival,
      });
  },
  isEmpty: (ctx) => count(ctx, 'agency_worker'),
  import: (ctx, records) =>
    ctx.tx(async (tx) => {
      const P = await loadPeople(tx);
      const list = arr(records);
      for (const r of list) {
        const conf = rec(r.conf);
        if (!str(r.id) || !isDay(conf.exp)) continue;
        const by = P.userIdOf(str(conf.by)) ?? ctx.userId;
        let vby = P.userIdOf(str(conf.vby));
        if (conf.vby && !vby) vby = ctx.userId === by ? null : ctx.userId;
        await tx.$executeRaw`
          INSERT INTO agency_worker (organisation_id, code, name, agency, role, confirmation_items,
                                     confirmation_received_on, confirmation_recorded_by,
                                     confirmation_verified_by, confirmation_verified_at,
                                     confirmation_expires_on, local_induction_done, id_checked_on_arrival)
          VALUES (app_org_id(), ${str(r.id)}, ${str(r.name) ?? 'Unknown'}, ${str(r.agency) ?? 'Unknown'},
                  ${JOB_ROLE[String(r.job)] ?? 'OTHER'}::staff_role, ${str(conf.items) ?? 'Not stated'},
                  ${isDay(conf.on) ? conf.on : ctx.today}::date, ${by}::uuid, ${vby}::uuid,
                  ${vby ? (fromStamp(conf.on) ?? new Date()) : null}, ${conf.exp}::date, ${!!r.ind},
                  ${!!r.idOnArrival})`;
      }
      await bumpCounter(tx, ctx.orgId, 'AG', list.map((r) => String(r.id)));
      await auditSql(ctx, tx, 'staff.workspace_import', 'agency_worker', ctx.orgId, { collection: 'agency', records: list.length });
    }),
};

// ================================================================================================
// lic – Staff › Licence checks (DVLA) and HCPC
const lic: V36Adapter = {
  key: 'lic',
  shape: 'map',
  canRead: (ctx) => has(ctx, 'staff.profile.view_basic'),
  load: (ctx) =>
    ctx.tx(async (tx) => {
      const P = await loadPeople(tx);
      const dv = await tx.$queryRaw<
        { staff_id: string; check_code: string; categories: string; points: number; checked_on: Date; next_check_on: Date }[]
      >`SELECT DISTINCT ON (staff_id) staff_id, check_code, categories, points, checked_on, next_check_on
          FROM dvla_check ORDER BY staff_id, checked_on DESC, created_at DESC`;
      const hc = await tx.$queryRaw<
        { staff_id: string; registration_no: string; checked_on: Date; expires_on: Date }[]
      >`SELECT DISTINCT ON (staff_id) staff_id, registration_no, checked_on, expires_on
          FROM hcpc_registration ORDER BY staff_id, checked_on DESC, created_at DESC`;
      const out: Record<string, V36Record> = {};
      for (const d of dv) {
        const code = P.staffCodeOf(d.staff_id);
        if (!code) continue;
        out[code] = {
          dvla: {
            code: d.check_code,
            on: d10(d.checked_on),
            points: d.points,
            cats: d.categories,
            next: d10(d.next_check_on),
          },
        };
      }
      for (const h of hc) {
        const code = P.staffCodeOf(h.staff_id);
        if (!code) continue;
        out[code] = {
          ...(out[code] ?? {}),
          hcpc: { no: h.registration_no, on: d10(h.checked_on), exp: d10(h.expires_on) },
        };
      }
      return out;
    }),
  apply: async (ctx, c) => {
    const a = c.after;
    if (!a) throw refuse('Licence checks are never deleted', 403);
    const sid = await staffIdOf(ctx, c.id);
    const dv = rec(a.dvla);
    if (a.dvla && JSON.stringify(dv) !== JSON.stringify(rec(c.before?.dvla))) {
      const code = str(dv.code);
      if (!code || code.length < 4) throw refuse('Give the check code from the driver');
      await ctx.api('POST', '/dvla-checks', {
        staffId: sid,
        checkCode: code,
        categories: str(dv.cats) ?? 'B',
        points: Math.max(0, Math.round(Number(dv.points) || 0)),
        checkedOn: isDay(dv.on) ? dv.on : ctx.today,
        nextCheckOn: dv.next,
      });
    }
    const hc = rec(a.hcpc);
    if (a.hcpc && JSON.stringify(hc) !== JSON.stringify(rec(c.before?.hcpc)))
      await ctx.api('POST', '/hcpc-registrations', {
        staffId: sid,
        registrationNo: str(hc.no),
        checkedOn: isDay(hc.on) ? hc.on : ctx.today,
        expiresOn: hc.exp,
      });
  },
  isEmpty: async (ctx) => (await count(ctx, 'dvla_check')) && (await count(ctx, 'hcpc_registration')),
  import: (ctx, records) =>
    ctx.tx(async (tx) => {
      const P = await loadPeople(tx);
      let n = 0;
      for (const [code, raw] of Object.entries(rec(records))) {
        const sid = P.staffIdOf(code);
        if (!sid) continue;
        const dv = rec(rec(raw).dvla);
        if (str(dv.code) && isDay(dv.on) && isDay(dv.next))
          await tx.$executeRaw`
            INSERT INTO dvla_check (organisation_id, staff_id, check_code, categories, points,
                                    checked_on, next_check_on, recorded_by)
            VALUES (app_org_id(), ${sid}::uuid, ${str(dv.code)}, ${str(dv.cats) ?? 'B'},
                    ${Math.round(Number(dv.points) || 0)}, ${dv.on}::date, ${dv.next}::date, ${ctx.userId}::uuid)`;
        const hc = rec(rec(raw).hcpc);
        if (str(hc.no) && isDay(hc.on) && isDay(hc.exp))
          await tx.$executeRaw`
            INSERT INTO hcpc_registration (organisation_id, staff_id, registration_no, checked_on,
                                           expires_on, recorded_by)
            VALUES (app_org_id(), ${sid}::uuid, ${str(hc.no)}, ${hc.on}::date, ${hc.exp}::date,
                    ${ctx.userId}::uuid)`;
        n++;
      }
      await auditSql(ctx, tx, 'staff.workspace_import', 'dvla_check', ctx.orgId, { collection: 'lic', records: n });
    }),
};

// ================================================================================================
// corr – correction requests (crew "My record", HR queue)
const CORR_WHAT: Record<string, string> = {
  displayName: 'Name',
  phone: 'Phone number',
  address: 'Address',
  nextOfKin: 'Next of kin',
  workingPattern: 'Working pattern',
  other: 'Something else',
};
const CORR_FIELD = Object.fromEntries(Object.entries(CORR_WHAT).map(([k, v]) => [v, k]));
const CORR_STATE: Record<string, string> = {
  OPEN: 'Waiting for HR',
  APPLIED: 'Accepted',
  REJECTED: 'Declined',
};
const corr: V36Adapter = {
  key: 'corr',
  shape: 'list',
  canRead: (ctx) => has(ctx, 'staff.profile.manage') || has(ctx, 'staff.self.view'),
  load: (ctx) =>
    ctx.tx(async (tx) => {
      const all = has(ctx, 'staff.profile.manage');
      const P = await loadPeople(tx);
      const rows = await tx.$queryRaw<
        {
          id: string;
          code: string | null;
          staff_id: string;
          field: string;
          proposed_value: string;
          reason: string;
          status: string;
          created_at: Date;
          decided_by: string | null;
          decision_note: string | null;
        }[]
      >`
        SELECT c.id, c.code, c.staff_id, c.field, c.proposed_value, c.reason, c.status::text,
               c.created_at, c.decided_by, c.decision_note
          FROM staff_correction_request c JOIN staff s ON s.id = c.staff_id
         WHERE ${all} OR s.user_id = ${ctx.userId}::uuid
         ORDER BY c.created_at, c.code`;
      return rows.map((r) =>
        clean({
          id: r.code ?? r.id,
          who: P.staffCodeOf(r.staff_id),
          what: CORR_WHAT[r.field] ?? r.field,
          should: r.proposed_value,
          why: r.reason,
          state: CORR_STATE[r.status] ?? r.status,
          on: stamp(r.created_at),
          by: P.nameOf(r.decided_by) ?? undefined,
          note: r.decision_note ?? undefined,
        }),
      );
    }),
  apply: async (ctx, c) => {
    const a = c.after;
    if (!a) throw refuse('Correction requests are never deleted', 403);
    if (!c.before) {
      const why = str(a.why) ?? '';
      if (why.length < 3) throw refuse('Say why (at least 3 characters)');
      await ctx.api('POST', '/staff/me/corrections', {
        field: CORR_FIELD[String(a.what)] ?? 'other',
        proposedValue: str(a.should),
        reason: why,
      });
      return;
    }
    const id = await rowId(ctx, 'staff_correction_request', c.id);
    if (a.state === 'Accepted' && c.before.state !== 'Accepted')
      return void (await ctx.api('POST', `/staff/corrections/${id}/decide`, { decision: 'APPLIED' }));
    if (a.state === 'Declined' && c.before.state !== 'Declined')
      return void (await ctx.api('POST', `/staff/corrections/${id}/decide`, {
        decision: 'REJECTED',
        ...(str(a.note) ? { note: str(a.note)!.slice(0, 500) } : {}),
      }));
    throw refuse('That change to a correction request cannot be saved here');
  },
  isEmpty: (ctx) => count(ctx, 'staff_correction_request'),
  import: (ctx, records) =>
    ctx.tx(async (tx) => {
      const P = await loadPeople(tx);
      const list = arr(records);
      let n = 0;
      for (const r of list) {
        const sid = P.staffIdOf(str(r.who));
        if (!sid || !str(r.should) || !str(r.why)) continue;
        const user = (await tx.$queryRaw<{ user_id: string | null }[]>`
          SELECT user_id FROM staff WHERE id = ${sid}::uuid`)[0]?.user_id;
        const status =
          r.state === 'Accepted' ? 'APPLIED' : r.state === 'Declined' ? 'REJECTED' : 'OPEN';
        const by = status === 'OPEN' ? null : (P.userIdOf(str(r.by)) ?? ctx.userId);
        await tx.$executeRaw`
          INSERT INTO staff_correction_request (organisation_id, code, staff_id, field, proposed_value,
                                                reason, status, requested_by, decided_by, decided_at,
                                                decision_note, created_at)
          VALUES (app_org_id(), ${str(r.id)}, ${sid}::uuid, ${CORR_FIELD[String(r.what)] ?? 'other'},
                  ${str(r.should)}, ${str(r.why)}, ${status}::correction_status,
                  ${user ?? ctx.userId}::uuid, ${by}::uuid, ${by ? new Date() : null},
                  ${str(r.note)}, ${fromStamp(r.on) ?? new Date()})`;
        n++;
      }
      await bumpCounter(tx, ctx.orgId, 'COR', list.map((r) => String(r.id)));
      await auditSql(ctx, tx, 'staff.workspace_import', 'staff_correction_request', ctx.orgId, { collection: 'corr', records: n });
    }),
};

// ================================================================================================
// sup – Staff › Supervision
const SUP_TYPE: Record<string, string> = {
  ONE_TO_ONE: 'One to one',
  CLINICAL: 'Clinical supervision',
  RETURN_TO_WORK: 'Return to work',
  PROBATION_REVIEW: 'Probation review',
};
const SUP_KIND = Object.fromEntries(Object.entries(SUP_TYPE).map(([k, v]) => [v, k]));
const sup: V36Adapter = {
  key: 'sup',
  shape: 'list',
  load: (ctx) =>
    ctx.tx(async (tx) => {
      const all = has(ctx, 'staff.profile.manage') || has(ctx, 'staff.profile.view_basic');
      const P = await loadPeople(tx);
      const rows = await tx.$queryRaw<
        {
          id: string;
          code: string | null;
          staff_id: string;
          supervisor_user_id: string | null;
          supervisor_name: string | null;
          scheduled_at: Date;
          kind: string;
          topics: string | null;
          status: string;
          rebooked_as: string | null;
          requested_by: string | null;
          created_at: Date;
          summary: string | null;
          rec_by: string | null;
          later: boolean;
        }[]
      >`
        SELECT b.id, b.code, b.staff_id, b.supervisor_user_id, b.supervisor_name, b.scheduled_at, b.kind, b.topics,
               b.status, b.rebooked_as, b.requested_by, b.created_at,
               r.data->>'summary' AS summary, r.created_by AS rec_by,
               EXISTS (SELECT 1 FROM supervision_booking n
                        WHERE n.staff_id = b.staff_id AND n.created_at > b.created_at
                          AND n.status IN ('BOOKED', 'HELD', 'REQUESTED')) AS later
          FROM supervision_booking b JOIN staff s ON s.id = b.staff_id
          LEFT JOIN staff_record r ON r.id = b.record_id
         WHERE ${all} OR s.user_id = ${ctx.userId}::uuid OR b.supervisor_user_id = ${ctx.userId}::uuid
         ORDER BY b.created_at, b.code`;
      return rows.map((r) => {
        const state =
          r.status === 'REQUESTED'
            ? 'Requested'
            : r.status === 'BOOKED'
              ? 'Booked'
              : r.status === 'HELD'
                ? 'Held'
                : r.status === 'MISSED'
                  ? r.rebooked_as || r.later
                    ? 'Missed – rebooked'
                    : 'Missed'
                  : 'Cancelled';
        return clean({
          id: r.code ?? r.id,
          who: P.staffCodeOf(r.staff_id),
          sup: r.supervisor_name ?? P.nameOf(r.supervisor_user_id) ?? '',
          type: SUP_TYPE[r.kind] ?? r.kind,
          date: ld(r.scheduled_at),
          state,
          topics: r.topics ?? '',
          outcome: r.status === 'HELD' ? (r.summary ?? '') : undefined,
          rec: r.status === 'HELD' ? (P.nameOf(r.rec_by) ?? undefined) : undefined,
          reqBy: P.nameOf(r.requested_by) ?? undefined,
        });
      });
    }),
  apply: async (ctx, c) => {
    const a = c.after;
    if (!a) throw refuse('Supervision records are never deleted', 403);
    const kind = SUP_KIND[String(a.type)] ?? 'ONE_TO_ONE';
    if (!c.before) {
      if (!isDay(a.date)) throw refuse('Choose a date');
      if (a.state === 'Requested') {
        const topics = str(a.topics);
        await ctx.api('POST', '/staff/me/supervision-requests', {
          kind,
          scheduledAt: ten(a.date),
          ...(topics && topics.length >= 3 ? { topics } : {}),
        });
        return;
      }
      await ctx.api('POST', `/staff/${await staffIdOf(ctx, a.who)}/supervision-bookings`, {
        supervisorUserId: await userIdOf(ctx, a.sup, 'The supervisor'),
        scheduledAt: ten(a.date),
        kind,
        ...(str(a.topics) ? { topics: str(a.topics) } : {}),
      });
      return;
    }
    const b = c.before;
    if (a.state === 'Missed – rebooked' && b.state === 'Missed') return; // follows the new booking
    const id = await rowId(ctx, 'supervision_booking', c.id);
    if (b.state === 'Requested' && a.state === 'Booked') {
      if (!isDay(a.date)) throw refuse('Choose a date');
      await ctx.api('POST', `/supervision-bookings/${id}/confirm`, {
        supervisorUserId: await userIdOf(ctx, a.sup, 'The supervisor'),
        scheduledAt: ten(a.date),
      });
      return;
    }
    if (b.state === 'Booked' && (a.state === 'Held' || a.state === 'Missed')) {
      const version = await ctx.tx(
        async (tx) =>
          (await tx.$queryRaw<{ version: number }[]>`
            SELECT version FROM supervision_booking WHERE id = ${id}::uuid`)[0]!.version,
      );
      const body =
        a.state === 'Held'
          ? {
              status: 'HELD',
              attended: true,
              wellbeingChecked: false,
              ...(str(a.outcome) ? { summary: str(a.outcome)!.slice(0, 2000) } : {}),
            }
          : { status: 'MISSED', reason: 'Marked missed in the supervision register' };
      await ctx.api('POST', `/supervision-bookings/${id}/close`, body, version);
      return;
    }
    throw refuse('That change to a supervision cannot be saved here');
  },
  isEmpty: (ctx) => count(ctx, 'supervision_booking'),
  import: (ctx, records) =>
    ctx.tx(async (tx) => {
      const P = await loadPeople(tx);
      const list = arr(records);
      let n = 0;
      for (const r of list) {
        const sid = P.staffIdOf(str(r.who));
        if (!sid || !isDay(r.date) || !str(r.id)) continue;
        const st = String(r.state);
        const status = st === 'Requested' ? 'REQUESTED' : st === 'Booked' ? 'BOOKED' : st === 'Held' ? 'HELD' : st.startsWith('Missed') ? 'MISSED' : 'CANCELLED';
        const supMember = P.userIdOf(str(r.sup));
        // A supervisor who is not a member here: the importer stands in, the name is kept as text.
        const supId = supMember ?? (status !== 'REQUESTED' && str(r.sup) ? ctx.userId : null);
        const supName = supMember ? null : (str(r.sup)?.slice(0, 120) ?? null);
        if (status !== 'REQUESTED' && !supId) continue; // nobody to book it with
        let recordId: string | null = null;
        if (status === 'HELD') {
          const [x] = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO staff_record (organisation_id, staff_id, kind, data, created_by)
            VALUES (app_org_id(), ${sid}::uuid, 'SUPERVISION',
                    ${JSON.stringify({ heldOn: r.date, supervisorUserId: supId, type: SUP_KIND[String(r.type)] ?? 'ONE_TO_ONE', attended: true, wellbeingChecked: false, ...(str(r.outcome) ? { summary: str(r.outcome) } : {}) })}::jsonb,
                    ${P.userIdOf(str(r.rec)) ?? ctx.userId}::uuid)
            RETURNING id`;
          recordId = x!.id;
        }
        // A request needs a requester: the named one when a member, else the person importing.
        const reqBy =
          st === 'Requested' || r.reqBy
            ? (P.userIdOf(str(r.reqBy)) ?? (status === 'REQUESTED' ? ctx.userId : null))
            : null;
        const closedBy = status === 'REQUESTED' || status === 'BOOKED' ? null : ctx.userId;
        await tx.$executeRaw`
          INSERT INTO supervision_booking (organisation_id, code, staff_id, supervisor_user_id, supervisor_name,
                                           scheduled_at, kind, topics, status, status_reason,
                                           record_id, booked_by, requested_by, closed_by)
          VALUES (app_org_id(), ${str(r.id)}, ${sid}::uuid, ${supId}::uuid, ${supName}, ${fromStamp(`${r.date} 10:00`)},
                  ${SUP_KIND[String(r.type)] ?? 'ONE_TO_ONE'}, ${str(r.topics)}, ${status},
                  ${status === 'MISSED' || status === 'CANCELLED' ? 'Recorded in v36' : null},
                  ${recordId}::uuid, ${ctx.userId}::uuid, ${reqBy}::uuid, ${closedBy}::uuid)`;
        n++;
      }
      await bumpCounter(tx, ctx.orgId, 'SUP', list.map((r) => String(r.id)));
      await auditSql(ctx, tx, 'staff.workspace_import', 'supervision_booking', ctx.orgId, { collection: 'sup', records: n });
    }),
};

// ================================================================================================
// tplan – Staff › Training › Planned sessions
const tplan: V36Adapter = {
  key: 'tplan',
  shape: 'list',
  canRead: (ctx) => has(ctx, 'staff.profile.view_basic'),
  load: (ctx) =>
    ctx.tx(async (tx) => {
      const P = await loadPeople(tx);
      const rows = await tx.$queryRaw<
        {
          code: string;
          course_code: string;
          planned_on: Date;
          places: number;
          invited_staff_ids: string[];
          status: string;
          created_by: string;
          attended: number | null;
        }[]
      >`
        SELECT code, course_code, planned_on, places, invited_staff_ids, status, created_by,
               (SELECT count(*)::int FROM staff_check_receipt r
                 WHERE r.session_code = training_plan.code) AS attended
          FROM training_plan WHERE status <> 'CANCELLED' ORDER BY code`;
      return rows.map((r) =>
        clean({
          id: r.code,
          course: r.course_code.replace(/^TR-/, ''),
          date: d10(r.planned_on),
          cap: r.places,
          inv: r.invited_staff_ids.map((s) => P.staffCodeOf(s)).filter((x): x is string => !!x),
          state: r.status === 'HELD' ? 'Held' : 'Planned',
          by: P.nameOf(r.created_by) ?? '',
          att: r.status === 'HELD' ? (r.attended ?? 0) : undefined,
        }),
      );
    }),
  apply: async (ctx, c) => {
    const a = c.after;
    if (!a) throw refuse('Planned sessions are cancelled, not deleted', 403);
    if (!c.before) {
      await ctx.api('POST', '/training-plans', {
        courseCode: `TR-${String(a.course)}`,
        plannedOn: a.date,
        places: Math.max(1, Math.round(Number(a.cap) || 8)),
        inviteDue: arr(a.inv).length > 0,
      });
      return;
    }
    const id = await rowId(ctx, 'training_plan', c.id);
    if (a.state === 'Planned' && arr(a.inv).length > arr(c.before.inv).length) {
      await ctx.api('POST', `/training-plans/${id}/invite-due`);
      return;
    }
    throw refuse('Take attendance from the group training record (not connected yet)');
  },
  isEmpty: (ctx) => count(ctx, 'training_plan'),
  import: (ctx, records) =>
    ctx.tx(async (tx) => {
      const P = await loadPeople(tx);
      const list = arr(records);
      for (const r of list) {
        if (!str(r.id) || !isDay(r.date)) continue;
        const inv = arr<string>(r.inv).map((x) => P.staffIdOf(x)).filter((x): x is string => !!x);
        const cap = Math.max(1, Math.round(Number(r.cap) || 8), inv.length);
        await tx.$executeRaw`
          INSERT INTO training_plan (organisation_id, code, course_code, planned_on, places,
                                     invited_staff_ids, status, created_by)
          VALUES (app_org_id(), ${str(r.id)}, ${`TR-${String(r.course)}`}, ${r.date}::date, ${cap},
                  ${inv}::uuid[], ${r.state === 'Held' ? 'HELD' : 'PLANNED'},
                  ${P.userIdOf(str(r.by)) ?? ctx.userId}::uuid)`;
      }
      await bumpCounter(tx, ctx.orgId, 'TP', list.map((r) => String(r.id)));
      await auditSql(ctx, tx, 'staff.workspace_import', 'training_plan', ctx.orgId, { collection: 'tplan', records: list.length });
    }),
};

// ================================================================================================
// sg – Settings › Support access
const sg: V36Adapter = {
  key: 'sg',
  shape: 'list',
  canRead: (ctx) => has(ctx, 'admin.support.view'),
  load: (ctx) =>
    ctx.tx(async (tx) => {
      const P = await loadPeople(tx);
      const rows = await tx.$queryRaw<
        {
          id: string;
          email: string | null;
          reason: string;
          starts_at: Date;
          ends_at: Date;
          approved_by: string;
          ended_at: Date | null;
        }[]
      >`
        SELECT g.id, COALESCE(u.email, support_grant_email(g.id)) AS email, g.reason, g.starts_at, g.ends_at, g.approved_by,
               (SELECT e.ended_at FROM support_access_end e WHERE e.grant_id = g.id LIMIT 1) AS ended_at
          FROM support_access_grant g LEFT JOIN app_user u ON u.id = g.support_user_id
         ORDER BY g.starts_at`;
      const now = new Date();
      return rows.map((g) => ({
        id: g.id,
        who: g.email ?? 'Platform support',
        why: g.reason,
        hours: Math.round((g.ends_at.getTime() - g.starts_at.getTime()) / 3_600_000),
        from: stamp(g.starts_at),
        until: stamp(g.ended_at ?? g.ends_at),
        by: P.nameOf(g.approved_by) ?? '',
        state: g.ended_at ? 'Ended early' : g.ends_at > now ? 'Active' : 'Expired',
      }));
    }),
  apply: async (ctx, c) => {
    const a = c.after;
    if (!a) throw refuse('Support access records are kept', 403);
    if (!c.before) {
      const why = str(a.why) ?? '';
      if (why.length < 10) throw refuse('Give the reason in at least 10 characters');
      await ctx.api('POST', '/admin/support-access-grants', {
        supportUserEmail: str(a.who),
        reason: why,
        hours: Math.max(1, Math.min(8, Math.round(Number(a.hours) || 1))),
      });
      return;
    }
    if (a.state === 'Ended early' && c.before.state === 'Active') {
      await ctx.api('POST', `/admin/support-access-grants/${c.id}/end`, {
        reason: 'Ended early from Support access',
      });
      return;
    }
    throw refuse('That change to support access cannot be saved here');
  },
};

// ================================================================================================
// optOut – 48-hour week opt-outs; supRule / stageT – fixed values the API also uses
const optOut: V36Adapter = {
  key: 'optOut',
  shape: 'map',
  canRead: (ctx) =>
    has(ctx, 'staff.profile.view_basic') || has(ctx, 'staff.profile.view_clearance') || has(ctx, 'jobs.allocate'),
  load: (ctx) =>
    ctx.tx(async (tx) => {
      const rows = await tx.$queryRaw<{ staff_no: string }[]>`
        SELECT staff_no FROM staff WHERE wtd_opt_out ORDER BY staff_no`;
      return Object.fromEntries(rows.map((r) => [r.staff_no, true as unknown as V36Record]));
    }),
  apply: async (ctx, c: V36Change) => {
    const sid = await staffIdOf(ctx, c.id);
    await ctx.api('POST', `/staff/${sid}/working-time-opt-out`, { optOut: !!c.after });
  },
  isEmpty: (ctx) =>
    ctx.tx(async (tx) => {
      const r = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM staff WHERE wtd_opt_out`;
      return r[0]!.n === 0;
    }),
  import: (ctx, records) =>
    ctx.tx(async (tx) => {
      const codes = Object.entries(rec(records))
        .filter(([, v]) => !!v)
        .map(([k]) => k);
      if (!codes.length) return;
      await tx.$executeRaw`
        UPDATE staff SET wtd_opt_out = true, wtd_opt_out_on = ${londonDate(new Date())}::date
         WHERE staff_no = ANY(${codes}::text[])`;
      await auditSql(ctx, tx, 'staff.workspace_import', 'staff', ctx.orgId, { collection: 'optOut', records: codes.length });
    }),
};

/** Supervision every 56 days, probation reviews at 3 and 6 months (training.controller, reviews). */
const supRule: V36Adapter = {
  key: 'supRule',
  shape: 'map',
  load: async () => ({ every: 56, probation: [3, 6] }) as unknown as Record<string, V36Record>,
};
/** Days allowed in each onboarding stage (shown as "Day 17 of 21 in stage"). */
const stageT: V36Adapter = {
  key: 'stageT',
  shape: 'map',
  load: async () =>
    ({
      Candidate: 5,
      'Checks in progress': 21,
      'Ready for review': 3,
      'Approved for role': 7,
    }) as unknown as Record<string, V36Record>,
};

export const REGISTER_ADAPTERS: V36Adapter[] = [
  acct,
  rev,
  sick,
  leave,
  agency,
  lic,
  corr,
  sup,
  tplan,
  sg,
  optOut,
  supRule,
  stageT,
];
