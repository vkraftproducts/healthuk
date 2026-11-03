import pg from 'pg';

// Synthetic data only (CLAUDE.md #10). Matches the wireframes: "Meadowbank Patient Transport / Watford"
// plus a second organisation used by isolation tests. Fixed IDs make the seed idempotent.
// Runs as the migrator role; sets the org context itself because RLS is FORCEd.
// Requires migrations (which sync the system roles) to have run first.

export const SEED_IDS = {
  orgExample: '01900000-0000-7000-8000-000000000001',
  orgOther: '01900000-0000-7000-8000-000000000002',
  locWatford: '01900000-0000-7000-8000-000000000011',
  locOther: '01900000-0000-7000-8000-000000000012',
  staffCrew: '01900000-0000-7000-8000-000000000201',
  staffCrew2: '01900000-0000-7000-8000-000000000202',
  staffCandidate: '01900000-0000-7000-8000-000000000203',
  vehicleAmb1: '01900000-0000-7000-8000-000000000301',
  vehicleAmb2: '01900000-0000-7000-8000-000000000302',
  vehicleAmb3: '01900000-0000-7000-8000-000000000303',
  vdiTemplate: '01900000-0000-7000-8000-000000000311',
  defectAmb3: '01900000-0000-7000-8000-000000000321',
  auditRun102: '01900000-0000-7000-8000-000000000401',
  auditRun103: '01900000-0000-7000-8000-000000000402',
  findingAc07: '01900000-0000-7000-8000-000000000411',
  action218: '01900000-0000-7000-8000-000000000421',
  action219: '01900000-0000-7000-8000-000000000422',
} as const;

/** Starter audit controls from the development spec §14 (seeded INACTIVE pending approval). */
export const STARTER_CONTROLS: [string, string, string, string, string][] = [
  [
    'AC-01',
    'Recruitment',
    'WELL_LED',
    'Selected staff IDs; references verified, employment history, identity, DBS/eligibility, interview and contract evidence. Record concerns and resolution.',
    'HR suitability review; withhold deployment where clearance is incomplete.',
  ],
  [
    'AC-02',
    'Induction and competence',
    'EFFECTIVE',
    'Induction approval, observation, role matrix gaps, appraisal learning needs and a staff knowledge interview.',
    'Training/competence plan with owner and target date; role restriction if needed.',
  ],
  [
    'AC-03',
    'Supervision and meetings',
    'WELL_LED',
    'Planned versus actual sessions, quality of notes, actions from previous sessions and last three meeting minutes.',
    'Escalate missed sessions; follow actions through to evidence of completion.',
  ],
  [
    'AC-04',
    'Safeguarding',
    'SAFE',
    'Referral trail, protective action, agency contacts, outcomes, staff understanding and notification decision.',
    'Immediate safeguarding escalation, restricted case record and follow-up.',
  ],
  [
    'AC-05',
    'Complaints and incidents',
    'RESPONSIVE',
    'Accessible complaints route, recognition, investigation, response, delays and changes arising from learning.',
    'Response/escalation tasks; verify changes and recheck recurring themes.',
  ],
  [
    'AC-06',
    'Medicines',
    'SAFE',
    'Applicable stock/storage/disposal controls, MAR gaps, PRN documentation and competence.',
    'Clinical review of errors and unsafe storage; quarantine affected stock as directed.',
  ],
  [
    'AC-07',
    'Premises and equipment',
    'SAFE',
    'Certificates, risk assessments, check logs, defects, emergency contacts and maintenance evidence.',
    'Competent-person review and stop-use controls where unsafe.',
  ],
  [
    'AC-08',
    'Plans and risks',
    'SAFE',
    'Needs assessment, person involvement, matched staff skills, current controls, changes and review outcomes.',
    'Review the care/transport plan before the next relevant service.',
  ],
  [
    'AC-09',
    'Dignity and involvement',
    'CARING',
    'Accessible information, choices, meaningful involvement, feedback and observed practice.',
    'Agree improvements with the person and record resulting changes.',
  ],
  [
    'AC-10',
    'Health and nutrition',
    'EFFECTIVE',
    'In-scope health plan, monitoring, professional involvement and individual nutrition support.',
    'Refer to an appropriate clinical lead; track the response.',
  ],
  [
    'AC-11',
    'Governance',
    'WELL_LED',
    'Current policies, acknowledgements, safe rota, confidentiality and financial safeguards.',
    'Management action and independent verification of financial discrepancies.',
  ],
];

interface SeedUser {
  id: string;
  subject: string;
  email: string;
  name: string;
  org: string;
  role: string;
}

