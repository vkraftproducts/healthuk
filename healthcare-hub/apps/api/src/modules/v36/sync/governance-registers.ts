// v36 governance registers connected to their tables (part 2): complaints (cmp), speak up (su),
// meetings (meet), fit and proper checks (fpp), CQC notifications (ntf), breaches (brc), subject
// access requests (sar), continuity plans and tests (bcp, bcpLog), locations (loc), statement of
// purpose (sop), contractors (ctr), visitors (vis), retention (ret), escalation rules and log
// (esc, esclog), deputies (dep), compliments (compl) and safeguarding (sgr).
//
// Each v36 button on these registers is a small step in a state flow; the flows below repeat
// v36's rules (role, second person, required fields) with the signed-in person.
import type { TenantTx } from '@hub/db';
import { GOV_TABLES } from './governance-fields.js';
import { me, need, onlyFields, refuse, register, roleIs, sameName, type Change, type J, type RegDef } from './register-lib.js';
import type { V36Adapter, V36Ctx } from './types.js';

const text = (v: unknown) => typeof v === 'string' && v.trim() !== '';
const ANY = 'rm dir hr fleet gov disp crew';
const PT = /^PT-\d+$/;

interface Step {
  /** State this step moves to ('*' = any new state; absent = an edit without a state change). */
  to?: string;
  from?: string[];
  roles: string;
  what?: string;
  /** Fields the step may change (besides state). */
  fields: string[];
  /** Fields that must hold the signed-in person's name. */
  mine?: string[];
  /** Fields that must not be empty. */
  filled?: string[];
  more?: (ctx: V36Ctx, c: Change, tx: TenantTx) => void | Promise<void>;
}
interface Flow {
  create?: Omit<Step, 'fields' | 'to' | 'from'> & { state?: string | string[] };
  steps?: Step[];
}
function flowCheck(f: Flow) {
  return async (ctx: V36Ctx, c: Change, _l: unknown, tx: TenantTx) => {
    const a = c.after!;
    if (c.isNew) {
      if (!f.create) refuse('New records are not added here');
      const s = f.create;
      need(ctx, s.roles, s.what);
      if (s.state !== undefined && !(Array.isArray(s.state) ? s.state : [s.state]).includes(a.state))
        refuse(`A new record starts as ${Array.isArray(s.state) ? s.state.join(' or ') : s.state}`, 400);
      for (const k of s.mine ?? []) if (!sameName(a[k], me(ctx))) refuse('it is recorded with your own name', 400);
      for (const k of s.filled ?? []) if (!text(a[k]) && typeof a[k] !== 'number') refuse(`Fill in ${k}`, 400);
      await s.more?.(ctx, c, tx);
      return;
    }
    const b = c.before!;
    const moving = c.diff.has('state');
    const step = (f.steps ?? []).find((s) =>
      moving
        ? (s.to === '*' || s.to === a.state) && (!s.from || s.from.includes(b.state))
        : !s.to && [...c.diff].every((k) => s.fields.includes(k)),
    );
    if (!step) {
      if (moving && (f.steps ?? []).some((s) => s.to === a.state)) refuse(`This cannot move from ${String(b.state)} to ${String(a.state)}`, 409);
      refuse('This change is not allowed here', 400);
    }
    need(ctx, step.roles, step.what);
    onlyFields(c, [...step.fields, 'state']);
    for (const k of step.mine ?? []) if (!sameName(a[k], me(ctx))) refuse('it is recorded with your own name', 400);
    for (const k of step.filled ?? []) if (!text(a[k]) && typeof a[k] !== 'number') refuse(`Fill in ${k}`, 400);
    await step.more?.(ctx, c, tx);
  };
}
function reg(key: string, f: Flow, o: Partial<RegDef> = {}): V36Adapter {
  const t = GOV_TABLES[key]!;
  return register({ key, shape: 'list', table: t.table, prefix: t.prefix, width: t.width, fields: t.fields, check: flowCheck(f), ...o });
}
const GOV = 'gov rm dir';
const seeGov = (ctx: V36Ctx) => roleIs(ctx, 'gov rm dir aud');

const cmp = reg(
  'cmp',
  {
    create: { roles: GOV, what: 'not allowed', state: 'Received', filled: ['sum'], more: (_c, c) => void (PT.test(String(c.after!.pt)) || refuse('Use a patient reference like PT-4521 – never a name', 400)) },
    steps: [
      { to: 'Investigating', from: ['Received'], roles: GOV, what: 'not allowed', fields: ['ack', 'lead'], mine: ['lead'] },
      { to: 'Response sent', from: ['Investigating'], roles: GOV, what: 'not allowed', fields: ['out', 'found', 'learning', 'share', 'resp'], filled: ['found'] },
      { to: 'Closed', from: ['Response sent'], roles: GOV, what: 'not allowed', fields: [] },
    ],
  },
  { canRead: seeGov },
);

