import type pg from 'pg';
import { SEED_IDS, SEED_USERS } from './seed.js';

/**
 * Day-one starter configuration for the Exora demo organisation.
 * Adopts and publishes library requirements (four-eyes), maps them to roles,
 * attaches vehicle/equipment documents, seeds training courses and richer
 * audit templates, and adds stage demo records so every workflow can be shown.
 * Idempotent: safe to re-run with the base seed.
 */

// Literals (not SEED_IDS.*) so this module can load while seed.ts still initialises
// (seed.ts imports seedStarter — circular).
const ORG = '01900000-0000-7000-8000-000000000001';
const LOC = '01900000-0000-7000-8000-000000000011';

/** Fixed IDs so re-seeds stay stable. */
const SID = {
  defectRepaired: '01900000-0000-7000-8000-000000000322',
  supervisionBooked: '01900000-0000-7000-8000-000000000501',
  supervisionHeld: '01900000-0000-7000-8000-000000000502',
  supervisionMissed: '01900000-0000-7000-8000-000000000503',
  supervisionRecord: '01900000-0000-7000-8000-000000000504',
  vdiPass: '01900000-0000-7000-8000-000000000511',
  eventInvestigate: '01900000-0000-7000-8000-000000000521',
  cqcDraft: '01900000-0000-7000-8000-000000000531',
  drivingAssessTpl: '01900000-0000-7000-8000-000000000541',
  drivingAssessVer: '01900000-0000-7000-8000-000000000542',
} as const;

/** Staff library codes adopted and mapped per role. */
const ROLE_MAP: Record<string, string[]> = {
  DRIVER: [
    'AMB-STF-01',
    'AMB-STF-02',
    'AMB-STF-03',
    'AMB-STF-04',
    'AMB-STF-05',
    'AMB-STF-06',
    'AMB-STF-07',
    'AMB-STF-08',
    'AMB-STF-09',
    'AMB-DRV-01',
  ],
  CARE_ASSISTANT: [
    'AMB-STF-02',
    'AMB-STF-03',
    'AMB-STF-04',
    'AMB-STF-05',
    'AMB-STF-06',
    'AMB-STF-07',
    'AMB-STF-08',
    'AMB-STF-09',
  ],
  EMERGENCY_CARE_ASSISTANT: [
    'AMB-STF-02',
    'AMB-STF-03',
    'AMB-STF-04',
    'AMB-STF-05',
    'AMB-STF-06',
    'AMB-STF-07',
    'AMB-STF-08',
    'AMB-STF-09',
  ],
  TECHNICIAN: [
    'AMB-STF-02',
    'AMB-STF-03',
    'AMB-STF-04',
    'AMB-STF-05',
    'AMB-STF-06',
    'AMB-STF-07',
    'AMB-STF-08',
    'AMB-STF-09',
  ],
  PARAMEDIC: [
    'AMB-STF-02',
    'AMB-STF-03',
    'AMB-STF-04',
    'AMB-STF-05',
    'AMB-STF-06',
    'AMB-STF-07',
    'AMB-STF-08',
    'AMB-STF-09',
  ],
};

const VEHICLE_CODES = ['AMB-VEH-01', 'AMB-VEH-02', 'AMB-VEH-03'] as const;
const EQUIPMENT_CODES = ['AMB-EQ-01', 'AMB-EQ-02'] as const;
const ALL_ADOPT = [
  ...new Set([
    ...Object.values(ROLE_MAP).flat(),
    ...VEHICLE_CODES,
    ...EQUIPMENT_CODES,
    'AMB-STF-10',
    'AMB-STF-11',
  ]),
];

type Client = pg.Client;

