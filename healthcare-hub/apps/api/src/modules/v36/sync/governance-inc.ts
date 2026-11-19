// S.inc (incidents, near misses, accidents, safeguarding, harassment, complaints reported as
// events) and S.riddor (RIDDOR assessment per event) ↔ event, event_transition,
// candour_assessment, event_candour_step, cqc_notification, reporting_obligation.
import type { TenantTx } from '@hub/db';
import { loadPeople, stamp, ymd, type People } from './lookup.js';
import type { V36Adapter, V36Change, V36Ctx, V36Record } from './types.js';
import {
  addDays,
  allocCode,
  auditRow,
  byCodeNo,
  changed,
  dateCol,
  invalid,
  isRole,
  londonDay,
  londonToUtc,
  need,
  refuse,
  registeredManager,
  str,
  textLen,
  v36Role,
  type J,
} from './governance-common.js';

const TYPE: Record<string, string> = {
  Incident: 'INCIDENT',
  'Near miss': 'NEAR_MISS',
  Accident: 'ACCIDENT',
  'Safeguarding concern': 'SAFEGUARDING',
  Harassment: 'HARASSMENT',
  Complaint: 'COMPLAINT',
};
const TYPE_LABEL = Object.fromEntries(Object.entries(TYPE).map(([k, v]) => [v, k]));
export const HARM: Record<string, string> = {
  'No harm': 'NO_HARM',
  'Low harm': 'LOW',
  'Moderate harm': 'MODERATE',
  'Severe harm': 'SEVERE',
  Death: 'DEATH',
};
const HARM_LABEL = Object.fromEntries(Object.entries(HARM).map(([k, v]) => [v, k]));
const PRIO: Record<string, string> = {
  NO_HARM: 'LOW',
  LOW: 'MEDIUM',
  MODERATE: 'HIGH',
  SEVERE: 'CRITICAL',
  DEATH: 'CRITICAL',
};
/** Triage category (v36's form has none): from the first type. */
const CATEGORY: Record<string, string> = {
  INCIDENT: 'PATIENT_CARE',
  NEAR_MISS: 'EQUIPMENT',
  ACCIDENT: 'STAFF_INJURY',
  SAFEGUARDING: 'SAFEGUARDING',
  HARASSMENT: 'HARASSMENT',
  COMPLAINT: 'PATIENT_CARE',
};
export const STAGES = [
  'Reported',
  'Triaged',
  'Investigating',
  'Findings & learning',
  'Actions in progress',
  'Awaiting closure',
  'Closed',
] as const;
const STATUS_OF: Record<string, string> = {
  Reported: 'TRIAGE',
  Triaged: 'ASSESS',
  Investigating: 'INVESTIGATE',
  'Findings & learning': 'RESPOND',
  'Actions in progress': 'ACTIONS',
  'Awaiting closure': 'LEARNING_VERIFIED',
  Closed: 'CLOSED',
};
const STAGE_OF: Record<string, string> = {
  TRIAGE: 'Reported',
  PROTECT: 'Triaged',
  ASSESS: 'Triaged',
  INVESTIGATE: 'Investigating',
  RESPOND: 'Findings & learning',
  ACTIONS: 'Actions in progress',
  LEARNING_VERIFIED: 'Awaiting closure',
  CLOSED: 'Closed',
};
/** Duty of candour steps, in v36's order. */
const CANDOUR_KEYS = ['TOLD_IN_PERSON', 'APOLOGY', 'WRITTEN_NOTICE', 'FINDINGS_SHARED'];
/** v36's step wording (incTriage), used when no step plan was recorded. */
const CANDOUR_TEXT = [
  'Tell the patient / family in person',
  'Apology given',
  'Written follow-up within 10 working days',
  'Investigation findings shared',
];
const CQC_KIND_LABEL: Record<string, string> = {
  DEATH: 'Death of a person using the service',
  SERIOUS_INJURY: 'Serious injury',
  ABUSE_ALLEGATION: 'Allegation of abuse',
  POLICE_INCIDENT: 'Incident reported to or investigated by the police',
};
const cqcKind = (label: unknown) => (/^death/i.test(String(label ?? '')) ? 'DEATH' : 'SERIOUS_INJURY');
const FULL = 'gov rm dir aud pres';

interface EventRow {
  id: string;
  code: string;
  types: string[];
  title: string;
  description: string;
  occurred_at: Date;
  created_at: Date;
  place: string | null;
  people_refs: string[];
  immediate_actions: string | null;
  still_at_risk: boolean;
  nhs_funded: boolean;
  reported_by: string | null;
  created_by: string | null;
  severity: string;
  lead_user_id: string;
  status: string;
  triaged_at: Date | null;
  learning_notes: string | null;
  contributory_factors: string | null;
  terms_of_reference: string | null;
  investigation_due_on: Date | null;
  root_cause: string | null;
  rca: J | null;
  share_learning: boolean | null;
  learning_on: Date | null;
  reporter_feedback: string | null;
  candour_due: J;
  v36_extra: J;
  version: number;
}

