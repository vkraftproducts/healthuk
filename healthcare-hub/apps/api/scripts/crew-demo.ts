/* eslint-disable no-console */
// DEV-ONLY: `pnpm --filter @hub/api demo:crew` with the API and mock OIDC running locally.
import { SEED_IDS } from '@hub/db/admin';
import { bookCrewDay, type Call } from './crew-demo-lib.js';

if (process.env.NODE_ENV === 'production') {
  console.error('crew-demo must never run in production');
  process.exit(1);
}
const API = process.env.HUB_API_URL ?? `http://localhost:${process.env.API_PORT ?? 4000}`;
const OIDC = process.env.OIDC_ISSUER ?? 'http://localhost:4010';

const call: Call = async (method, path, sub, body) => {
  const t = (await (await fetch(`${OIDC}/token?user=${sub.replace('dev|', '')}&mfa=1`)).json()) as {
    access_token: string;
  };
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${t.access_token}`,
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

const r = await bookCrewDay(call, {
  orgId: SEED_IDS.orgExample,
  locationId: SEED_IDS.locWatford,
  vehicleId: SEED_IDS.vehicleAmb1,
  driverStaffId: SEED_IDS.staffCrew,
  assistantStaffId: SEED_IDS.staffCrew2,
});
console.log(JSON.stringify(r, null, 2));
if (!r.allocated)
  console.log('The job was booked but not allocated: the crew app shows the gates that block it.');
