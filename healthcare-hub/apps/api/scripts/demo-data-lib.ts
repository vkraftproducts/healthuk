// DEV-ONLY: loads a realistic working day for the seeded organisation through the public API, so
// every status, gate and audit event comes from the real rules, and any open screen updates live.
// Dates are relative to today. Synthetic data only (CLAUDE.md #10). Used by scripts/demo-data.ts
// and covered by test/demo-data.test.ts.
import { londonDate } from '@hub/rules';
import type { Call } from './crew-demo-lib.js';

export interface DemoDataIds {
  locationId: string;
}
/** Sends file bytes to a signed upload URL (the API's own upload endpoint). */
export type PutFile = (uploadUrl: string, bytes: Uint8Array, mime: string) => Promise<number>;
export interface DemoDataResult {
  alreadyLoaded: boolean;
  created: Record<string, number>;
  jobsAllocated: number;
  /** Jobs the allocation gates refused, with why: expected on a realistic day, not failures. */
  jobsRefused: string[];
  /** Anything the API refused that it should have accepted. Empty on a clean run. */
  problems: string[];
}

const H = 3_600_000;
const MANAGER = 'dev|manager';
const HR = 'dev|hr';
const FLEET = 'dev|fleet';
const GOVERNANCE = 'dev|governance';
const DISPATCHER = 'dev|dispatcher';

/** Marks the data set as loaded: the first demo staff number. */
const MARKER = 'ST-1001';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ACTIVE_STAFF = [
  {
    no: 'ST-1001',
    name: 'Priya Shah',
    title: 'Ambulance driver',
    roles: ['DRIVER', 'CARE_ASSISTANT'],
  },
  {
    no: 'ST-1002',
    name: 'Tom Walsh',
    title: 'Ambulance driver',
    roles: ['DRIVER', 'CARE_ASSISTANT'],
  },
  { no: 'ST-1003', name: 'Aisha Khan', title: 'Care assistant', roles: ['CARE_ASSISTANT'] },
  { no: 'ST-1004', name: 'Ben Carter', title: 'Care assistant', roles: ['CARE_ASSISTANT'] },
  {
    no: 'ST-1005',
    name: 'Maria Lopez',
    title: 'Senior crew lead',
    roles: ['DRIVER', 'CARE_ASSISTANT'],
  },
  {
    no: 'ST-1006',
    name: 'Callum Reid',
    title: 'Ambulance driver',
    roles: ['DRIVER', 'CARE_ASSISTANT'],
  },
  { no: 'ST-1007', name: 'Ngozi Eze', title: 'Care assistant', roles: ['CARE_ASSISTANT'] },
];
/** Joiners part way through checks: nothing approved, some evidence awaiting review. */
const JOINERS = [
  {
    no: 'ST-1008',
    name: 'Ella Hughes',
    title: 'Care assistant',
    role: 'CARE_ASSISTANT',
    uploaded: 0,
  },
  { no: 'ST-1009', name: 'Owen Price', title: 'Ambulance driver', role: 'DRIVER', uploaded: 2 },
  { no: 'ST-1010', name: 'Zara Malik', title: 'Care assistant', role: null, uploaded: 0 },
];
/** Ambulances are over 3,500 kg, so they need C1 (finding 89); the rest stay category B. */
const AMBULANCE = { type: 'AMBULANCE', seats: 3, wheelchairs: 1, category: 'C1', kg: 4250 };
const VEHICLES: {
  callsign: string;
  registration: string;
  type: string;
  seats: number;
  wheelchairs: number;
  category?: string;
  kg?: number;
}[] = [
  { callsign: 'AMB-04', registration: 'MB24AAA', ...AMBULANCE },
  { callsign: 'AMB-05', registration: 'MB24AAB', ...AMBULANCE },
  { callsign: 'AMB-06', registration: 'MB23AAC', ...AMBULANCE },
  { callsign: 'PTS-01', registration: 'MB23AAD', type: 'PTS_VEHICLE', seats: 6, wheelchairs: 2 },
  { callsign: 'PTS-02', registration: 'MB22AAE', type: 'PTS_VEHICLE', seats: 6, wheelchairs: 2 },
  { callsign: 'WAV-01', registration: 'MB22AAF', type: 'WAV', seats: 4, wheelchairs: 1 },
];
/**
 * A synthetic evidence file. Past deadlines get none and stay red; ones in the future get evidence
 * that a second person verifies, because only verified evidence can turn anything green or amber.
 */
