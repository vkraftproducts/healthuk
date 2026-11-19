// v36 governance collections connected in part 3 (step 2, 19 Nov 2026), each in its own table
// (register-lib.ts) or as one value of v36_value:
//  - cqA (CQC self-audit answers, '0-4' → P/A/F/N/''): cqSet, governance or a manager.
//  - cqSub (null or {by, on}): cqSub, governance or a manager, once every question is answered.
//  - dspt ({year, due, last, lastOut, assert: [[title, done]]}): dsptOk marks one assertion in
//    place (governance or a manager); nothing else changes from v36.
//  - fft ([[month, responses, % good]]): fftNew adds or replaces a month (governance or a manager).
//  - kpi ([[month, journeys, on time %, aborted, average return wait]]), kpiT ({ontime, aborts,
//    wait}) and guardian (a name): no v36 button changes them (read-only here).
//  - cmpT ({ack, resp}): v36 always copies it from the complaint rules (RV('cmpAck'),
//    RV('cmpResp')), so it is read from those rules (S.rules, table org_rule); ruleOk changes the
//    rules and with them cmpT.
import { CQC_SELF_AUDIT } from '@hub/contracts';
import {
  me,
  need,
  readOnly,
  refuse,
  register,
  sameName,
  single,
  type J,
} from './register-lib.js';
import type { V36Adapter } from './types.js';

const MONTH = /^\d{4}-\d{2}$/;
const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

// ---- cqA / cqSub ------------------------------------------------------------------------------
const cqA = register({
  key: 'cqA',
  shape: 'map',
  scalar: true,
  table: 'v36_cqc_answer',
  fields: [],
  order: "split_part(code, '-', 1)::int, split_part(code, '-', 2)::int",
  check(ctx, c) {
    need(ctx, 'gov rm dir', 'only governance or a manager');
    if (!/^[0-3]-\d{1,2}$/.test(c.id)) refuse(`Not a self-audit question: ${c.id}`, 400);
    if (!['P', 'A', 'F', 'N'].includes(c.after as unknown as string)) refuse('Mark Pass, Partial, Fail or N/A', 400);
  },
});

/** Questions per key area (Safe, Effective, Caring, Responsive), as v36's CQ list. */
const QUESTIONS: number[] = CQC_SELF_AUDIT.map((a) => a.questions.length);

const cqSub = single({
  key: 'cqSub',
  async check(ctx, _before, after, tx) {
    need(ctx, 'gov rm dir', 'not allowed');
    const a = after as J | null;
    if (!a || typeof a !== 'object') refuse('A submitted self-audit stays submitted');
    const rows = await tx.$queryRaw<{ code: string; value: unknown }[]>`SELECT code, value FROM v36_cqc_answer`;
    const v = new Map(rows.map((r) => [r.code, r.value]));
    let un = 0;
    QUESTIONS.forEach((n, i) => {
      for (let j = 0; j < n; j++) if (!['P', 'A', 'F', 'N'].includes(v.get(`${i}-${j}`) as string)) un++;
    });
    if (un) refuse(`${un} question${un > 1 ? 's are' : ' is'} still unanswered – answer or mark N/A first`);
    if (!sameName(a.by, me(ctx))) refuse('The self-audit is submitted in your own name', 400);
    if (typeof a.on !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(a.on)) refuse('Give the time of submission', 400);
  },
});

// ---- dspt -------------------------------------------------------------------------------------
const dspt = single({
  key: 'dspt',
  check(ctx, before, after) {
    need(ctx, 'gov rm dir', 'not allowed');
    const b = before as J | null;
    const a = after as J | null;
    const { assert: ba, ...brest } = b ?? {};
    const { assert: aa, ...arest } = a ?? {};
    const ok =
      b &&
      a &&
      JSON.stringify(brest) === JSON.stringify(arest) &&
      Array.isArray(ba) &&
      Array.isArray(aa) &&
      ba.length === aa.length &&
      aa.every((x: J, i: number) => {
        const y = ba[i] as J;
        return Array.isArray(x) && x.length === 2 && x[0] === y[0] && (x[1] === y[1] || (y[1] === false && x[1] === true));
      });
    if (!ok) refuse('Only marking an assertion’s evidence as in place is done here', 400);
  },
});

// ---- fft / kpi --------------------------------------------------------------------------------
const fft = register({
  key: 'fft',
  shape: 'list',
  idField: '0',
  tuple: true,
  table: 'v36_fft_month',
  order: 'code',
  fields: [
    { f: '0', col: 'month' },
    { f: '1', col: 'responses', k: 'num' },
    { f: '2', col: 'pct_good', k: 'num' },
  ],
  check(ctx, c) {
    need(ctx, 'gov rm dir', 'not allowed');
    if (c.isDel) refuse('FFT results are kept', 403);
    const a = c.after as unknown as unknown[];
    if (!Array.isArray(a) || a.length !== 3 || typeof a[0] !== 'string' || !MONTH.test(a[0]) || a[0] !== c.id)
      refuse('Give the month as YYYY-MM', 400);
    if (!num(a[1], 0, 1e6) || !Number.isInteger(a[1])) refuse('Responses must be a whole number', 400);
    if (!num(a[2], 0, 100)) refuse('% good or very good must be between 0 and 100', 400);
  },
});

const kpi = readOnly(
  register({
    key: 'kpi',
    shape: 'list',
    idField: '0',
    tuple: true,
    table: 'v36_kpi_month',
    order: 'code',
    fields: [
      { f: '0', col: 'month' },
      { f: '1', col: 'journeys', k: 'num' },
      { f: '2', col: 'on_time_pct', k: 'num' },
      { f: '3', col: 'aborted', k: 'num' },
      { f: '4', col: 'avg_wait', k: 'num' },
    ],
  }),
);
const kpiT = single({ key: 'kpiT', initial: { ontime: 90, aborts: 1, wait: 30 } });
const guardian = single({ key: 'guardian' });

// ---- cmpT -------------------------------------------------------------------------------------
const cmpT: V36Adapter = {
  key: 'cmpT',
  shape: 'value',
  load: (ctx) =>
    ctx.tx(async (tx) => {
      const r = await tx.$queryRaw<{ code: string; value: unknown }[]>`
        SELECT code, value FROM org_rule WHERE code IN ('cmpAck', 'cmpResp')`;
      const v = (k: string, d: number) => {
        const x = r.find((y) => y.code === k)?.value;
        return typeof x === 'number' ? x : d;
      };
      return { ack: v('cmpAck', 3), resp: v('cmpResp', 20) };
    }),
  // ruleOk (Registered Manager or Director) copies the approved complaint rules into cmpT; the
  // rules themselves are saved by the rules collection, and cmpT is read back from them.
  async apply(ctx, ch) {
    need(ctx, 'rm dir', 'not allowed');
    const a = ch.after as J | null;
    if (!a || !num(a.ack, 0, 365) || !num(a.resp, 0, 365)) refuse('Complaint targets are days', 400);
  },
};

export const GOV_VALUE_ADAPTERS: V36Adapter[] = [cqA, cqSub, dspt, fft, kpi, kpiT, guardian, cmpT];