async function eventRows(ctx: V36Ctx, tx: TenantTx, code?: string): Promise<EventRow[]> {
  const own = !isRole(ctx, FULL);
  return tx.$queryRaw<EventRow[]>`
    SELECT id, code, types, title, description, occurred_at, created_at, place, people_refs,
           immediate_actions, still_at_risk, nhs_funded, reported_by, created_by, severity::text,
           lead_user_id, status::text, triaged_at, learning_notes, contributory_factors,
           terms_of_reference, investigation_due_on, root_cause, rca, share_learning, learning_on,
           reporter_feedback, candour_due, v36_extra, version
      FROM event
     WHERE NOT ('DEFECT' = ANY (types)) AND NOT ('COMPLIMENT' = ANY (types))
       AND (${own}::boolean = false OR reported_by = ${ctx.userId}::uuid)
       AND (${code ?? null}::text IS NULL OR code = ${code ?? null})`;
}

async function buildInc(ctx: V36Ctx, tx: TenantTx, rows: EventRow[], p: People) {
  const ids = rows.map((r) => r.id);
  if (!ids.length) return {};
  const tr = await tx.$queryRaw<
    { event_id: string; to_status: string; note: string; by_user_id: string; at: Date }[]
  >`SELECT event_id, to_status::text, note, by_user_id, at FROM event_transition
     WHERE event_id = ANY (${ids}::uuid[]) ORDER BY at, id`;
  const acts = await tx.$queryRaw<{ source_id: string; code: string }[]>`
    SELECT source_id, code FROM action WHERE source_type = 'EVENT' AND source_id = ANY (${ids}::uuid[])`;
  const cand = await tx.$queryRaw<{ event_id: string; notifiable: boolean }[]>`
    SELECT DISTINCT ON (event_id) event_id, notifiable FROM candour_assessment
     WHERE event_id = ANY (${ids}::uuid[]) ORDER BY event_id, decided_at DESC, id DESC`;
  const steps = await tx.$queryRaw<
    { event_id: string; step: string; recorded_by: string; recorded_at: Date }[]
  >`SELECT event_id, step, recorded_by, recorded_at FROM event_candour_step
     WHERE event_id = ANY (${ids}::uuid[]) ORDER BY recorded_at`;
  const cqc = await tx.$queryRaw<
    {
      event_id: string;
      kind: string;
      status: string;
      prepared_by: string;
      created_at: Date;
      cqc_reference: string | null;
      submitted_on: Date | null;
      submitted_by: string | null;
      reviewed_by: string | null;
    }[]
  >`SELECT DISTINCT ON (event_id) event_id, kind, status, prepared_by, created_at, cqc_reference,
           submitted_on, submitted_by, reviewed_by
      FROM cqc_notification WHERE event_id = ANY (${ids}::uuid[])
     ORDER BY event_id, created_at DESC`;
  const out: Record<string, V36Record> = {};
  for (const e of rows.sort((a, b) => byCodeNo(a.code, b.code))) {
    const x = e.v36_extra ?? {};
    const names = (x.names ?? {}) as J;
    const stamps: Record<string, string> = {};
    let closed: J | null = null;
    for (const t of tr.filter((t) => t.event_id === e.id)) {
      const s = STAGE_OF[t.to_status];
      if (s) stamps[s] = stamp(t.at)!;
      if (t.to_status === 'CLOSED')
        closed = { by: p.nameOf(t.by_user_id) ?? names.closedBy ?? null, on: stamp(t.at), note: t.note };
    }
    let stage = STAGE_OF[e.status] ?? 'Reported';
    if (e.status === 'TRIAGE' && e.triaged_at) stage = 'Triaged';
    if (e.status !== 'CLOSED') closed = null;
    const triaged = !!e.triaged_at;
    const r: J = {
      id: e.code,
      type: e.types.map((t) => TYPE_LABEL[t] ?? t),
      title: e.title,
      when: stamp(e.occurred_at),
      place: e.place ?? '',
      what: e.description,
      jobs: e.people_refs.join(', '),
      imm: e.immediate_actions ?? '',
      risk: e.still_at_risk,
      nhs: e.nhs_funded,
      by: p.nameOf(e.reported_by ?? e.created_by) ?? names.by ?? null,
      on: stamp(e.created_at),
      harm: triaged ? (HARM_LABEL[e.severity] ?? null) : null,
      lead: triaged ? (p.nameOf(e.lead_user_id) ?? names.lead ?? null) : null,
      stage,
      acts: acts
        .filter((a) => a.source_id === e.id)
        .map((a) => a.code)
        .sort(byCodeNo),
      stamps,
    };
    const c = cand.find((c) => c.event_id === e.id);
    if (c?.notifiable) {
      const plan = ((e.candour_due ?? {}).steps ?? []) as J[];
      const doneRows = steps.filter((s) => s.event_id === e.id);
      r.doc = {
        need: true,
        steps: CANDOUR_KEYS.map((k, i) => {
          const s: J = { k: plan[i]?.k ?? CANDOUR_TEXT[i] ?? k };
          if (plan[i] && 'due' in plan[i]) s.due = plan[i].due;
          const d = doneRows.find((x) => x.step === k);
          if (d) {
            s.done = stamp(d.recorded_at);
            s.by = p.nameOf(d.recorded_by) ?? ((plan[i] ?? {}).byName as string | undefined) ?? null;
          }
          return s;
        }),
      };
    }
    const q = cqc.find((q) => q.event_id === e.id);
    if (q) {
      r.cqc = {
        need: true,
        type: (x.cqcType as string | undefined) ?? CQC_KIND_LABEL[q.kind] ?? 'Serious injury',
        state: q.status === 'SUBMITTED' ? 'Submitted' : 'Draft',
        by: p.nameOf(q.prepared_by),
        on: (x.cqcOn as string | undefined) ?? stamp(q.created_at),
      };
      if (q.cqc_reference) r.cqc.ref = q.cqc_reference;
      if (q.submitted_on) r.cqc.sub = ymd(q.submitted_on);
      if (q.status === 'SUBMITTED') r.cqc.subBy = p.nameOf(q.submitted_by ?? q.reviewed_by);
    }
    if (e.terms_of_reference !== null) r.tor = e.terms_of_reference;
    if (e.investigation_due_on) r.inv_due = ymd(e.investigation_due_on);
    if (e.contributory_factors !== null) r.findings = e.contributory_factors;
    if (e.root_cause !== null) r.root = e.root_cause;
    if (e.learning_notes !== null) r.learning = e.learning_notes;
    if (e.share_learning !== null) r.share = e.share_learning;
    if (e.learning_on) r.learnOn = ymd(e.learning_on);
    if (e.rca) r.rca = e.rca;
    if (closed) r.closed = closed;
    if (e.reporter_feedback !== null) r.fb = e.reporter_feedback;
    if (x.riddor !== undefined) r.riddor = x.riddor;
    if (x.psirf !== undefined) r.psirf = x.psirf;
    out[e.code] = r;
  }
  return out;
}

