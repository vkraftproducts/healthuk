// Seeds the NFR-02 pilot profile through the public API (synthetic): 100 staff and 50 vehicles
// via CSV import, and 500 journeys for today. Usage: node tests/load/seed-pilot.mjs
import { call } from './lib.mjs';

const loc = 'Watford';
const run = Date.now().toString().slice(-4);
const staff = ['Staff No,Display Name,Location,Job title'];
for (let i = 0; i < 100; i++)
  staff.push(
    `ST-${run}${String(i).padStart(2, '0')},Synthetic Load ${i},${loc},Ambulance care assistant`,
  );
const vehicles = ['Registration,Callsign,Type,Location,Seats,Wheelchair capacity'];
const L = 'ABCDEFGHJKLMNPRSTUVWXYZ';
// Current UK format (two letters, two digits, three letters), synthetic.
const reg = (i) =>
  `LD${run.slice(-2)}${L[Math.floor(i / 23) % 23]}${L[i % 23]}${L[(Number(run) + i) % 23]}`;
for (let i = 0; i < 50; i++) vehicles.push(`${reg(i)},LD-${run}-${i},PTS vehicle,${loc},4,1`);
for (const [kind, csv] of [
  ['STAFF', staff],
  ['VEHICLES', vehicles],
]) {
  const p = await call('manager', 'POST', '/api/v1/imports', {
    kind,
    filename: `${kind}.csv`,
    csv: csv.join('\n'),
  });
  const c = await call('manager', 'POST', `/api/v1/imports/${p.body.id}/commit`);
  console.log(kind, c.body.status, c.body.importedCount);
}
const locs = (
  await call(
    'manager',
    'GET',
    '/api/v1/organisations/01900000-0000-7000-8000-000000000001/locations',
  )
).body.data;
const locationId = locs.find((l) => l.name === loc).id;
const day = new Date();
let ok = 0;
const target = Number(process.env.JOURNEYS ?? 500);
for (let i = 0; i < target; i++) {
  const start = new Date(day.getTime() + (1 + (i % 12)) * 3_600_000 + (i % 7) * 60_000);
  const at = (m) => new Date(start.getTime() + m * 60_000).toISOString();
  const book = () =>
    call('dispatcher', 'POST', '/api/v1/bookings', {
      customer: 'Synthetic NHS Trust',
      patientContact: { name: `Synthetic Patient ${i}`, phone: '07700 900123' },
      job: {
        locationId,
        pickupFrom: at(0),
        pickupTo: at(30),
        plannedStart: at(0),
        plannedEnd: at(60),
        pickupAddress: `${i} Synthetic Road, Watford`,
        destinationAddress: 'Synthetic General Hospital',
        patientRef: `LD${run}${i}`,
        mobility: i % 3 === 0 ? 'WHEELCHAIR' : 'WALKING',
      },
    });
  let r = await book();
  // The API rate-limits each user (300/min): wait and retry rather than skip.
  while (r.status === 429) {
    await new Promise((res) => setTimeout(res, 15_000));
    r = await book();
  }
  if (r.status === 201) ok += 1;
}
console.log('journeys', ok);
