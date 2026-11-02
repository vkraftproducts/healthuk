// k6 load test at the NFR-02 pilot profile, for staging (k6 is not run in the build environment).
//   k6 run -e HUB_API_URL=https://api.staging... -e TOKEN_MANAGER=... -e TOKEN_DISPATCHER=... \
//          -e TOKEN_CREW=... -e HUB_ORG_ID=... tests/load/pilot.js
// Staging must run with RATE_LIMIT_PER_MINUTE raised for the test window only.
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    office: { executor: 'constant-vus', vus: 15, duration: '10m', exec: 'office' },
    crews: { executor: 'constant-vus', vus: 25, duration: '10m', exec: 'crew' },
  },
  thresholds: {
    'http_req_duration{kind:dashboard}': ['p(95)<2000'],
    'http_req_duration{kind:job}': ['p(95)<2000'],
    http_req_failed: ['rate<0.01'],
  },
};
const API = __ENV.HUB_API_URL;
const headers = (t) => ({
  headers: { authorization: `Bearer ${t}`, 'x-org-id': __ENV.HUB_ORG_ID },
});
const today = () => new Date().toISOString().slice(0, 10);

export function office() {
  const m = headers(__ENV.TOKEN_MANAGER);
  const d = headers(__ENV.TOKEN_DISPATCHER);
  check(http.get(`${API}/api/v1/dashboard/summary`, { ...m, tags: { kind: 'dashboard' } }), {
    ok: (r) => r.status === 200,
  });
  check(
    http.get(`${API}/api/v1/dashboard/actions?tile=all`, { ...m, tags: { kind: 'dashboard' } }),
    { ok: (r) => r.status === 200 },
  );
  const jobs = http.get(`${API}/api/v1/jobs?date=${today()}`, { ...d, tags: { kind: 'job' } });
  check(jobs, { ok: (r) => r.status === 200 });
  check(http.get(`${API}/api/v1/planner?date=${today()}`, { ...d, tags: { kind: 'job' } }), {
    ok: (r) => r.status === 200,
  });
  sleep(3);
}

export function crew() {
  check(
    http.get(`${API}/api/v1/crew/today`, { ...headers(__ENV.TOKEN_CREW), tags: { kind: 'job' } }),
    { ok: (r) => r.status === 200 },
  );
  sleep(10);
}