const u = (n: number) => `01900000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`;
export const SEED_USERS: Record<string, SeedUser> = {
  manager: {
    id: u(1),
    subject: 'dev|manager',
    email: 'manager@example.test',
    name: 'Manager',
    org: SEED_IDS.orgExample,
    role: 'REGISTERED_MANAGER',
  },
  hr: {
    id: u(2),
    subject: 'dev|hr',
    email: 'hr@example.test',
    name: 'Hana Rowe',
    org: SEED_IDS.orgExample,
    role: 'HR_LEAD',
  },
  dispatcher: {
    id: u(3),
    subject: 'dev|dispatcher',
    email: 'dispatcher@example.test',
    name: 'Dispatcher',
    org: SEED_IDS.orgExample,
    role: 'DISPATCHER',
  },
  fleet: {
    id: u(4),
    subject: 'dev|fleet',
    email: 'fleet@example.test',
    name: 'Finn Lee',
    org: SEED_IDS.orgExample,
    role: 'FLEET_LEAD',
  },
  governance: {
    id: u(5),
    subject: 'dev|governance',
    email: 'governance@example.test',
    name: 'Gina Ode',
    org: SEED_IDS.orgExample,
    role: 'GOVERNANCE_LEAD',
  },
  crew: {
    id: u(7),
    subject: 'dev|crew',
    email: 'crew@example.test',
    name: 'Alex Morgan',
    org: SEED_IDS.orgExample,
    role: 'CREW',
  },
  crew2: {
    id: u(8),
    subject: 'dev|crew2',
    email: 'crew2@example.test',
    name: 'Sam Taylor',
    org: SEED_IDS.orgExample,
    role: 'CREW',
  },
  auditor: {
    id: u(9),
    subject: 'dev|auditor',
    email: 'auditor@example.test',
    name: 'Audrey Ward',
    org: SEED_IDS.orgExample,
    role: 'AUDITOR',
  },
  otherManager: {
    id: u(21),
    subject: 'dev|other-manager',
    email: 'other.manager@example.test',
    name: 'Other Manager',
    org: SEED_IDS.orgOther,
    role: 'REGISTERED_MANAGER',
  },
  otherCrew: {
    id: u(22),
    subject: 'dev|other-crew',
    email: 'other.crew@example.test',
    name: 'Other Crew',
    org: SEED_IDS.orgOther,
    role: 'CREW',
  },
};

export const SEED_SUPPORT = {
  id: u(10),
  subject: 'dev|support',
  email: 'support@example.test',
  name: 'Platform Support',
} as const;