const EVIDENCE_FILE = new TextEncoder().encode(
  ['%PDF-1.4', '% SYNTHETIC DEMO DOCUMENT - not a real certificate', '%%EOF', ''].join(
    String.fromCharCode(10),
  ),
);
/**
 * What each role needs before approval (ambulance pack, Reg 19 / Schedule 3). Demo staff go
 * through the real gate: checks started, synthetic evidence uploaded and verified by a second
 * person, then approved.
 */
const ROLE_REQUIREMENTS: Record<string, string[]> = {
  DRIVER: ['AMB-STF-01', 'AMB-STF-02', 'AMB-STF-03', 'AMB-STF-04', 'AMB-STF-09'],
  CARE_ASSISTANT: ['AMB-STF-02', 'AMB-STF-03', 'AMB-STF-04', 'AMB-STF-09'],
};
/** Evidence uploaded but deliberately never verified: stays "awaiting review". */
const LEFT_UNVERIFIED = new Set(['ST-1006', 'AMB-PRM-03']);
/** Days from today until each subject's deadline: some past, some close, most comfortable. */
const STAFF_DEADLINES: [string, string, number][] = [
  ['ST-1007', 'AMB-STF-06', -12],
  ['ST-1007', 'AMB-STF-07', -3],
  ['ST-1006', 'AMB-STF-06', 9],
  ['ST-1005', 'AMB-STF-08', 21],
  ['ST-1004', 'AMB-STF-07', 27],
  ['ST-1003', 'AMB-STF-06', 75],
  ['ST-1002', 'AMB-STF-08', 160],
  ['ST-1001', 'AMB-STF-06', 240],
];
const VEHICLE_DEADLINES: [string, string, number][] = [
  ['AMB-06', 'AMB-VEH-01', -2],
  ['WAV-01', 'AMB-VEH-03', 12],
  ['AMB-04', 'AMB-VEH-01', 140],
  ['PTS-02', 'AMB-VEH-01', 200],
  // Publishing tax applies it to every vehicle; the two on today's shifts need it verified.
  ['AMB-04', 'AMB-VEH-03', 180],
  ['PTS-02', 'AMB-VEH-03', 250],
];
const PREMISES_DEADLINES: [string, number][] = [
  ['AMB-PRM-02', -6],
  ['AMB-PRM-01', 18],
  ['AMB-PRM-03', 150],
];
const PREMISES_ITEMS = [
  {
    area: 'FIRE',
    title: 'Fire alarm weekly test – station call points',
    source: 'Fire risk assessment (synthetic), weekly',
  },
  {
    area: 'WATER',
    title: 'Legionella flushing of little-used outlets',
    source: 'Water risk assessment (synthetic), weekly',
  },
  {
    area: 'OXYGEN',
    title: 'Medical gas cylinder store inspection',
    source: 'Medical gases policy (synthetic), monthly',
  },
];
const JOBS = [
  { from: 1, mobility: 'WALKING', to: 'Synthetic General Outpatients', ref: 'RENAL', crew: 0 },
  { from: 3, mobility: 'WALKING', to: 'Hemel Urgent Treatment Centre', ref: 'CLINIC', crew: 0 },
  { from: 5, mobility: 'WALKING', to: 'St Albans Eye Unit', ref: 'EYE', crew: 0 },
  { from: 1.5, mobility: 'WALKING', to: 'Mount Vernon Cancer Centre', ref: 'ONC', crew: 1 },
  { from: 4, mobility: 'WALKING', to: 'Synthetic General Discharge Lounge', ref: 'DISCH', crew: 1 },
  { from: 5, mobility: 'WHEELCHAIR', to: 'Harefield Hospital', ref: 'CARD', crew: null },
  { from: 6, mobility: 'STRETCHER', to: 'Northwick Park Hospital', ref: 'XFER', crew: null },
  { from: 7, mobility: 'WALKING', to: 'Luton and Dunstable Hospital', ref: 'ORTH', crew: null },
];
const RISKS = [
  {
    hazard: 'Moving and handling injury when using the stair chair',
    peopleAffected: 'Crew and patients',
    inherent: [4, 4],
    controls: 'Annual competence check, two-person lift rule, equipment servicing schedule',
    residual: [2, 3],
    reviewIn: 30,
  },
  {
    hazard: 'Cross-infection between patients through inadequately cleaned vehicles',
    peopleAffected: 'Patients and crew',
    inherent: [3, 5],
    controls: 'Pre-shift cleaning record, deep clean rota, monthly IPC audit',
    residual: [2, 4],
    reviewIn: -5,
  },
  {
    hazard: 'Lone working on late shifts at unfamiliar addresses',
    peopleAffected: 'Crew',
    inherent: [3, 4],
    controls: 'Two-person crews by default, dispatcher check-in calls, access notes on every job',
    residual: [2, 3],
    reviewIn: 90,
  },
];
const EVENTS = [
  {
    types: ['NEAR_MISS'],
    title: 'Wheelchair clamp found loose before departure',
    description: 'Crew noticed a loose clamp during the pre-journey check. Refitted before moving.',
    severity: 'NO_HARM',
    daysAgo: 1,
    themes: ['equipment'],
  },
  {
    types: ['INCIDENT'],
    title: 'Minor collision with bollard in hospital car park',
    description:
      'Low-speed contact with a bollard while reversing. No patient on board, no injury.',
    severity: 'LOW',
    daysAgo: 4,
    themes: ['driving'],
  },
  {
    types: ['COMPLAINT'],
    title: 'Late collection after renal clinic',
    description: 'Service user waited longer than agreed for the return journey from clinic.',
    severity: 'NO_HARM',
    daysAgo: 6,
    themes: ['timeliness'],
    complaint: { channel: 'PHONE', consentToShare: true },
  },
];

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 24 * H).toISOString().slice(0, 10);
}