const HANDLER = 'hr rm dir';
const su = reg(
  'su',
  {
    create: {
      roles: ANY,
      what: 'read-only',
      state: 'Waiting to be acknowledged',
      filled: ['text'],
      more: (ctx, c) => {
        const a = c.after!;
        if (a.anon ? a.by != null : !sameName(a.by, me(ctx))) refuse('a named concern is raised with your own name; an anonymous one with none', 400);
      },
    },
    steps: [
      { to: 'Acknowledged', from: ['Waiting to be acknowledged'], roles: HANDLER, what: 'only the guardian or a manager', fields: ['ack', 'handler'], mine: ['handler'] },
      { to: 'Being looked into', from: ['Acknowledged'], roles: HANDLER, what: 'not allowed', fields: [] },
      { to: 'Closed', from: ['Acknowledged', 'Being looked into'], roles: HANDLER, what: 'not allowed', fields: ['fb', 'det'], filled: ['fb'] },
      { roles: HANDLER, what: 'not allowed', fields: ['notes'] },
    ],
  },
);
// The guardian and managers see every concern; anyone else only the ones they raised by name.
const suLoad = su.load;
su.load = async (ctx) => {
  const all = (await suLoad(ctx)) as J[];
  if (roleIs(ctx, `${HANDLER} aud`)) return all;
  return all.filter((r) => sameName(r.by, me(ctx)));
};

const meet = reg('meet', { create: { roles: GOV, what: 'not allowed', filled: ['t'] } });

const fpp = reg(
  'fpp',
  {
    create: {
      roles: GOV,
      what: 'not allowed',
      mine: ['by'],
      more: (ctx, c) => {
        const a = c.after!;
        if (sameName(a.who, me(ctx))) refuse('you cannot record your own fit and proper check');
        const n = Object.keys((a.ev ?? {}) as J).length;
        if (a.out === 'Fit and proper' && (a.checks !== 9 || (a.ev && n < 9)))
          refuse(`All 9 items with evidence are needed for a fit and proper outcome (${a.ev ? n : Number(a.checks)} so far)`, 400);
      },
    },
  },
  { canRead: seeGov },
);

const ntf = reg('ntf', {
  create: { roles: GOV, what: 'not allowed', state: 'Draft', mine: ['by'] },
  steps: [{ to: 'Submitted', from: ['Draft'], roles: GOV, what: 'not allowed', fields: ['sub', 'ref'], more: (_c, c) => void ((text(c.after!.ref) && c.after!.ref !== 'CQC-NTF-') || refuse('Give the CQC reference', 400)) }],
});

const brc = reg(
  'brc',
  {
    create: { roles: GOV, what: 'not allowed', state: 'Being assessed', mine: ['by'], filled: ['what'] },
    steps: [
      {
        to: '*',
        roles: GOV,
        what: 'not allowed',
        fields: ['risk', 'decision', 'ico'],
        filled: ['decision'],
        more: (_c, c) => void (c.after!.state !== 'Reported to ICO' || text(c.after!.ico) || refuse('Give the ICO reference', 400)),
      },
    ],
  },
  { canRead: seeGov },
);

const sar = reg(
  'sar',
  {
    create: { roles: GOV, what: 'not allowed', state: ['Collecting records', 'Waiting for ID'] },
    steps: [
      { to: 'Collecting records', from: ['Waiting for ID'], roles: GOV, what: 'not allowed', fields: ['idv', 'due'] },
      { roles: GOV, what: 'not allowed', fields: ['ext', 'due'], filled: ['ext'] },
      { to: 'Responded', from: ['Collecting records'], roles: GOV, what: 'not allowed', fields: ['done'] },
    ],
  },
  { canRead: seeGov },
);

const BCP = 'rm dir fleet gov disp';
const bcp = reg('bcp', { steps: [{ roles: BCP, what: 'not allowed', fields: ['last', 'out'], filled: ['out'] }] });
const bcpLog = reg('bcpLog', { create: { roles: BCP, what: 'not allowed', mine: ['by'], filled: ['p'] } }, { synthId: true });

const loc = reg('loc', { create: { roles: 'rm dir', what: 'not allowed', filled: ['n'] } });

const sop = reg(
  'sop',
  {
    create: {
      roles: 'rm dir',
      what: 'not allowed',
      state: 'Draft',
      mine: ['by'],
      filled: ['sum'],
      more: async (_ctx, c, tx) => {
        const r = await tx.$queryRaw<{ v: number | null }[]>`SELECT max(code::int) AS v FROM v36_sop_version`;
        if (Number(c.id) !== (r[0]?.v ?? 0) + 1) refuse('a new version follows the latest one – reloaded', 409);
      },
    },
    steps: [
      {
        to: 'Published',
        from: ['Draft'],
        roles: 'rm dir',
        what: 'not allowed',
        fields: ['pub', 'ntf'],
        mine: ['pub'],
        more: (ctx, c) => void (!sameName(c.before!.by, me(ctx)) || refuse('you drafted this version, so someone else must publish it')),
      },
    ],
  },
  { idField: 'v', numericId: true, order: 'code::int' },
);