export async function seed(adminUrl: string): Promise<void> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    const ctx = (org: string) => c.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
    const orgs: [string, string, string[], string, string, boolean][] = [
      [
        SEED_IDS.orgExample,
        'Meadowbank Patient Transport',
        ['ambulance'],
        SEED_IDS.locWatford,
        'Watford',
        true,
      ],
      [SEED_IDS.orgOther, 'Other organisation', [], SEED_IDS.locOther, 'Elsewhere', false],
    ];
    for (const [id, name, packs, loc, locName, registered] of orgs) {
      await ctx(id);
      await c.query(
        `INSERT INTO organisation (id, name, sector_packs) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
        [id, name, packs],
      );
      await c.query(
        `INSERT INTO location (id, organisation_id, name, registered) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [loc, id, locName, registered],
      );
      for (const user of Object.values(SEED_USERS).filter((x) => x.org === id)) {
        await c.query(
          `INSERT INTO app_user (id, idp_subject, email, display_name, status) VALUES ($1, $2, $3, $4, 'ACTIVE')
           ON CONFLICT (id) DO NOTHING`,
          [user.id, user.subject, user.email, user.name],
        );
        const role = await c.query(
          `SELECT id FROM role WHERE organisation_id IS NULL AND key = $1`,
          [user.role],
        );
        if (!role.rowCount)
          throw new Error(`System role ${user.role} missing: run migrations first`);
        // Backdated a day: on Windows the database runs in Docker's VM, whose clock can drift ahead
        // of the PC's; a membership "starting in the future" would lock the dev user out.
        await c.query(
          `INSERT INTO membership (organisation_id, user_id, role_id, valid_from)
           SELECT $1, $2, $3, now() - interval '1 day'
            WHERE NOT EXISTS (SELECT 1 FROM membership WHERE organisation_id = $1 AND user_id = $2)`,
          [id, user.id, role.rows[0].id],
        );
        // Re-running the seed repairs memberships created by earlier seeds with a drifted clock.
        await c.query(
          `UPDATE membership SET valid_from = now() - interval '1 day'
            WHERE organisation_id = $1 AND user_id = $2 AND valid_to IS NULL
              AND valid_from > now() - interval '1 day'`,
          [id, user.id],
        );
      }
      await c.query(
        `INSERT INTO service_type (organisation_id, code, name) VALUES ($1, 'PTS', 'Patient transport service')
         ON CONFLICT DO NOTHING`,
        [id],
      );
    }
    // Synthetic staff (wireframe 02). Crew users are linked to their staff records for self-service.
    await ctx(SEED_IDS.orgExample);
    const staff: [string, string, string | null, string, string, string, string[]][] = [
      [
        SEED_IDS.staffCrew,
        'ST-0042',
        SEED_USERS.crew!.id,
        SEED_USERS.crew!.name,
        'ACTIVE',
        'Ambulance care assistant',
        ['DRIVER', 'CARE_ASSISTANT'],
      ],
      [
        SEED_IDS.staffCrew2,
        'ST-0043',
        SEED_USERS.crew2!.id,
        SEED_USERS.crew2!.name,
        'ACTIVE',
        'Ambulance care assistant',
        ['CARE_ASSISTANT'],
      ],
      [
        SEED_IDS.staffCandidate,
        'ST-0051',
        null,
        'Jordan Reed',
        'CHECKS_IN_PROGRESS',
        'Trainee care assistant',
        [],
      ],
    ];
    for (const [id, no, userId, name, state, title, roles] of staff) {
      const ins = await c.query(
        `INSERT INTO staff (id, organisation_id, staff_no, user_id, display_name, lifecycle_state, primary_location_id, job_title)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
        [id, SEED_IDS.orgExample, no, userId, name, state, SEED_IDS.locWatford, title],
      );
      if (!ins.rowCount) continue;
      await c.query(
        `INSERT INTO staff_lifecycle_event (organisation_id, staff_id, from_state, to_state, reason, actor_user_id)
         VALUES ($1, $2, NULL, $3, 'Seeded synthetic record', $4)`,
        [SEED_IDS.orgExample, id, state, SEED_USERS.manager!.id],
      );
      for (const role of roles)
        await c.query(
          `INSERT INTO staff_role_approval (organisation_id, staff_id, role, reason, approved_by)
           VALUES ($1, $2, $3, 'Seeded synthetic approval', $4)`,
          [SEED_IDS.orgExample, id, role, SEED_USERS.manager!.id],
        );
    }
    // Synthetic fleet (wireframes 04/05): three vehicles, a fitted stretcher, a daily checklist.
    const vehicles: [string, string, string, string, number, number, boolean][] = [
      [SEED_IDS.vehicleAmb1, 'AMB-01', 'SY21ABC', 'AMBULANCE', 4, 1, true],
      [SEED_IDS.vehicleAmb2, 'AMB-02', 'SY21ABD', 'PTS_VEHICLE', 6, 2, false],
      [SEED_IDS.vehicleAmb3, 'AMB-03', 'SY22XYZ', 'WAV', 4, 1, true],
    ];
    for (const [id, callsign, reg, type, seats, wc, stretcher] of vehicles) {
      const ins = await c.query(
        `INSERT INTO vehicle (id, organisation_id, registration, callsign, type, base_location_id, seats, wheelchair_capacity, stretcher, licence_category, current_odometer)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'B', 42000) ON CONFLICT (id) DO NOTHING`,
        [id, SEED_IDS.orgExample, reg, callsign, type, SEED_IDS.locWatford, seats, wc, stretcher],
      );
      if (ins.rowCount)
        await c.query(
          `INSERT INTO vehicle_location_history (organisation_id, vehicle_id, location_id, reason, moved_by)
           VALUES ($1, $2, $3, 'Seeded synthetic vehicle', $4)`,
          [SEED_IDS.orgExample, id, SEED_IDS.locWatford, SEED_USERS.manager!.id],
        );
    }
    await c.query(
      `INSERT INTO equipment_asset (organisation_id, asset_tag, category, model, swl_kg, vehicle_id, capability)
       VALUES ($1, 'STR-0001', 'STRETCHER', 'Synthetic stretcher', 227, $2, 'STRETCHER') ON CONFLICT DO NOTHING`,
      [SEED_IDS.orgExample, SEED_IDS.vehicleAmb3],
    );
    await c.query(
      `INSERT INTO vdi_template (id, organisation_id, name, version, items) VALUES ($1, $2, 'Daily vehicle inspection', 1, $3)
       ON CONFLICT (id) DO NOTHING`,
      [
        SEED_IDS.vdiTemplate,
        SEED_IDS.orgExample,
        JSON.stringify([
          { code: 'TYRES', label: 'Tyres and wheels', critical: true },
          { code: 'LIGHTS', label: 'Lights and indicators', critical: true },
          { code: 'BRAKES', label: 'Brakes', critical: true },
          { code: 'FLUIDS', label: 'Fluid levels', critical: false },
          { code: 'RESTRAINTS', label: 'Seat belts and restraints', critical: true },
          { code: 'RAMP_LIFT', label: 'Ramp or tail lift', critical: true },
          { code: 'ACCESSIBILITY', label: 'Accessibility kit', critical: false },
          { code: 'SAFETY_KIT', label: 'Fire extinguisher and safety kit', critical: true },
          { code: 'CLINICAL_KIT', label: 'Clinical kit and oxygen', critical: true },
        ]),
      ],
    );
    // Starter audit controls: inactive drafts awaiting management approval. AC-07 is approved and
    // active here so the wireframe 03 example (AUD-102) can be shown.
    const gov = SEED_USERS.governance!.id;
    const mgr = SEED_USERS.manager!.id;
    for (const [code, title, domain, evidence, failure] of STARTER_CONTROLS) {
      const ac07 = code === 'AC-07';
      const t = await c.query(
        `INSERT INTO audit_template (organisation_id, code, title, domain, source_ref, active)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (organisation_id, code) DO NOTHING RETURNING id`,
        [
          SEED_IDS.orgExample,
          code,
          title,
          domain,
          'Auditors Guidance Notes Nov 23 (development spec §14)',
          ac07,
        ],
      );
      if (!t.rowCount) continue;
      await c.query(
        `INSERT INTO audit_template_version (organisation_id, template_id, version, status, controls, sample_method, sample_size, methods, approved_by, approved_at)
         VALUES ($1, $2, 1, $3, $4, $5, $6, '{RECORDS,OBSERVATION,INTERVIEW}', $7, $8)`,
        [
          SEED_IDS.orgExample,
          t.rows[0].id,
          ac07 ? 'PUBLISHED' : 'DRAFT',
          JSON.stringify([{ code, question: evidence, failureAction: failure, critical: ac07 }]),
          'Configurable starting point; record population and selection method',
          ac07 ? 5 : 2,
          ac07 ? gov : null,
          ac07 ? new Date() : null,
        ],
      );
    }
    // AUD-102 (wireframe 03): vehicle cleaning audit on 5 checks across 3 shifts, 1 failure.
    const ac07v = await c.query(
      `SELECT v.id FROM audit_template_version v JOIN audit_template t ON t.id = v.template_id
       WHERE t.organisation_id = $1 AND t.code = 'AC-07' AND v.status = 'PUBLISHED'`,
      [SEED_IDS.orgExample],
    );
    const run = await c.query(
      `INSERT INTO audit_run (id, organisation_id, code, template_version_id, location_id, title, period_from, period_to, auditor_user_id, owner_user_id, due_date, status)
       VALUES ($1, $2, 'AUD-102', $3, $4, 'Vehicle cleaning audit', '2026-10-01', '2026-10-21', $5, $6, '2026-10-21', 'IN_PROGRESS')
       ON CONFLICT (id) DO NOTHING`,
      [SEED_IDS.auditRun102, SEED_IDS.orgExample, ac07v.rows[0]?.id, SEED_IDS.locWatford, gov, mgr],
    );
    if (run.rowCount) {
      const v = [SEED_IDS.vehicleAmb1, SEED_IDS.vehicleAmb2, SEED_IDS.vehicleAmb3];
      await c.query(
        `INSERT INTO audit_sample (organisation_id, run_id, population_desc, selection_method, date_from, date_to, subject_type, subject_ids, reviewer_user_id)
         VALUES ($1, $2, 'Pre-shift cleaning records for AMB-01..03 across 3 shifts', 'Five shift checks chosen at random from the period', '2026-10-01', '2026-10-21', 'VEHICLE', $3, $4)`,
        [SEED_IDS.orgExample, SEED_IDS.auditRun102, v, gov],
      );
      for (let i = 0; i < 5; i++)
        await c.query(
          `INSERT INTO audit_response (organisation_id, run_id, control_code, subject_id, result, method, note, recorded_by)
           VALUES ($1, $2, 'AC-07', $3, $4, 'OBSERVATION', $5, $6)`,
          [
            SEED_IDS.orgExample,
            SEED_IDS.auditRun102,
            v[i % 3],
            i === 4 ? 'NON_COMPLIANT' : 'COMPLIANT',
            i === 4 ? 'Pre-shift clean not recorded on AMB-02 (shift 3)' : null,
            gov,
          ],
        );
      await c.query(
        `INSERT INTO audit_finding (id, organisation_id, run_id, control_code, pass_count, fail_count, result, severity, summary, created_by)
         VALUES ($1, $2, $3, 'AC-07', 4, 1, 'NON_COMPLIANT', 'HIGH', '4 pass / 1 fail', $4)`,
        [SEED_IDS.findingAc07, SEED_IDS.orgExample, SEED_IDS.auditRun102, gov],
      );
      await c.query(
        `INSERT INTO audit_run (id, organisation_id, code, template_version_id, location_id, title, auditor_user_id, owner_user_id, due_date, reaudit_of)
         VALUES ($1, $2, 'AUD-103', $3, $4, 'Re-audit: Vehicle cleaning audit', $5, $6, '2026-11-05', $7)`,
        [
          SEED_IDS.auditRun103,
          SEED_IDS.orgExample,
          ac07v.rows[0]?.id,
          SEED_IDS.locWatford,
          gov,
          mgr,
          SEED_IDS.auditRun102,
        ],
      );
      for (const [id, code, kind, title, deadline, reaudit] of [
        [
          SEED_IDS.action218,
          'ACT-218',
          'ACTION',
          'Investigate missed pre-shift clean on AMB-02',
          '2026-10-29',
          null,
        ],
        [
          SEED_IDS.action219,
          'ACT-219',
          'REAUDIT',
          'Re-audit vehicle cleaning',
          '2026-11-05',
          SEED_IDS.auditRun103,
        ],
      ] as const) {
        await c.query(
          `INSERT INTO action (id, organisation_id, code, source_type, source_id, kind, title, severity, owner_user_id, deadline, reaudit_run_id, created_by)
           VALUES ($1, $2, $3, 'FINDING', $4, $5, $6, 'HIGH', $7, $8, $9, $10)`,
          [
            id,
            SEED_IDS.orgExample,
            code,
            SEED_IDS.findingAc07,
            kind,
            title,
            mgr,
            deadline,
            reaudit,
            gov,
          ],
        );
        await c.query(
          `INSERT INTO action_history (organisation_id, action_id, to_status, note, by_user_id) VALUES ($1, $2, 'OPEN', 'Created', $3)`,
          [SEED_IDS.orgExample, id, gov],
        );
      }
      await c.query(
        `UPDATE audit_run SET status = 'ACTIONS_OPEN', submitted_at = '2026-10-21T16:00:00Z', outcome = 'RED', outcome_reason = 'Action outstanding' WHERE id = $1`,
        [SEED_IDS.auditRun102],
      );
      await c.query(
        `INSERT INTO org_counter (organisation_id, prefix, value) VALUES ($1, 'AUD', 103), ($1, 'ACT', 219)
         ON CONFLICT (organisation_id, prefix) DO UPDATE SET value = GREATEST(org_counter.value, EXCLUDED.value)`,
        [SEED_IDS.orgExample],
      );
    }
    // AMB-03 critical ramp defect (US-FLT-1): vehicle blocked, control alerted.
    const d = await c.query(
      `INSERT INTO defect (id, organisation_id, vehicle_id, severity, stop_use, description, reported_by, discovered_at)
       VALUES ($1, $2, $3, 'CRITICAL', true, 'Wheelchair ramp will not lock in the deployed position', $4, '2026-10-22T07:15:00Z')
       ON CONFLICT (id) DO NOTHING`,
      [SEED_IDS.defectAmb3, SEED_IDS.orgExample, SEED_IDS.vehicleAmb3, SEED_USERS.crew!.id],
    );
    if (d.rowCount) {
      await c.query(
        `UPDATE vehicle SET status = 'BLOCKED', status_reason = '1 open stop-use defect' WHERE id = $1`,
        [SEED_IDS.vehicleAmb3],
      );
      await c.query(
        `INSERT INTO alert (organisation_id, source_type, source_id, severity, reason_code, reason_text)
         VALUES ($1, 'DEFECT', $2, 'CRITICAL', 'VEHICLE_BLOCKED', 'Stop-use defect on AMB-03: do not allocate until released')`,
        [SEED_IDS.orgExample, SEED_IDS.defectAmb3],
      );
    }
    await c.query(
      `INSERT INTO app_user (id, idp_subject, email, display_name, status, is_platform_support)
       VALUES ($1, $2, $3, $4, 'ACTIVE', true) ON CONFLICT (id) DO NOTHING`,
      [SEED_SUPPORT.id, SEED_SUPPORT.subject, SEED_SUPPORT.email, SEED_SUPPORT.name],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}