const types = (v: unknown) => {
  const list = Array.isArray(v) ? v : [];
  const t = list.map((x) => TYPE[String(x)] ?? (String(x) === 'Accident or injury' ? 'ACCIDENT' : null));
  if (!t.length || t.some((x) => !x)) invalid('Choose what is being reported');
  return [...new Set(t as string[])];
};
const refs = (v: unknown) =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);

async function transition(
  ctx: V36Ctx,
  tx: TenantTx,
  e: EventRow,
  to: string,
  note: string,
  at: Date = new Date(),
  by: string = ctx.userId,
) {
  await tx.$executeRaw`
    INSERT INTO event_transition (organisation_id, event_id, from_status, to_status, note, by_user_id, at)
    VALUES (${ctx.orgId}::uuid, ${e.id}::uuid, ${e.status}::event_status, ${to}::event_status,
            ${note}, ${by}::uuid, ${at})`;
  await tx.$executeRaw`UPDATE event SET status = ${to}::event_status WHERE id = ${e.id}::uuid`;
  e.status = to;
}

async function report(ctx: V36Ctx, tx: TenantTx, id: string, a: J) {
  if (v36Role(ctx) === 'aud' || ctx.hub.support) refuse('this role is read-only');
  const t = types(a.type);
  const title = textLen(str(a.title), 'Short title', 3, 200);
  const what = textLen(str(a.what), 'What happened', 3, 4000);
  const now = new Date();
  const when = str(a.when) ? londonToUtc(String(a.when)) : now;
  if (when.getTime() > now.getTime() + 5 * 60_000) invalid('When did it happen: that is in the future');
  const code = await allocCode(tx, 'event', id, 'EVT-2026-', { width: 3 });
  const lead = await registeredManager(tx, ctx.userId);
  const [row] = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO event (organisation_id, code, types, title, description, occurred_at, discovered_at,
                       severity, lead_user_id, status, created_by, reported_by, place, people_refs,
                       immediate_actions, still_at_risk, nhs_funded, triage_due_at)
    VALUES (${ctx.orgId}::uuid, ${code}, ${t}::text[], ${title}, ${what}, ${when}, ${now},
            'NO_HARM', ${lead}::uuid, 'TRIAGE', ${ctx.userId}::uuid, ${ctx.userId}::uuid,
            ${str(a.place)}, ${refs(a.jobs)}::text[], ${str(a.imm)}, ${!!a.risk}, ${!!a.nhs},
            ${new Date(now.getTime() + 2 * 86_400_000)})
    RETURNING id`;
  await tx.$executeRaw`
    INSERT INTO event_transition (organisation_id, event_id, from_status, to_status, note, by_user_id, at)
    VALUES (${ctx.orgId}::uuid, ${row!.id}::uuid, NULL, 'TRIAGE', 'Reported', ${ctx.userId}::uuid, ${now})`;
  if (a.risk) {
    // Same alert as the report form: the reference only, to the manager and governance lead.
    const leads = await tx.$queryRaw<{ user_id: string }[]>`
      SELECT DISTINCT m.user_id FROM membership m JOIN role r ON r.id = m.role_id
        JOIN app_user u ON u.id = m.user_id
       WHERE m.valid_to IS NULL AND u.status = 'ACTIVE'
         AND r.key IN ('REGISTERED_MANAGER', 'GOVERNANCE_LEAD')`;
    const alert = await tx.alert.create({
      data: {
        organisationId: ctx.orgId,
        sourceType: 'EVENT',
        sourceId: row!.id,
        severity: 'CRITICAL',
        reasonCode: 'INCIDENT_STILL_AT_RISK',
        reasonText: `${code}: someone is still at risk. Open the report and act now.`,
        ownerUserId: lead,
        raisedAt: now,
      },
    });
    for (const l of leads)
      await tx.notificationDelivery.create({
        data: {
          organisationId: ctx.orgId,
          alertId: alert.id,
          channel: 'IN_APP',
          recipientUserId: l.user_id,
          dedupeKey: `incident-at-risk:${row!.id}:${l.user_id}`,
        },
      });
  }
  await auditRow(ctx, tx, 'events.event.report', 'event', row!.id, {
    code,
    types: t.join(','),
    stillAtRisk: !!a.risk,
  });
}

async function applyInc(ctx: V36Ctx, c: V36Change) {
  const a = (c.after ?? {}) as J;
  const b = (c.before ?? {}) as J;
  await ctx.tx(async (tx) => {
    if (!c.before) return report(ctx, tx, c.id, a);
    if (!c.after) refuse('Incidents cannot be deleted');
    const [e] = await eventRows(ctx, tx, c.id);
    if (!e) refuse(`${c.id} was not found`, 400);
    const p = await loadPeople(tx);
    const me = ctx.userId;
    const from = String(b.stage);
    const to = String(a.stage);
    const audit = (action: string, s: Record<string, string | number | boolean | null> = {}) =>
      auditRow(ctx, tx, action, 'event', e.id, { code: e.code, ...s });

    // ---- the stage moves v36 offers ----
    if (from !== to) {
      const fi = STAGES.indexOf(from as never);
      const ti = STAGES.indexOf(to as never);
      if (ti < 0) invalid(`Unknown stage: ${to}`);
      if (STAGE_OF[e.status] !== from && !(from === 'Triaged' && e.status === 'TRIAGE'))
        refuse('This incident was changed by someone else; reload and retry', 409);
      if (to === 'Triaged' && from === 'Reported') {
        need(ctx, 'gov rm dir', 'only governance or a manager can triage');
        const sev = HARM[String(a.harm)];
        if (!sev) invalid('Choose the harm level');
        const lead = p.needUserId(a.lead, 'Lead investigator');
        await tx.$executeRaw`
          UPDATE event SET severity = ${sev}::event_severity, lead_user_id = ${lead}::uuid,
                 triaged_at = now(), triaged_by = ${me}::uuid, priority = ${PRIO[sev]},
                 category = coalesce(category, ${CATEGORY[e.types[0]!] ?? 'OTHER'}),
                 protection_steps = coalesce(protection_steps, 'Recorded at triage')
           WHERE id = ${e.id}::uuid`;
        await transition(ctx, tx, e, 'ASSESS', 'Triaged');
        await audit('events.event.triage', { severity: sev });
      } else if (to === 'Investigating' && from === 'Triaged') {
        need(ctx, 'gov rm dir', 'only governance or a manager can start an investigation');
        const tor = textLen(str(a.tor), 'Terms of reference', 1, 4000);
        await tx.$executeRaw`
          UPDATE event SET terms_of_reference = ${tor},
                 investigation_due_on = ${dateCol(a.inv_due)} WHERE id = ${e.id}::uuid`;
        await transition(ctx, tx, e, 'INVESTIGATE', 'Investigation started');
        await audit('events.event.transition', { to: 'INVESTIGATE' });
      } else if (to === 'Investigating' && fi > 2) {
        need(ctx, 'rm dir', 'only the Registered Manager or Director');
        await transition(ctx, tx, e, 'INVESTIGATE', 'Sent back to the lead');
        await audit('events.event.send_back', { from: STATUS_OF[from]! });
      } else if (to === 'Findings & learning' && from === 'Investigating') {
        need(ctx, 'gov rm dir', 'only the lead or a manager can record findings');
        const f = textLen(str(a.findings), 'Findings', 1, 4000);
        const l = textLen(str(a.learning), 'Learning', 1, 4000);
        await tx.$executeRaw`
          UPDATE event SET contributory_factors = ${f}, learning_notes = ${l},
                 root_cause = ${str(a.root)}, share_learning = ${!!a.share},
                 learning_on = ${dateCol(a.learnOn) ?? dateCol(ctx.today)},
                 rca = ${a.rca ? JSON.stringify(a.rca) : null}::jsonb,
                 learning_response = coalesce(learning_response, 'AFTER_ACTION_REVIEW')
           WHERE id = ${e.id}::uuid`;
        await transition(ctx, tx, e, 'RESPOND', 'Findings and learning recorded');
        await audit('events.event.learning');
      } else if (to === 'Actions in progress' && from === 'Findings & learning') {
        need(ctx, 'gov rm dir', 'not allowed');
        await transition(ctx, tx, e, 'ACTIONS', 'Actions in progress');
        await audit('events.event.transition', { to: 'ACTIONS' });
      } else if (
        to === 'Awaiting closure' &&
        (from === 'Actions in progress' || from === 'Findings & learning')
      ) {
        need(ctx, 'gov rm dir', 'not allowed');
        const open = await tx.$queryRaw<{ code: string }[]>`
          SELECT code FROM action WHERE source_type = 'EVENT' AND source_id = ${e.id}::uuid
             AND status <> 'VERIFIED' ORDER BY code`;
        if (open.length)
          refuse(`${open.length} action(s) not verified yet: ${open.map((o) => o.code).join(', ')}`);
        await transition(ctx, tx, e, 'LEARNING_VERIFIED', open.length ? 'Closure requested' : 'Sent for closure');
        await audit('events.event.transition', { to: 'LEARNING_VERIFIED' });
      } else if (to === 'Closed' && from === 'Awaiting closure') {
        need(ctx, 'rm dir', 'only the Registered Manager or Director can close an incident');
        if (e.lead_user_id === me)
          refuse('you led this investigation, so someone else must close it');
        const notifiable = (
          await tx.$queryRaw<{ n: boolean }[]>`
            SELECT notifiable AS n FROM candour_assessment WHERE event_id = ${e.id}::uuid
             ORDER BY decided_at DESC LIMIT 1`
        )[0]?.n;
        if (notifiable) {
          const done = await tx.$queryRaw<{ step: string }[]>`
            SELECT step FROM event_candour_step WHERE event_id = ${e.id}::uuid`;
          if (CANDOUR_KEYS.some((k) => !done.some((d) => d.step === k)))
            refuse('duty of candour steps are still open');
        }
        const q = await tx.$queryRaw<{ status: string }[]>`
          SELECT status FROM cqc_notification WHERE event_id = ${e.id}::uuid
           ORDER BY created_at DESC LIMIT 1`;
        if (q[0] && q[0].status !== 'SUBMITTED')
          refuse('the CQC notification has not been recorded as submitted');
        const note = textLen(str((a.closed as J | undefined)?.note), 'Closure note', 1, 2000);
        const fb = textLen(str(a.fb), 'Outcome shared with the reporter', 1, 2000);
        await tx.$executeRaw`UPDATE event SET reporter_feedback = ${fb} WHERE id = ${e.id}::uuid`;
        await transition(ctx, tx, e, 'CLOSED', note);
        await audit('events.event.close');
      } else refuse('not allowed');
    }

    // ---- duty of candour: decision at triage, step plan and steps done ----
    if (a.doc && !b.doc) {
      need(ctx, 'gov rm dir', 'only governance or a manager');
      await tx.$executeRaw`
        INSERT INTO candour_assessment (organisation_id, event_id, notifiable, reason, decided_by)
        VALUES (${ctx.orgId}::uuid, ${e.id}::uuid, true,
                'Duty of candour applies (notifiable safety incident, recorded at triage)', ${me}::uuid)`;
      await audit('events.candour.decide', { notifiable: true });
    }
    if (a.doc) {
      const before = ((b.doc as J | undefined)?.steps ?? []) as J[];
      const after = ((a.doc as J).steps ?? []) as J[];
      const plan = after.map((s) => {
        const o: J = { k: s.k };
        if ('due' in s) o.due = s.due ?? '';
        return o;
      });
      if (JSON.stringify(plan) !== JSON.stringify(e.candour_due?.steps ?? null))
        await tx.$executeRaw`
          UPDATE event SET candour_due = jsonb_set(candour_due, '{steps}', ${JSON.stringify(plan)}::jsonb)
           WHERE id = ${e.id}::uuid`;
      for (let i = 0; i < after.length && i < CANDOUR_KEYS.length; i++) {
        if (!after[i]!.done || before[i]?.done) continue;
        need(ctx, 'gov rm dir', 'only governance or a manager');
        await tx.$executeRaw`
          INSERT INTO event_candour_step (organisation_id, event_id, step, done_on, recorded_by)
          VALUES (${ctx.orgId}::uuid, ${e.id}::uuid, ${CANDOUR_KEYS[i]!},
                  ${dateCol(londonDay(new Date()))}, ${me}::uuid)`;
        await audit('events.candour.step', { step: CANDOUR_KEYS[i]! });
      }
    }

    // ---- CQC notification: drafted at triage, submission recorded by the RM or Director ----
    const qa = a.cqc as J | undefined;
    const qb = b.cqc as J | undefined;
    if (qa && !qb) {
      need(ctx, 'gov rm dir', 'only governance or a manager can triage');
      const ncode = await allocCode(tx, 'cqc_notification', '', 'NTF-', { width: 2, counter: 'NTF' });
      const kind = cqcKind(qa.type);
      const occurred = londonDay(e.occurred_at)!;
      const [n] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO cqc_notification (organisation_id, code, kind, event_id, occurred_on, due_on,
                                      summary, prepared_by)
        VALUES (${ctx.orgId}::uuid, ${ncode}, ${kind}, ${e.id}::uuid, ${dateCol(occurred)},
                ${dateCol(ctx.today)}, ${`CQC notification for ${e.code}: ${e.title}`.slice(0, 4000)},
                ${me}::uuid)
        RETURNING id`;
      if (qa.type !== CQC_KIND_LABEL[kind])
        await tx.$executeRaw`
          UPDATE event SET v36_extra = v36_extra || jsonb_build_object('cqcType', ${String(qa.type)}::text)
           WHERE id = ${e.id}::uuid`;
      await auditRow(ctx, tx, 'regulatory.cqc_notification.create', 'cqc_notification', n!.id, {
        kind,
        eventCode: e.code,
      });
    }
    if (qa && qb && qa.state === 'Submitted' && qb.state !== 'Submitted') {
      need(ctx, 'rm dir', 'only the Registered Manager or Director records submissions');
      const ref = textLen(str(qa.ref), 'CQC reference', 2, 60);
      const on = dateCol(str(qa.sub) ?? ctx.today)!;
      if (on.getTime() < dateCol(londonDay(e.occurred_at))!.getTime())
        invalid('Submitted on: that is before the incident happened');
      const r = await tx.$queryRaw<{ id: string; prepared_by: string }[]>`
        UPDATE cqc_notification SET status = 'SUBMITTED', submitted_on = ${on}, cqc_reference = ${ref},
               submitted_by = ${me}::uuid,
               reviewed_by = CASE WHEN prepared_by <> ${me}::uuid THEN ${me}::uuid ELSE reviewed_by END,
               reviewed_at = CASE WHEN prepared_by <> ${me}::uuid THEN now() ELSE reviewed_at END
         WHERE id = (SELECT id FROM cqc_notification WHERE event_id = ${e.id}::uuid
                      ORDER BY created_at DESC LIMIT 1) AND status <> 'SUBMITTED'
        RETURNING id, prepared_by`;
      if (!r[0]) refuse('The CQC notification was changed by someone else; reload and retry', 409);
      await auditRow(ctx, tx, 'regulatory.cqc_notification.submit', 'cqc_notification', r[0].id, {
        eventCode: e.code,
      });
    }
    // Findings step due date set when findings are recorded (handled above in the plan).
    if (changed(c.before, c.after, 'fb') && from === to && a.stage === 'Closed')
      refuse('The closed record cannot be changed');
  });
}