export async function loadDemoData(
  call: Call,
  ids: DemoDataIds,
  putFile: PutFile,
  now = new Date(),
): Promise<DemoDataResult> {
  const today = londonDate(now);
  const at = (h: number) => new Date(now.getTime() + h * H).toISOString();
  const result: DemoDataResult = {
    alreadyLoaded: false,
    created: {},
    jobsAllocated: 0,
    jobsRefused: [],
    problems: [],
  };
  const count = (what: string) => {
    result.created[what] = (result.created[what] ?? 0) + 1;
  };
  /** Sends a write; records anything refused rather than stopping half way through a load. */
  const post = async (what: string, path: string, sub: string, body?: unknown) => {
    const r = await call('POST', path, sub, body);
    if (r.status >= 300) {
      result.problems.push(`${what}: ${r.status} ${String(r.body.detail ?? r.body.code ?? '')}`);
      return null;
    }
    return r.body as Row;
  };

  const existing = await call('GET', `/api/v1/staff?q=${MARKER}`, MANAGER);
  if (((existing.body.data as Row[] | undefined) ?? []).length > 0)
    return { ...result, alreadyLoaded: true };

  const users = ((await call('GET', '/api/v1/admin/users', MANAGER)).body.data ?? []) as Row[];
  const userId = (email: string) => users.find((u) => u.email === email)?.id as string | undefined;
  const managerId = userId('manager@example.test');
  const governanceId = userId('governance@example.test');
  if (!managerId || !governanceId) {
    result.problems.push('Seeded users not found: run pnpm db:seed first');
    return result;
  }

  // ---- requirements ---------------------------------------------------------------------------
  const templates = ((await call('GET', '/api/v1/requirements/templates', MANAGER)).body.data ??
    []) as Row[];
  /**
   * Requirements come from the shared library: the organisation adopts a template and a second
   * person publishes it (four-eyes), exactly as the rules demand of a real organisation.
   */
  const adoptions = new Map<string, { templateId: string; deadlineKind: string } | null>();
  const adopt = async (code: string) => {
    if (adoptions.has(code)) return adoptions.get(code) ?? null;
    const library = templates.find((x) => x.code === code);
    let outcome: { templateId: string; deadlineKind: string } | null = null;
    if (!library) result.problems.push(`requirement template ${code} is not in the library`);
    else {
      const copy = await post(
        `adopt ${code}`,
        `/api/v1/requirements/templates/${library.id}/adopt`,
        MANAGER,
      );
      const draft = (copy?.versions as Row[] | undefined)?.[0];
      if (copy && draft) {
        const published = await post(
          `publish ${code}`,
          `/api/v1/requirements/templates/${copy.id}/versions/${draft.id}/publish`,
          GOVERNANCE,
        );
        if (published)
          outcome = { templateId: copy.id as string, deadlineKind: draft.deadlineKind as string };
      }
    }
    adoptions.set(code, outcome);
    return outcome;
  };
  const addEvidence = async (
    instanceId: string,
    label: string,
    validTo: string,
    verified: boolean,
  ) => {
    const upload = await post(`evidence for ${label}`, '/api/v1/evidence/uploads', MANAGER, {
      title: `Synthetic demo certificate for ${label}`,
      mime: 'application/pdf',
      sizeBytes: EVIDENCE_FILE.length,
      requirementInstanceIds: [instanceId],
      validFrom: addDays(today, -60),
      validTo,
    });
    if (!upload) return;
    const put = await putFile(upload.uploadUrl as string, EVIDENCE_FILE, 'application/pdf');
    if (put >= 300) {
      result.problems.push(`evidence file for ${label}: ${put}`);
      return;
    }
    const version = upload.evidenceVersionId as string;
    await post(`complete evidence ${label}`, `/api/v1/evidence/${version}/complete`, MANAGER);
    count('evidence');
    if (verified)
      await post(`verify evidence ${label}`, `/api/v1/evidence/${version}/verify`, GOVERNANCE, {
        decision: 'ACCEPTED',
        confirmedValidTo: validTo,
      });
  };
  // ---- staff ----------------------------------------------------------------------------------
  const staffIds = new Map<string, string>();
  const addStaff = async (s: { no: string; name: string; title: string }) => {
    const created = await post(`staff ${s.no}`, '/api/v1/staff', MANAGER, {
      staffNo: s.no,
      displayName: s.name,
      primaryLocationId: ids.locationId,
      jobTitle: s.title,
    });
    if (created) {
      staffIds.set(s.no, created.id as string);
      count('staff');
    }
    return created;
  };
  const move = (id: string, to: string) =>
    post(`staff move to ${to}`, `/api/v1/staff/${id}/transition`, HR, {
      to,
      reason: `Moved to ${to}`,
    });
  // Role requirements: adopt, publish (second person) and map to roles before anyone is approved.
  for (const [role, codes] of Object.entries(ROLE_REQUIREMENTS))
    for (const code of codes) {
      const adopted = await adopt(code);
      if (adopted)
        await post(`map ${code} to ${role}`, '/api/v1/staff/role-requirements', MANAGER, {
          role,
          templateId: adopted.templateId,
        });
    }
  const startChecks = async (id: string, role: string) =>
    ((await post(`start ${role} checks`, `/api/v1/staff/${id}/role-checks`, HR, { role }))
      ?.blockers ?? []) as Row[];
  const evidenceYears = addDays(today, 3 * 365);
  const hrId = userId('hr@example.test') ?? managerId;
  /** Synthetic Schedule 3 staff file (reg 19): regulated roles cannot be approved without it. */
  const schedule3File = async (id: string, no: string) => {
    const records: [string, Row][] = [
      [
        'right-to-work',
        { method: 'MANUAL_DOCUMENT', checkedOn: addDays(today, -90), checkerUserId: hrId },
      ],
      [
        'dbs',
        {
          eligibility: 'ENHANCED_BARRED',
          barredListChecked: true,
          certificateNumber: '001234567890',
          issueDate: addDays(today, -80),
          updateServiceConsent: true,
          riskDecision: 'CLEAR',
          policyReviewDate: addDays(today, 3 * 365),
        },
      ],
      ...['First', 'Second'].map((n): [string, Row] => [
        'references',
        {
          refereeName: `${n} synthetic referee`,
          refereeOrganisation: 'Synthetic Care Ltd',
          relationship: 'Former line manager',
          requestedOn: addDays(today, -100),
          receivedOn: addDays(today, -95),
          outcome: 'SATISFACTORY',
        },
      ]),
      [
        'employment-history',
        { employer: 'Synthetic Care Ltd', role: 'Care assistant', from: addDays(today, -3000) },
      ],
      [
        'training',
        { courseCode: 'CARE-CERT', title: 'Care Certificate', completedOn: addDays(today, -85) },
      ],
      ['oh-clearance', { fitStatus: 'FIT', assessedOn: addDays(today, -85) }],
    ];
    for (const [slug, data] of records)
      await post(`${slug} ${no}`, `/api/v1/staff/${id}/${slug}`, HR, { data });
  };
  for (const s of ACTIVE_STAFF) {
    const created = await addStaff(s);
    if (!created) continue;
    const id = created.id as string;
    await move(id, 'CHECKS_IN_PROGRESS');
    for (const role of s.roles)
      for (const b of await startChecks(id, role))
        await addEvidence(b.instanceId as string, `${b.code} ${s.no}`, evidenceYears, true);
    await move(id, 'READY_FOR_REVIEW');
    await schedule3File(id, s.no);
    for (const role of s.roles)
      await post(`approve ${role}`, `/api/v1/staff/${id}/role-approvals`, HR, {
        role,
        reason: 'All checks verified',
      });
    await move(id, 'APPROVED_FOR_ROLE');
    await move(id, 'ACTIVE');
    if (s.roles.includes('DRIVER'))
      await post(`licence ${s.no}`, `/api/v1/staff/${id}/licences`, MANAGER, {
        data: {
          categories: ['B', 'C1'],
          photocardExpiry: addDays(today, 900),
          lastCheckedOn: today,
          checkMethod: 'DVLA_SHARE_CODE',
        },
      });
  }
  for (const j of JOINERS) {
    const created = await addStaff(j);
    if (!created || !j.role) continue;
    const blockers = await startChecks(created.id as string, j.role);
    for (const b of blockers.slice(0, j.uploaded))
      await addEvidence(b.instanceId as string, `${b.code} ${j.no}`, evidenceYears, false);
  }

  // ---- vehicles -------------------------------------------------------------------------------
  const vehicleIds = new Map<string, string>();
  for (const v of VEHICLES) {
    const created = await post(`vehicle ${v.callsign}`, '/api/v1/vehicles', FLEET, {
      registration: v.registration,
      callsign: v.callsign,
      type: v.type,
      baseLocationId: ids.locationId,
      seats: v.seats,
      wheelchairCapacity: v.wheelchairs,
      ...(v.category ? { licenceCategory: v.category } : {}),
      ...(v.kg ? { grossWeightKg: v.kg } : {}),
    });
    if (created) {
      vehicleIds.set(v.callsign, created.id as string);
      count('vehicles');
    }
  }
  const stopUse = vehicleIds.get('AMB-05');
  if (
    stopUse &&
    (await post('stop-use defect', '/api/v1/defects', FLEET, {
      vehicleId: stopUse,
      severity: 'CRITICAL',
      stopUse: true,
      description: 'Tail lift will not stay locked in the raised position',
      discoveredAt: at(-20),
    }))
  )
    count('defects');
  const major = vehicleIds.get('PTS-01');
  if (
    major &&
    (await post('major defect', '/api/v1/defects', FLEET, {
      vehicleId: major,
      severity: 'MAJOR',
      description: 'Rear saloon heater intermittently cuts out',
      discoveredAt: at(-30),
    }))
  )
    count('defects');
  const offRoad = vehicleIds.get('WAV-01');
  if (offRoad)
    await post('off-road vehicle', `/api/v1/vehicles/${offRoad}/off-road`, FLEET, {
      on: true,
      reason: 'Booked in for bodywork repair',
    });

  const addRequirement = async (
    code: string,
    subjectType: string,
    subjectId: string | undefined,
    inDays: number,
    label: string,
  ) => {
    const adopted = await adopt(code);
    if (!adopted) return;
    const { templateId, deadlineKind } = adopted;
    if (!subjectId) return;
    const date = addDays(today, inDays);
    const field =
      deadlineKind === 'EXPIRY'
        ? 'expiryDate'
        : deadlineKind === 'REVIEW'
          ? 'reviewDate'
          : 'dueDate';
    // Publishing applies auto-applied templates (MOT, insurance, tax) to every vehicle (A5).
    const applied = (
      ((
        await call(
          'GET',
          `/api/v1/requirements/instances?subjectType=${subjectType}&subjectId=${subjectId}&limit=100`,
          MANAGER,
        )
      ).body.data ?? []) as Row[]
    ).find((i) => i.templateId === templateId);
    const instance =
      applied ??
      (await post(`requirement ${code}`, '/api/v1/requirements/instances', MANAGER, {
        templateId,
        subjectType,
        subjectId,
        locationId: ids.locationId,
        ownerUserId: managerId,
        [field]: date,
      }));
    if (!instance) return;
    count('requirements');
    if (inDays > 0)
      await addEvidence(
        instance.id as string,
        `${code} ${label}`,
        date,
        !LEFT_UNVERIFIED.has(label),
      );
  };
  for (const [no, code, inDays] of STAFF_DEADLINES)
    await addRequirement(code, 'STAFF', staffIds.get(no), inDays, no);
  for (const [callsign, code, inDays] of VEHICLE_DEADLINES)
    await addRequirement(code, 'VEHICLE', vehicleIds.get(callsign), inDays, callsign);
  for (const [code, inDays] of PREMISES_DEADLINES)
    await addRequirement(code, 'PREMISES', ids.locationId, inDays, code);
  // Premises register entries (finding 24). No schedule is linked, so none shows as met.
  for (const p of PREMISES_ITEMS)
    if (
      await post(`premises ${p.title}`, '/api/v1/premises-items', MANAGER, {
        locationId: ids.locationId,
        controlArea: p.area,
        title: p.title,
        responsibleUserId: governanceId,
        frequencySource: p.source,
      })
    )
      count('premises');

  // ---- today's work ---------------------------------------------------------------------------
  const shiftOn = async (callsign: string, driver: string, assistant: string) => {
    const vehicleId = vehicleIds.get(callsign);
    const driverId = staffIds.get(driver);
    const assistantId = staffIds.get(assistant);
    if (!vehicleId || !driverId || !assistantId) return null;
    const shift = await post(`shift on ${callsign}`, '/api/v1/shifts', DISPATCHER, {
      locationId: ids.locationId,
      vehicleId,
      startsAt: at(0.25),
      endsAt: at(10),
      crew: [
        { staffId: driverId, role: 'DRIVER' },
        { staffId: assistantId, role: 'CARE_ASSISTANT' },
      ],
    });
    if (shift) count('shifts');
    return (shift?.id as string | undefined) ?? null;
  };
  const shifts = [
    await shiftOn('AMB-04', 'ST-1001', 'ST-1003'),
    await shiftOn('PTS-02', 'ST-1002', 'ST-1004'),
  ];
  for (const [i, j] of JOBS.entries()) {
    const booking = await post(`booking ${j.ref}`, '/api/v1/bookings', DISPATCHER, {
      customer: i % 2 === 0 ? 'Synthetic NHS Trust' : 'Synthetic Integrated Care Board',
      patientContact: { name: 'Synthetic Patient', phone: '07700 900123' },
      job: {
        locationId: ids.locationId,
        pickupFrom: at(j.from),
        pickupTo: at(j.from + 0.5),
        plannedStart: at(j.from),
        plannedEnd: at(j.from + 1),
        pickupAddress: `${10 + i} Synthetic Road, London`,
        destinationAddress: j.to,
        patientRef: `DEMO-${j.ref}-${now.getTime().toString(36).toUpperCase()}`,
        mobility: j.mobility,
        ...(j.mobility === 'STRETCHER' ? { weightKg: 80 } : {}),
      },
    });
    const job = (booking?.jobs as Row[] | undefined)?.[0];
    if (!job) continue;
    count('jobs');
    const shiftId = j.crew === null ? null : shifts[j.crew];
    if (!shiftId) continue; // left for the dispatcher to allocate
    const alloc = await call('POST', `/api/v1/jobs/${job.id}/allocate`, DISPATCHER, { shiftId });
    if (alloc.status === 201) {
      await post(`offer ${j.ref}`, `/api/v1/jobs/${job.id}/offer`, DISPATCHER);
      result.jobsAllocated += 1;
    } else {
      const failed = ((alloc.body.checks as Row[] | undefined) ?? [])
        .filter((c) => c.result === 'FAIL')
        .map((c) => c.code);
      result.jobsRefused.push(`${j.ref}: ${failed.join(', ') || String(alloc.body.code)}`);
    }
  }

  // ---- governance -----------------------------------------------------------------------------
  for (const r of RISKS)
    if (
      await post('risk', '/api/v1/risks', GOVERNANCE, {
        hazard: r.hazard,
        peopleAffected: r.peopleAffected,
        inherentLikelihood: r.inherent[0],
        inherentImpact: r.inherent[1],
        controls: r.controls,
        residualLikelihood: r.residual[0],
        residualImpact: r.residual[1],
        ownerUserId: governanceId,
        reviewDate: addDays(today, r.reviewIn),
        locationId: ids.locationId,
      })
    )
      count('risks');
  for (const e of EVENTS) {
    const occurred = at(-24 * e.daysAgo);
    if (
      await post(`event ${e.title}`, '/api/v1/events', GOVERNANCE, {
        types: e.types,
        title: e.title,
        description: e.description,
        occurredAt: occurred,
        locationId: ids.locationId,
        severity: e.severity,
        leadUserId: governanceId,
        themes: e.themes,
        ...(e.complaint
          ? { complaint: { ...e.complaint, receivedOn: addDays(today, -e.daysAgo) } }
          : {}),
      })
    )
      count('events');
  }
  return result;
}