async function adoptAndPublish(
  c: Client,
  code: string,
  mgr: string,
  gov: string,
): Promise<{ templateId: string; versionId: string } | null> {
  const existing = await c.query(
    `SELECT t.id AS template_id, v.id AS version_id
       FROM requirement_template t
       JOIN requirement_template_version v ON v.template_id = t.id
      WHERE t.organisation_id = $1 AND t.code = $2
      ORDER BY v.version DESC LIMIT 1`,
    [ORG, code],
  );
  if (existing.rowCount) {
    const row = existing.rows[0]!;
    // Ensure the latest draft/effective version is published by a second person.
    await c.query(
      `UPDATE requirement_template_version
          SET status = 'EFFECTIVE', approved_by = $2, approved_at = coalesce(approved_at, now()),
              effective_from = coalesce(effective_from, CURRENT_DATE), created_by = coalesce(created_by, $3)
        WHERE id = $1 AND status IN ('DRAFT', 'EFFECTIVE')`,
      [row.version_id, gov, mgr],
    );
    return { templateId: row.template_id, versionId: row.version_id };
  }

  const lib = await c.query(
    `SELECT t.id, t.pack, t.title, t.code,
            v.basis_type, v.regulation_ref, v.source_url, v.source_version_date,
            v.subject_type, v.applicability_rule, v.evidence_type, v.recurrence,
            v.warning_days, v.due_soon_days, v.blocking, v.deadline_kind,
            v.approval_role, v.framework_mappings
       FROM requirement_template t
       JOIN requirement_template_version v ON v.template_id = t.id
      WHERE t.organisation_id IS NULL AND t.code = $1
      ORDER BY v.version DESC LIMIT 1`,
    [code],
  );
  if (!lib.rowCount) return null;
  const L = lib.rows[0]!;

  const t = await c.query(
    `INSERT INTO requirement_template (organisation_id, pack, code, title, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [ORG, L.pack, L.code, L.title, mgr],
  );
  const templateId = t.rows[0]!.id as string;
  // pg may return json/jsonb as a string; re-stringify would double-encode.
  const asJson = (v: unknown, fallback: unknown) => {
    if (v == null) return fallback;
    if (typeof v === 'string') {
      try {
        return JSON.parse(v);
      } catch {
        return fallback;
      }
    }
    return v;
  };
  const v = await c.query(
    `INSERT INTO requirement_template_version
       (organisation_id, template_id, version, status, basis_type, regulation_ref, source_url,
        source_version_date, subject_type, applicability_rule, evidence_type, recurrence,
        warning_days, due_soon_days, blocking, deadline_kind, approval_role, framework_mappings,
        created_by, approved_by, approved_at, effective_from)
     VALUES ($1, $2, 1, 'EFFECTIVE', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb,
             $17, $18, now(), CURRENT_DATE)
     RETURNING id`,
    [
      ORG,
      templateId,
      L.basis_type,
      L.regulation_ref,
      L.source_url,
      L.source_version_date,
      L.subject_type,
      L.applicability_rule,
      L.evidence_type ?? 'DOCUMENT',
      L.recurrence,
      asJson(L.warning_days, [90, 60, 30, 14, 7]),
      L.due_soon_days ?? 30,
      L.blocking,
      L.deadline_kind,
      L.approval_role,
      JSON.stringify(asJson(L.framework_mappings, [])),
      mgr,
      gov,
    ],
  );
  return { templateId, versionId: v.rows[0]!.id as string };
}

/** Org-only driving assessment (not yet in the platform library). */
async function ensureDrivingAssessment(
  c: Client,
  mgr: string,
  gov: string,
): Promise<{ templateId: string; versionId: string }> {
  const existing = await c.query(
    `SELECT t.id AS template_id, v.id AS version_id
       FROM requirement_template t
       JOIN requirement_template_version v ON v.template_id = t.id
      WHERE t.organisation_id = $1 AND t.code = 'AMB-DRV-01'
      ORDER BY v.version DESC LIMIT 1`,
    [ORG],
  );
  if (existing.rowCount) {
    return {
      templateId: existing.rows[0]!.template_id,
      versionId: existing.rows[0]!.version_id,
    };
  }
  await c.query(
    `INSERT INTO requirement_template (id, organisation_id, pack, code, title, created_by)
     VALUES ($1, $2, 'CUSTOM', 'AMB-DRV-01', 'Driving assessment', $3)`,
    [SID.drivingAssessTpl, ORG, mgr],
  );
  await c.query(
    `INSERT INTO requirement_template_version
       (id, organisation_id, template_id, version, status, basis_type, regulation_ref,
        subject_type, applicability_rule, evidence_type, recurrence, blocking, deadline_kind,
        framework_mappings, created_by, approved_by, approved_at, effective_from)
     VALUES ($1, $2, $3, 1, 'EFFECTIVE', 'ORG_POLICY',
             'Local policy: practical driving assessment before unsupervised patient journeys',
             'STAFF', '{}', 'DOCUMENT',
             '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":3}}',
             'DEPLOYMENT_CRITICAL', 'DUE',
             '[{"framework":"CQC_SAF","domain":"SAFE"}]',
             $4, $5, now(), CURRENT_DATE)`,
    [SID.drivingAssessVer, ORG, SID.drivingAssessTpl, mgr, gov],
  );
  return { templateId: SID.drivingAssessTpl, versionId: SID.drivingAssessVer };
}

async function applyVehicleInstances(
  c: Client,
  code: string,
  templateId: string,
  versionId: string,
  actor: string,
): Promise<void> {
  const vehicles = await c.query(`SELECT id, base_location_id FROM vehicle WHERE organisation_id = $1`, [
    ORG,
  ]);
  for (const veh of vehicles.rows) {
    await c.query(
      `INSERT INTO requirement_instance
         (organisation_id, location_id, template_id, template_version_id, subject_type, subject_id,
          status, reason_code, reason_text, created_by)
       VALUES ($1, $2, $3, $4, 'VEHICLE', $5, 'GREY', 'MISSING', 'No verified evidence on record', $6)
       ON CONFLICT (organisation_id, template_id, subject_type, subject_id) DO NOTHING`,
      [ORG, veh.base_location_id, templateId, versionId, veh.id, actor],
    );
  }
  void code;
}

async function applyEquipmentInstances(
  c: Client,
  templateId: string,
  versionId: string,
  actor: string,
  regime: 'LOLER_THOROUGH' | 'SERVICE',
): Promise<void> {
  const assets = await c.query(
    `SELECT id, location_id FROM equipment_asset WHERE organisation_id = $1`,
    [ORG],
  );
  for (const a of assets.rows) {
    const ins = await c.query(
      `INSERT INTO requirement_instance
         (organisation_id, location_id, template_id, template_version_id, subject_type, subject_id,
          status, reason_code, reason_text, created_by)
       VALUES ($1, $2, $3, $4, 'EQUIPMENT', $5, 'GREY', 'MISSING', 'No verified evidence on record', $6)
       ON CONFLICT (organisation_id, template_id, subject_type, subject_id) DO NOTHING
       RETURNING id`,
      [ORG, a.location_id, templateId, versionId, a.id, actor],
    );
    if (!ins.rowCount) continue;
    await c.query(
      `INSERT INTO inspection_regime (organisation_id, asset_id, regime, requirement_instance_id, source, created_by)
       VALUES ($1, $2, $3, $4, 'Seeded starter regime', $5)
       ON CONFLICT (asset_id, regime) DO NOTHING`,
      [ORG, a.id, regime, ins.rows[0]!.id, actor],
    );
  }
}

async function startRoleChecks(
  c: Client,
  staffId: string,
  role: string,
  actor: string,
): Promise<void> {
  const maps = await c.query(
    `SELECT rr.template_id, v.id AS version_id
       FROM role_requirement rr
       JOIN requirement_template t ON t.id = rr.template_id
       JOIN requirement_template_version v ON v.template_id = t.id AND v.status = 'EFFECTIVE'
      WHERE rr.organisation_id = $1 AND rr.role = $2::staff_role`,
    [ORG, role],
  );
  for (const m of maps.rows) {
    await c.query(
      `INSERT INTO requirement_instance
         (organisation_id, location_id, template_id, template_version_id, subject_type, subject_id,
          owner_user_id, status, reason_code, reason_text, created_by)
       SELECT $1, s.primary_location_id, $3, $4, 'STAFF', $2, s.user_id,
              'GREY', 'MISSING', 'No verified evidence on record', $5
         FROM staff s WHERE s.id = $2
       ON CONFLICT (organisation_id, template_id, subject_type, subject_id) DO NOTHING`,
      [ORG, staffId, m.template_id, m.version_id, actor],
    );
  }
}

export async function seedStarter(c: Client): Promise<void> {
  const mgr = SEED_USERS.manager!.id;
  const gov = SEED_USERS.governance!.id;
  const hr = SEED_USERS.hr!.id;
  const fleet = SEED_USERS.fleet!.id;
  const crew = SEED_USERS.crew!.id;

  await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);

  // Library rows are visible when organisation_id IS NULL; adopt needs them present.
  const adopted = new Map<string, { templateId: string; versionId: string }>();
  for (const code of ALL_ADOPT) {
    if (code === 'AMB-DRV-01') {
      adopted.set(code, await ensureDrivingAssessment(c, mgr, gov));
      continue;
    }
    const r = await adoptAndPublish(c, code, mgr, gov);
    if (r) adopted.set(code, r);
  }

  // Role mappings.
  for (const [role, codes] of Object.entries(ROLE_MAP)) {
    for (const code of codes) {
      const a = adopted.get(code);
      if (!a) continue;
      await c.query(
        `INSERT INTO role_requirement (organisation_id, role, template_id, created_by)
         VALUES ($1, $2::staff_role, $3, $4)
         ON CONFLICT (organisation_id, role, template_id) DO NOTHING`,
        [ORG, role, a.templateId, mgr],
      );
    }
  }

  // Vehicle documents (auto-apply equivalents).
  for (const code of VEHICLE_CODES) {
    const a = adopted.get(code);
    if (a) await applyVehicleInstances(c, code, a.templateId, a.versionId, mgr);
  }

  // Equipment regimes on STR-0001.
  const loler = adopted.get('AMB-EQ-01');
  if (loler) await applyEquipmentInstances(c, loler.templateId, loler.versionId, fleet, 'LOLER_THOROUGH');
  const svc = adopted.get('AMB-EQ-02');
  if (svc) await applyEquipmentInstances(c, svc.templateId, svc.versionId, fleet, 'SERVICE');

  // Maintenance plans by date and mileage on each vehicle.
  for (const vid of [SEED_IDS.vehicleAmb1, SEED_IDS.vehicleAmb2, SEED_IDS.vehicleAmb3]) {
    await c.query(
      `INSERT INTO maintenance_plan
         (organisation_id, vehicle_id, title, interval_days, interval_miles, last_done_on,
          last_done_odometer, created_by)
       SELECT $1, $2, 'Scheduled service', 180, 10000, CURRENT_DATE - 60, 40000, $3
        WHERE NOT EXISTS (
          SELECT 1 FROM maintenance_plan WHERE organisation_id = $1 AND vehicle_id = $2 AND title = 'Scheduled service'
        )`,
      [ORG, vid, fleet],
    );
  }

  // Training course catalogue (group training / matrix).
  const courses: [string, string, number | null, boolean][] = [
    ['TR-MH', 'Moving and handling', 12, true],
    ['TR-BLS', 'Basic life support', 12, true],
    ['TR-SG', 'Safeguarding adults and children', 36, true],
    ['TR-IPC', 'Infection prevention and control', 12, false],
    ['TR-DRV', 'Driving assessment', 36, true],
    ['TR-IND', 'Induction', null, true],
  ];
  for (const [code, title, months, critical] of courses) {
    await c.query(
      `INSERT INTO training_course
         (organisation_id, code, title, interval_months, basis, basis_note, deployment_critical, created_by)
       VALUES ($1, $2, $3, $4, 'ORG_POLICY', 'Seeded starter course for the demo', $5, $6)
       ON CONFLICT (organisation_id, code) DO NOTHING`,
      [ORG, code, title, months, critical, hr],
    );
  }

  // Publish AC-01 / AC-02 (multi-control) and enrich AC-07 with a new published version.
  const multiControls: Record<string, object[]> = {
    'AC-01': [
      {
        code: 'AC-01-A',
        question: 'Identity, right to work and DBS evidence on file and verified',
        failureAction: 'Withhold deployment until clearance is complete',
        critical: true,
      },
      {
        code: 'AC-01-B',
        question: 'References and employment history complete with gap explanations',
        failureAction: 'HR suitability review before approval',
        critical: true,
      },
      {
        code: 'AC-01-C',
        question: 'Interview notes and contract evidence retained',
        failureAction: 'Complete the recruitment file before start date',
        critical: false,
      },
    ],
    'AC-02': [
      {
        code: 'AC-02-A',
        question: 'Induction signed off before unsupervised work',
        failureAction: 'Complete induction; restrict role until done',
        critical: true,
      },
      {
        code: 'AC-02-B',
        question: 'Role training matrix has no overdue or missing items',
        failureAction: 'Training plan with owner and target date',
        critical: true,
      },
      {
        code: 'AC-02-C',
        question: 'Observation or competency assessment recorded',
        failureAction: 'Schedule observation before next patient-facing shift',
        critical: false,
      },
    ],
    'AC-07': [
      {
        code: 'AC-07-A',
        question: 'Vehicle certificates (MOT, insurance, tax) current and verified',
        failureAction: 'Stop-use until statutory documents are current',
        critical: true,
      },
      {
        code: 'AC-07-B',
        question: 'Daily checks and pre-shift cleaning recorded for sampled shifts',
        failureAction: 'Investigate missed checks; coach crew; re-audit',
        critical: true,
      },
      {
        code: 'AC-07-C',
        question: 'Open defects have an owner and repair plan',
        failureAction: 'Assign Fleet lead; set review-by date',
        critical: false,
      },
      {
        code: 'AC-07-D',
        question: 'LOLER and equipment servicing regimes current',
        failureAction: 'Quarantine equipment until examination complete',
        critical: true,
      },
    ],
  };
  for (const [code, controls] of Object.entries(multiControls)) {
    const t = await c.query(
      `SELECT id FROM audit_template WHERE organisation_id = $1 AND code = $2`,
      [ORG, code],
    );
    if (!t.rowCount) continue;
    const templateId = t.rows[0]!.id as string;
    await c.query(`UPDATE audit_template SET active = true WHERE id = $1`, [templateId]);
    const ver = await c.query(
      `SELECT id, status, version, controls FROM audit_template_version
        WHERE template_id = $1 ORDER BY version DESC LIMIT 1`,
      [templateId],
    );
    if (!ver.rowCount) continue;
    const v = ver.rows[0]!;
    const current = v.controls as unknown[];
    if (Array.isArray(current) && current.length >= controls.length && v.status === 'PUBLISHED')
      continue;
    if (v.status === 'DRAFT') {
      await c.query(
        `UPDATE audit_template_version
            SET controls = $3, sample_size = $4, status = 'PUBLISHED',
                approved_by = $2, approved_at = now()
          WHERE id = $1 AND status = 'DRAFT'`,
        [v.id, gov, JSON.stringify(controls), controls.length],
      );
    } else if (Array.isArray(current) && current.length < controls.length) {
      await c.query(
        `UPDATE audit_template_version SET status = 'RETIRED'
          WHERE id = $1 AND status = 'PUBLISHED'`,
        [v.id],
      );
      await c.query(
        `INSERT INTO audit_template_version
           (organisation_id, template_id, version, status, controls, sample_method, sample_size,
            methods, approved_by, approved_at)
         VALUES ($1, $2, $3, 'PUBLISHED', $4,
                 'Configurable starting point; record population and selection method',
                 $5, '{RECORDS,OBSERVATION,INTERVIEW}', $6, now())`,
        [ORG, templateId, (v.version as number) + 1, JSON.stringify(controls), controls.length, gov],
      );
    }
  }

  // Alex Morgan: C1 licence so ambulance readiness matches the Driver approval.
  const hasLic = await c.query(
    `SELECT 1 FROM staff_record
      WHERE organisation_id = $1 AND staff_id = $2 AND kind = 'LICENCE'
        AND NOT EXISTS (SELECT 1 FROM staff_record s2 WHERE s2.supersedes_id = staff_record.id)
      LIMIT 1`,
    [ORG, SEED_IDS.staffCrew],
  );
  if (!hasLic.rowCount) {
    const expiry = new Date(Date.now() + 900 * 86_400_000).toISOString().slice(0, 10);
    await c.query(
      `INSERT INTO staff_record (organisation_id, staff_id, kind, data, valid_from, valid_to, created_by)
       VALUES ($1, $2, 'LICENCE', $3::jsonb, CURRENT_DATE - 400, $4::date, $5)`,
      [
        ORG,
        SEED_IDS.staffCrew,
        JSON.stringify({
          categories: ['B', 'C1'],
          restrictionCodes: [],
          photocardExpiry: expiry,
          lastCheckedOn: new Date().toISOString().slice(0, 10),
          checkMethod: 'MANUAL',
          penaltyPoints: 0,
          licenceNumber: 'MORGA901234AB5CD',
        }),
        expiry,
        hr,
      ],
    );
  }

  // Jordan Reed: start CARE_ASSISTANT checks so Overview shows awaiting evidence.
  await startRoleChecks(c, SEED_IDS.staffCandidate, 'CARE_ASSISTANT', hr);

  // Chase log for onboarding: reference requested/chased, DBS applied.
  await c.query(
    `INSERT INTO staff_chase_log
       (id, organisation_id, staff_id, kind, subject, requested_on, chased_on, note, created_by)
     VALUES
       ('01900000-0000-7000-8000-000000000551', $1, $2, 'REFERENCE', 'Employer reference – previous care home',
        CURRENT_DATE - 14, CURRENT_DATE - 7, 'Chased by phone; awaiting reply', $3),
       ('01900000-0000-7000-8000-000000000552', $1, $2, 'DBS', 'Enhanced DBS with barred list',
        CURRENT_DATE - 10, NULL, 'Application submitted online', $3)
     ON CONFLICT (id) DO NOTHING`,
    [ORG, SEED_IDS.staffCandidate, hr],
  );

  // Supervision bookings: booked, held, missed.
  await c.query(
    `INSERT INTO supervision_booking
       (id, organisation_id, staff_id, supervisor_user_id, scheduled_at, kind, topics, status, booked_by)
     VALUES ($1, $2, $3, $4, now() + interval '7 days', 'ONE_TO_ONE', 'Wellbeing and rota', 'BOOKED', $5)
     ON CONFLICT (id) DO NOTHING`,
    [SID.supervisionBooked, ORG, SEED_IDS.staffCrew, hr, hr],
  );
  // HELD bookings require record_id at insert (supervision_booking check constraint).
  const held = await c.query(`SELECT 1 FROM staff_record WHERE id = $1`, [SID.supervisionRecord]);
  if (!held.rowCount) {
    await c.query(
      `INSERT INTO staff_record (id, organisation_id, staff_id, kind, data, created_by)
       VALUES ($1, $2, $3, 'SUPERVISION', $4::jsonb, $5)`,
      [
        SID.supervisionRecord,
        ORG,
        SEED_IDS.staffCrew2,
        JSON.stringify({
          attendance: 'HELD',
          summary: 'Discussed patient handling technique. Actions agreed.',
          wellbeing: 'No concerns raised',
          nextDue: new Date(Date.now() + 56 * 86_400_000).toISOString().slice(0, 10),
        }),
        hr,
      ],
    );
  }
  await c.query(
    `INSERT INTO supervision_booking
       (id, organisation_id, staff_id, supervisor_user_id, scheduled_at, kind, topics, status,
        record_id, booked_by, closed_by)
     VALUES ($1, $2, $3, $4, now() - interval '14 days', 'CLINICAL', 'Patient handling', 'HELD',
             $5, $6, $6)
     ON CONFLICT (id) DO NOTHING`,
    [SID.supervisionHeld, ORG, SEED_IDS.staffCrew2, hr, SID.supervisionRecord, hr],
  );
  await c.query(
    `INSERT INTO supervision_booking
       (id, organisation_id, staff_id, supervisor_user_id, scheduled_at, kind, topics, status,
        status_reason, booked_by, closed_by)
     VALUES ($1, $2, $3, $4, now() - interval '21 days', 'PROBATION_REVIEW', 'Probation mid-point',
             'MISSED', 'Crew unavailable – sickness', $5, $5)
     ON CONFLICT (id) DO NOTHING`,
    [SID.supervisionMissed, ORG, SEED_IDS.staffCandidate, hr, hr],
  );

  // Submitted daily check on AMB-01 (pass) so the Inspections tab is not empty.
  const vdiIns = await c.query(
    `INSERT INTO vdi
       (id, organisation_id, vehicle_id, template_id, checker_user_id, odometer, outcome,
        client_submission_id, captured_at, received_at)
     VALUES ($1, $2, $3, $4, $5, 42050, 'PASS', $1, now() - interval '1 day', now() - interval '1 day')
     ON CONFLICT (id) DO NOTHING`,
    [SID.vdiPass, ORG, SEED_IDS.vehicleAmb1, SEED_IDS.vdiTemplate, crew],
  );
  if (vdiIns.rowCount) {
    const items = [
      ['TYRES', true],
      ['LIGHTS', true],
      ['BRAKES', true],
      ['FLUIDS', false],
      ['RESTRAINTS', true],
      ['RAMP_LIFT', true],
      ['ACCESSIBILITY', false],
      ['SAFETY_KIT', true],
      ['CLINICAL_KIT', true],
    ] as const;
    for (const [code, critical] of items) {
      await c.query(
        `INSERT INTO vdi_item_result (organisation_id, vdi_id, item_code, critical, result)
         VALUES ($1, $2, $3, $4, 'PASS')
         ON CONFLICT (vdi_id, item_code) DO NOTHING`,
        [ORG, SID.vdiPass, code, critical],
      );
    }
  }

  // Second defect on AMB-01: repaired, awaiting return-to-service sign-off.
  await c.query(
    `INSERT INTO defect
       (id, organisation_id, vehicle_id, severity, stop_use, description, status, reported_by,
        discovered_at, repaired_by, repaired_at, repair_notes)
     VALUES ($1, $2, $3, 'MAJOR', false,
             'Nearside indicator intermittent – bulb replaced and retested',
             'REPAIRED', $4, now() - interval '5 days', $5, now() - interval '1 day',
             'Replaced nearside indicator bulb. Road test pass. Awaiting return-to-service sign-off.')
     ON CONFLICT (id) DO NOTHING`,
    [SID.defectRepaired, ORG, SEED_IDS.vehicleAmb1, crew, fleet],
  );

  // Incident mid-investigation (synthetic). Candour recorded as a separate assessment row.
  const ev = await c.query(
    `INSERT INTO event
       (id, organisation_id, code, types, title, description, occurred_at, discovered_at, place,
        status, severity, still_at_risk, nhs_funded, lead_user_id, reported_by, created_by,
        location_id, category, priority, protection_steps, triaged_at, triaged_by)
     VALUES ($1, $2, 'EVT-101', '{INCIDENT}', 'Patient slip during transfer',
             'Patient slipped while transferring from wheelchair to vehicle seat. Referenced by booking only.',
             now() - interval '3 days', now() - interval '3 days', 'London station bay 2',
             'INVESTIGATE', 'MODERATE', false, true, $3, $4, $4, $5,
             'PATIENT_CARE', 'HIGH', 'Transfer paused; patient checked and seated safely.',
             now() - interval '2 days', $3)
     ON CONFLICT (id) DO NOTHING`,
    [SID.eventInvestigate, ORG, gov, crew, LOC],
  );
  if (ev.rowCount) {
    await c.query(
      `INSERT INTO event_transition (organisation_id, event_id, from_status, to_status, note, by_user_id)
       VALUES
         ($1, $2, NULL, 'TRIAGE', 'Reported', $3),
         ($1, $2, 'TRIAGE', 'PROTECT', 'Triage complete', $4),
         ($1, $2, 'PROTECT', 'ASSESS', 'Made safe', $4),
         ($1, $2, 'ASSESS', 'INVESTIGATE', 'Reporting duties assessed', $4)`,
      [ORG, SID.eventInvestigate, crew, gov],
    );
    await c.query(
      `INSERT INTO candour_assessment (organisation_id, event_id, notifiable, reason, decided_by, decided_at)
       VALUES ($1, $2, true,
               'Moderate harm on NHS-funded care – duty of candour applies (synthetic demo).',
               $3, now() - interval '2 days')`,
      [ORG, SID.eventInvestigate, mgr],
    );
  }

  // CQC notification draft ready for review.
  await c.query(
    `INSERT INTO cqc_notification
       (id, organisation_id, code, kind, event_id, occurred_on, due_on, summary, status, prepared_by)
     VALUES ($1, $2, 'CQC-101', 'SERIOUS_INJURY', $3, CURRENT_DATE - 3, CURRENT_DATE - 2,
             'Draft CQC notification for synthetic demo event EVT-101. Not submitted.',
             'DRAFT', $4)
     ON CONFLICT (id) DO NOTHING`,
    [SID.cqcDraft, ORG, SID.eventInvestigate, gov],
  );

  await c.query(
    `INSERT INTO org_counter (organisation_id, prefix, value)
     VALUES ($1, 'EVT', 101), ($1, 'CQC', 101)
     ON CONFLICT (organisation_id, prefix)
     DO UPDATE SET value = GREATEST(org_counter.value, EXCLUDED.value)`,
    [ORG],
  );

  // Owners on open defects (Fleet lead) plus a review-by date.
  await c.query(
    `UPDATE defect SET owner_user_id = coalesce(owner_user_id, $2),
            review_by = coalesce(review_by, discovered_at::date + CASE severity
              WHEN 'CRITICAL' THEN 3 WHEN 'MAJOR' THEN 7 ELSE 14 END)
      WHERE organisation_id = $1 AND status <> 'RELEASED'`,
    [ORG, fleet],
  );
}