// ---- import (step 1 copy → tables) -------------------------------------------------------------
async function importInc(ctx: V36Ctx, recs: Record<string, V36Record>) {
  await ctx.tx(async (tx) => {
    const p = await loadPeople(tx);
    const rm = await registeredManager(tx, ctx.userId);
    for (const [code, raw] of Object.entries(recs)) {
      const a = raw as J;
      const t = types(a.type);
      const sev = HARM[String(a.harm)] ?? 'NO_HARM';
      const stage = STAGES.includes(a.stage) ? String(a.stage) : 'Reported';
      const status = STATUS_OF[stage]!;
      const stamps = (a.stamps ?? {}) as Record<string, string>;
      const on = londonToUtc(String(a.on ?? a.when));
      const when = londonToUtc(String(a.when ?? a.on));
      const by = p.userIdOf(a.by);
      const lead = p.userIdOf(a.lead) ?? rm;
      const triaged = stage !== 'Reported';
      const names: J = {};
      if (a.by && !by) names.by = a.by;
      if (a.lead && !p.userIdOf(a.lead)) names.lead = a.lead;
      if (a.closed?.by && !p.userIdOf(a.closed.by)) names.closedBy = a.closed.by;
      const extra: J = {};
      if (Object.keys(names).length) extra.names = names;
      if (a.riddor !== undefined) extra.riddor = a.riddor;
      if (a.psirf !== undefined) extra.psirf = a.psirf;
      if (a.cqc && a.cqc.type !== CQC_KIND_LABEL[cqcKind(a.cqc.type)]) extra.cqcType = a.cqc.type;
      if (a.cqc?.on) extra.cqcOn = a.cqc.on;
      const plan = ((a.doc?.steps ?? []) as J[]).map((s) => {
        const o: J = { k: s.k };
        if ('due' in s) o.due = s.due;
        if (s.by && !p.userIdOf(s.by)) o.byName = s.by;
        return o;
      });
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO event (organisation_id, code, types, title, description, occurred_at, discovered_at,
                           severity, lead_user_id, status, created_by, created_at, reported_by, place,
                           people_refs, immediate_actions, still_at_risk, nhs_funded, triage_due_at,
                           triaged_at, triaged_by, priority, category, protection_steps,
                           learning_notes, contributory_factors, terms_of_reference,
                           investigation_due_on, root_cause, rca, share_learning, learning_on,
                           reporter_feedback, candour_due, v36_extra, learning_response)
        VALUES (${ctx.orgId}::uuid, ${code}, ${t}::text[], ${String(a.title)}, ${String(a.what)},
                ${when}, ${new Date(Math.max(on.getTime(), when.getTime()))}, ${sev}::event_severity,
                ${lead}::uuid, ${status}::event_status, ${by}::uuid, ${on}, ${by}::uuid,
                ${str(a.place)}, ${refs(a.jobs)}::text[], ${str(a.imm)}, ${!!a.risk}, ${!!a.nhs},
                ${new Date(on.getTime() + 2 * 86_400_000)},
                ${triaged ? londonToUtc(stamps.Triaged ?? String(a.on)) : null},
                ${triaged ? lead : null}::uuid, ${triaged ? PRIO[sev]! : null},
                ${triaged ? (CATEGORY[t[0]!] ?? 'OTHER') : null},
                ${triaged ? 'Recorded at triage' : null}, ${str(a.learning)}, ${str(a.findings)},
                ${str(a.tor)}, ${dateCol(a.inv_due)}, ${str(a.root)},
                ${a.rca ? JSON.stringify(a.rca) : null}::jsonb,
                ${typeof a.share === 'boolean' ? a.share : null}, ${dateCol(a.learnOn)},
                ${str(a.fb)}, ${JSON.stringify(a.doc ? { steps: plan } : {})}::jsonb,
                ${JSON.stringify(extra)}::jsonb,
                ${a.psirf || a.learning ? 'AFTER_ACTION_REVIEW' : null})
        RETURNING id`;
      const eid = row!.id;
      let prev: string | null = null;
      const entries = Object.entries(stamps);
      if (!entries.length) entries.push(['Reported', String(a.on)]);
      for (const [name, at] of entries) {
        const to = STATUS_OF[name];
        if (!to) continue;
        const who =
          name === 'Reported'
            ? (by ?? ctx.userId)
            : name === 'Closed'
              ? (p.userIdOf(a.closed?.by) ?? ctx.userId)
              : (p.userIdOf(a.lead) ?? ctx.userId);
        const note = name === 'Closed' ? String(a.closed?.note ?? 'Closed') : name;
        await tx.$executeRaw`
          INSERT INTO event_transition (organisation_id, event_id, from_status, to_status, note, by_user_id, at)
          VALUES (${ctx.orgId}::uuid, ${eid}::uuid, ${prev}::event_status, ${to}::event_status,
                  ${note}, ${who}::uuid, ${londonToUtc(at)})`;
        prev = to;
      }
      if (a.doc?.need) {
        await tx.$executeRaw`
          INSERT INTO candour_assessment (organisation_id, event_id, notifiable, reason, decided_by, decided_at)
          VALUES (${ctx.orgId}::uuid, ${eid}::uuid, true,
                  'Duty of candour applies (moved in from the saved v36 record)', ${lead}::uuid,
                  ${londonToUtc(stamps.Triaged ?? String(a.on))})`;
        const steps = (a.doc.steps ?? []) as J[];
        for (let i = 0; i < steps.length && i < CANDOUR_KEYS.length; i++) {
          const s = steps[i]!;
          if (!s.done) continue;
          const at = londonToUtc(String(s.done));
          await tx.$executeRaw`
            INSERT INTO event_candour_step (organisation_id, event_id, step, done_on, recorded_by, recorded_at)
            VALUES (${ctx.orgId}::uuid, ${eid}::uuid, ${CANDOUR_KEYS[i]!}, ${dateCol(londonDay(at))},
                    ${p.userIdOf(s.by) ?? ctx.userId}::uuid, ${at})`;
        }
      }
      if (a.cqc?.need) {
        const q = a.cqc as J;
        const ncode = await allocCode(tx, 'cqc_notification', '', 'NTF-', { width: 2, counter: 'NTF' });
        const prep = p.userIdOf(q.by) ?? ctx.userId;
        const subm = q.state === 'Submitted';
        const subBy = subm ? (p.userIdOf(q.subBy) ?? ctx.userId) : null;
        await tx.$executeRaw`
          INSERT INTO cqc_notification (organisation_id, code, kind, event_id, occurred_on, due_on, summary,
                                        status, prepared_by, submitted_on, cqc_reference, submitted_by,
                                        reviewed_by, reviewed_at, created_at)
          VALUES (${ctx.orgId}::uuid, ${ncode}, ${cqcKind(q.type)}, ${eid}::uuid,
                  ${dateCol(londonDay(when))}, ${dateCol(londonDay(on))},
                  ${`CQC notification for ${code}: ${String(a.title)}`.slice(0, 4000)},
                  ${subm ? 'SUBMITTED' : 'DRAFT'}, ${prep}::uuid,
                  ${subm ? dateCol(q.sub ?? londonDay(on)) : null}, ${subm ? (str(q.ref) ?? 'Not recorded') : null},
                  ${subBy}::uuid, ${subBy && subBy !== prep ? subBy : null}::uuid,
                  ${subBy && subBy !== prep ? new Date() : null},
                  ${q.on ? londonToUtc(String(q.on)) : on})`;
      }
    }
    await tx.$executeRaw`
      INSERT INTO org_counter (organisation_id, prefix, value) VALUES (app_org_id(), 'EVT', 1)
      ON CONFLICT DO NOTHING`;
    await auditRow(ctx, tx, 'governance.saved_copy.import', 'event', ctx.orgId, { key: 'inc', count: Object.keys(recs).length });
  });
}

export const incAdapter: V36Adapter = {
  key: 'inc',
  shape: 'map',
  load: (ctx) =>
    ctx.tx(async (tx) => buildInc(ctx, tx, await eventRows(ctx, tx), await loadPeople(tx))),
  apply: applyInc,
  isEmpty: (ctx) =>
    ctx.tx(
      async (tx) =>
        (
          await tx.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM event
             WHERE NOT ('DEFECT' = ANY (types)) AND NOT ('COMPLIMENT' = ANY (types))`
        )[0]!.n === 0,
    ),
  import: (ctx, recs) => importInc(ctx, recs as Record<string, V36Record>),
};

// ---- S.riddor ----------------------------------------------------------------------------------
const RDC: [string, number][] = [
  ['Not reportable', 0],
  ['Over-7-day incapacitation of a worker', 15],
  ['Specified injury to a worker', 10],
  ['Dangerous occurrence', 10],
  ['Non-worker taken to hospital from site', 10],
];

async function loadRiddor(ctx: V36Ctx) {
  if (!isRole(ctx, FULL)) return {};
  return ctx.tx(async (tx) => {
    const p = await loadPeople(tx);
    const rows = await tx.$queryRaw<
      {
        code: string;
        trigger_text: string;
        decision_reason: string | null;
        deadline_at: Date | null;
        reference: string | null;
        decided_by: string | null;
        updated_at: Date;
      }[]
    >`SELECT e.code, o.trigger_text, o.decision_reason, o.deadline_at, o.reference, o.decided_by,
             o.updated_at
        FROM reporting_obligation o JOIN event e ON e.id = o.event_id
       WHERE o.body = 'RIDDOR'`;
    const out: Record<string, V36Record> = {};
    for (const r of rows.sort((a, b) => byCodeNo(a.code, b.code))) {
      const o: J = { cls: r.trigger_text, why: r.decision_reason ?? '' };
      if (r.deadline_at) o.due = londonDay(r.deadline_at);
      if (r.reference) o.ref = r.reference;
      o.by = p.nameOf(r.decided_by);
      o.on = londonDay(r.updated_at);
      out[r.code] = o;
    }
    return out;
  });
}

async function saveRiddor(ctx: V36Ctx, tx: TenantTx, code: string, a: J, importing = false) {
  const p = await loadPeople(tx);
  const [e] = await tx.$queryRaw<{ id: string; occurred_at: Date }[]>`
    SELECT id, occurred_at FROM event WHERE code = ${code}`;
  if (!e) invalid(`${code} was not found`);
  const cls = RDC.find((x) => x[0] === a.cls);
  if (!cls) invalid('Choose a RIDDOR classification');
  const why = String(a.why ?? '');
  const due = cls[1]
    ? dateCol(str(a.due) ?? addDays(londonDay(e.occurred_at)!, cls[1]))
    : null;
  const decision = cls[1] ? 'REQUIRED' : 'NOT_REQUIRED';
  const ref = str(a.ref);
  const by = importing ? (p.userIdOf(a.by) ?? ctx.userId) : ctx.userId;
  const at = importing && a.on ? londonToUtc(`${a.on} 12:00`) : new Date();
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO reporting_obligation (organisation_id, event_id, body, trigger_text, basis, deadline_at,
                                      decision, decision_reason, decided_by, submitted_at, reference,
                                      updated_at)
    VALUES (${ctx.orgId}::uuid, ${e.id}::uuid, 'RIDDOR', ${cls[0]}, ${why.length >= 3 ? why : cls[0]},
            ${due}, ${decision}::obligation_decision, ${why}, ${by}::uuid,
            ${ref && decision === 'REQUIRED' ? at : null}, ${ref}, ${at})
    ON CONFLICT DO NOTHING RETURNING id`;
  let id = rows[0]?.id;
  if (!id) {
    const u = await tx.$queryRaw<{ id: string }[]>`
      UPDATE reporting_obligation SET trigger_text = ${cls[0]}, basis = ${why.length >= 3 ? why : cls[0]},
             deadline_at = ${due}, decision = ${decision}::obligation_decision, decision_reason = ${why},
             decided_by = ${by}::uuid, reference = ${ref},
             submitted_at = CASE WHEN ${ref}::text IS NOT NULL AND ${decision} = 'REQUIRED'
                                 THEN coalesce(submitted_at, now()) END
       WHERE event_id = ${e.id}::uuid AND body = 'RIDDOR' RETURNING id`;
    id = u[0]!.id;
  }
  if (!importing)
    await auditRow(ctx, tx, 'events.obligation.update', 'reporting_obligation', id, {
      body: 'RIDDOR',
      decision,
    });
}

export const riddorAdapter: V36Adapter = {
  key: 'riddor',
  shape: 'map',
  load: loadRiddor,
  apply: async (ctx, c) => {
    need(ctx, 'gov rm dir', 'not allowed');
    if (!c.after) refuse('A RIDDOR assessment cannot be deleted');
    await ctx.tx(async (tx) => {
      // One row per event and body: an existing obligation is updated in place.
      await saveRiddor(ctx, tx, c.id, c.after as J);
    });
  },
  isEmpty: (ctx) =>
    ctx.tx(
      async (tx) =>
        (
          await tx.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM reporting_obligation WHERE body = 'RIDDOR'`
        )[0]!.n === 0,
    ),
  import: (ctx, recs) =>
    ctx.tx(async (tx) => {
      for (const [code, r] of Object.entries(recs as Record<string, J>))
        await saveRiddor(ctx, tx, code, r, true);
      await auditRow(ctx, tx, 'governance.saved_copy.import', 'reporting_obligation', ctx.orgId, { key: 'riddor' });
    }),
};
