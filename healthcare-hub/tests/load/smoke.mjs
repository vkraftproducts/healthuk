// Local load check for NFR-02 (p95 < 2 s for dashboard and job actions), no dependencies.
// Usage: node tests/load/smoke.mjs [seconds=60] [concurrency=20]. Exits 1 if any p95 > 2 s.
import { call } from './lib.mjs';

const seconds = Number(process.argv[2] ?? 60);
const concurrency = Number(process.argv[3] ?? 20);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const jobs = (await call('dispatcher', 'GET', `/api/v1/jobs?date=${today}`)).body.data ?? [];
const SCENARIOS = {
  'dashboard summary': () => call('manager', 'GET', '/api/v1/dashboard/summary'),
  'dashboard actions': () => call('manager', 'GET', '/api/v1/dashboard/actions?tile=all'),
  'planner day': () => call('dispatcher', 'GET', `/api/v1/planner?date=${today}`),
  'jobs list': () => call('dispatcher', 'GET', `/api/v1/jobs?date=${today}`),
  'job detail': () =>
    call('dispatcher', 'GET', `/api/v1/jobs/${jobs[Math.floor(Math.random() * jobs.length)]?.id}`),
  'crew today': () => call('crew', 'GET', '/api/v1/crew/today'),
  'staff list': () => call('hr', 'GET', '/api/v1/staff'),
  'fleet list': () => call('fleet', 'GET', '/api/v1/vehicles'),
};
const names = Object.keys(SCENARIOS);
const samples = Object.fromEntries(names.map((n) => [n, []]));
const errors = Object.fromEntries(names.map((n) => [n, 0]));
const end = Date.now() + seconds * 1000;
await Promise.all(
  Array.from({ length: concurrency }, async (_, w) => {
    let i = w;
    while (Date.now() < end) {
      const n = names[i++ % names.length];
      const t = performance.now();
      const r = await SCENARIOS[n]();
      samples[n].push(performance.now() - t);
      if (r.status >= 400) errors[n] += 1;
    }
  }),
);
const pct = (a, p) =>
  a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
let fail = false;
console.log(
  `| Scenario | Requests | Errors | p50 ms | p95 ms | p99 ms |\n| --- | --- | --- | --- | --- | --- |`,
);
for (const n of names) {
  const s = samples[n];
  const p95 = pct(s, 95);
  if (p95 > 2000 || errors[n] > 0) fail = true;
  console.log(
    `| ${n} | ${s.length} | ${errors[n]} | ${pct(s, 50).toFixed(0)} | ${p95.toFixed(0)} | ${pct(s, 99).toFixed(0)} |`,
  );
}
process.exit(fail ? 1 : 0);
