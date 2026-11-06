// DEV-ONLY: books today's crew shift on AMB-01 with one offered job, through the public API (same
// gates and audit as a dispatcher), so the crew app and its Maestro flows have something to show.
// Synthetic data only. Used by scripts/crew-demo.ts and covered by test/crew-demo.test.ts.
import { londonDate } from '@hub/rules';

export type Call = (
  method: 'GET' | 'POST',
  path: string,
  sub: string,
  body?: unknown,
) => Promise<{ status: number; body: Record<string, unknown> }>;

export interface DemoIds {
  orgId: string;
  locationId: string;
  vehicleId: string;
  driverStaffId: string;
  assistantStaffId: string;
}

export interface DemoResult {
  shiftId: string | null;
  jobId: string | null;
  jobCode: string | null;
  allocated: boolean;
  /** Checks that blocked the allocation (e.g. a lapsed requirement on the seeded crew). */
  blockers: string[];
}

const H = 3_600_000;

export async function bookCrewDay(call: Call, ids: DemoIds, now = new Date()): Promise<DemoResult> {
  const at = (h: number) => new Date(now.getTime() + h * H).toISOString();
  // Wireframe 05 shows "Driving clearance: APPROVED": record a (synthetic) licence check for the
  // seeded driver the way the manager would, unless one is already on file.
  const lic = await call('GET', `/api/v1/staff/${ids.driverStaffId}/licences`, 'dev|manager');
  if (lic.status === 200 && ((lic.body.data as unknown[] | undefined) ?? []).length === 0)
    await call('POST', `/api/v1/staff/${ids.driverStaffId}/licences`, 'dev|manager', {
      data: {
        categories: ['B', 'C1'],
        photocardExpiry: '2032-01-01',
        lastCheckedOn: londonDate(now),
        checkMethod: 'DVLA_SHARE_CODE',
      },
    });
  const shift = await call('POST', '/api/v1/shifts', 'dev|dispatcher', {
    locationId: ids.locationId,
    vehicleId: ids.vehicleId,
    startsAt: at(0.25),
    endsAt: at(10),
    crew: [
      { staffId: ids.driverStaffId, role: 'DRIVER' },
      { staffId: ids.assistantStaffId, role: 'CARE_ASSISTANT' },
    ],
  });
  if (shift.status !== 201)
    return {
      shiftId: null,
      jobId: null,
      jobCode: null,
      allocated: false,
      blockers: [String(shift.body.detail ?? shift.status)],
    };
  const booking = await call('POST', '/api/v1/bookings', 'dev|dispatcher', {
    customer: 'Synthetic NHS Trust',
    patientContact: { name: 'Synthetic Patient', phone: '07700 900123' },
    job: {
      locationId: ids.locationId,
      pickupFrom: at(2),
      pickupTo: at(2.5),
      plannedStart: at(2),
      plannedEnd: at(3),
      pickupAddress: '1 Synthetic Road, London',
      destinationAddress: 'Synthetic General Hospital',
      accessNotes: 'Key safe at side door',
      patientRef: `DEMO-${now.getTime().toString(36).toUpperCase()}`,
      mobility: 'WALKING',
    },
  });
  const job = (booking.body.jobs as { id: string; code: string }[] | undefined)?.[0];
  if (!job)
    return {
      shiftId: shift.body.id as string,
      jobId: null,
      jobCode: null,
      allocated: false,
      blockers: ['BOOKING_FAILED'],
    };
  const alloc = await call('POST', `/api/v1/jobs/${job.id}/allocate`, 'dev|dispatcher', {
    shiftId: shift.body.id,
  });
  const base = { shiftId: shift.body.id as string, jobId: job.id, jobCode: job.code };
  if (alloc.status !== 201) {
    const checks = (alloc.body.checks as { code: string; result: string }[] | undefined) ?? [];
    return {
      ...base,
      allocated: false,
      blockers: checks.filter((c) => c.result === 'FAIL').map((c) => c.code),
    };
  }
  await call('POST', `/api/v1/jobs/${job.id}/offer`, 'dev|dispatcher');
  return { ...base, allocated: true, blockers: [] };
}
