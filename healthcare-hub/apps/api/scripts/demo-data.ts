/* eslint-disable no-console */
// DEV-ONLY: `pnpm demo:data` with the API and mock OIDC running locally. Safe to re-run: it does
// nothing once the data is loaded. To start again, reset the database (see RUN_LOCALLY).
import { SEED_IDS } from '@hub/db/admin';
import type { Call } from './crew-demo-lib.js';
import { devToken, fetchPolitely } from './dev-token.js';
import { loadDemoData, type PutFile } from './demo-data-lib.js';
import { completeDemoRecords } from './demo-records-lib.js';

if (process.env.NODE_ENV === 'production') {
  console.error('demo-data must never run in production');
  process.exit(1);
}
const API = process.env.HUB_API_URL ?? `http://localhost:${process.env.API_PORT ?? 4000}`;
const OIDC = process.env.OIDC_ISSUER ?? 'http://localhost:4010';
if (!/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(`${API}/`)) {
  console.error('demo-data only runs against a local API');
  process.exit(1);
}

const call: Call = async (method, path, sub, body) => {
  const res = await fetchPolitely(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await devToken(OIDC, sub.replace('dev|', ''))}`,
      'x-org-id': SEED_IDS.orgExample,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
};

const putFile: PutFile = async (uploadUrl, bytes, mime) =>
  (
    await fetchPolitely(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': mime },
      body: Buffer.from(bytes),
    })
  ).status;

const r = await loadDemoData(call, { locationId: SEED_IDS.locWatford }, putFile);
if (r.alreadyLoaded) console.log('Demo data is already loaded: nothing to do.');
else console.log(JSON.stringify(r, null, 2));
if (r.problems.length > 0) process.exit(1);

// Every status rests on records and verified documents; safe to re-run.
const records = await completeDemoRecords(call, putFile);
console.log('Records and documents:', JSON.stringify(records, null, 2));
if (records.problems.length > 0) process.exit(1);