const CTR = 'fleet rm dir gov';
const ctr = register({
  key: 'ctr',
  shape: 'list',
  table: 'contractor',
  prefix: 'CTR-',
  width: 2,
  fields: [
    { f: 'n', col: 'name' },
    { f: 'work', col: 'work' },
    { f: 'ins', col: 'insurance_valid_to', k: 'date' },
    { f: 'comp', col: 'competence_note' },
    { f: 'by', col: 'recorded_by', k: 'person' },
    { f: 'vby', col: 'checked_by', k: 'person' },
    { f: 'state', col: 'status' },
  ],
  check: flowCheck({
    create: { roles: CTR, what: 'not allowed', mine: ['by'], filled: ['n'], state: 'Approved' },
    steps: [
      { roles: CTR, what: 'not allowed', fields: ['vby'], mine: ['vby'], more: (ctx, c) => void (!sameName(c.before!.by, me(ctx)) || refuse('you added this contractor, so someone else must check the evidence')) },
      { roles: CTR, what: 'not allowed', fields: ['ins', 'by', 'vby'], mine: ['by'], more: (_c, c) => void (c.after!.vby == null || refuse('a renewed insurance needs a new second check', 400)) },
    ],
  }),
});

const vis = reg('vis', {
  create: { roles: ANY, what: 'read-only', filled: ['n'] },
  steps: [{ roles: ANY, what: 'read-only', fields: ['out'], filled: ['out'], more: (_c, c) => void (!text(c.before!.out) || refuse('already signed out', 409)) }],
});

const ret = reg('ret', {
  steps: [
    { to: 'Change pending', from: ['Approved'], roles: 'rm dir', what: 'not allowed', fields: ['pend', 'why', 'by'], mine: ['by'], filled: ['why', 'pend'] },
    {
      to: 'Approved',
      from: ['Change pending'],
      roles: 'rm dir',
      what: 'not allowed',
      fields: ['keep', 'pend', 'appr'],
      mine: ['appr'],
      more: (ctx, c) => {
        if (sameName(c.before!.by, me(ctx))) refuse('you proposed this change, so someone else must approve it');
        if (c.after!.keep !== c.before!.pend || c.after!.pend !== undefined) refuse('the approved period is the one proposed', 400);
      },
    },
  ],
});

const t = GOV_TABLES.esc!;
const esc = register({
  key: 'esc',
  shape: 'map',
  table: t.table,
  fields: t.fields,
  check: (ctx, c) => {
    need(ctx, 'rm dir', 'only the Registered Manager or Director can change escalation rules');
    if (c.isNew) refuse('Escalation rules are fixed per kind of item');
    onlyFields(c, ['warn', 'lead', 'rm', 'email']);
    const a = c.after!;
    for (const k of ['warn', 'lead', 'rm']) if (typeof a[k] !== 'number' || a[k] < 0) refuse('Enter whole days, 0 or more', 400);
    if (a.rm < a.lead) refuse('the manager should be told after the lead', 400);
  },
});

const esclog = reg('esclog', {}, { synthId: true });

const dep = reg('dep', {
  create: {
    roles: 'rm dir',
    what: 'only the Registered Manager or Director can set deputies',
    mine: ['by'],
    more: (_c, c) => void (c.after!.lead !== c.after!.dep || refuse('The deputy must be someone else', 400)),
  },
  steps: [{ roles: 'rm dir', what: 'not allowed', fields: ['ended'], more: (ctx, c) => void ((c.after!.ended && sameName((c.after!.ended as J).by, me(ctx)) && !c.before!.ended) || refuse('ended with your own name, once', 400)) }],
});

const compl = reg('compl', { create: { roles: GOV, what: 'not allowed', filled: ['text'] } });

const sgr = reg(
  'sgr',
  {
    create: { roles: GOV, what: 'not allowed', state: 'Raised internally', more: (_c, c) => void (PT.test(String(c.after!.pt)) || refuse('Use a patient reference like PT-4521 – never a name', 400)) },
    steps: [
      { to: 'Referred – awaiting outcome', from: ['Raised internally'], roles: GOV, what: 'not allowed', fields: ['to', 'ref', 'refOn'], filled: ['ref'] },
      { to: 'Closed – outcome received', roles: GOV, what: 'not allowed', fields: ['out'], filled: ['out'] },
      { roles: GOV, what: 'not allowed', fields: ['cqc'] },
    ],
  },
  { canRead: seeGov },
);

/** After the actions (act): a meeting decision or a continuity test can raise one. */
export const GOV_REGISTER_ADAPTERS: V36Adapter[] = [
  ntf, cmp, su, meet, fpp, brc, sar, bcp, bcpLog, loc, sop, ctr, vis, ret, esc, esclog, dep, compl, sgr,
];
