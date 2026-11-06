import pg from 'pg';
import { seedLocalCredentials } from './seed-credentials.js';

// SYNTHETIC DEMO ONLY. Two extra organisations for the draft dental and care-home packs: a mock
// dental practice and a mock care home, each with a manager, an administrator, a few staff and
// INACTIVE draft audit templates. Nothing here is real, validated or an official standard.
// Kept apart from seed() so the main seed and its tests are unchanged. Idempotent (fixed IDs).
// Requires migrations (which create the packs and sync the system roles) to have run first.

const id = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const SECTOR_IDS = {
  orgDental: id(3),
  orgCareHome: id(4),
  locDental: id(13),
  locCareHome: id(14),
} as const;

interface SectorUser {
  id: string;
  subject: string;
  email: string;
  name: string;
  org: string;
  role: string;
}
const user = (n: number, sub: string, name: string, org: string, role: string): SectorUser => ({
  id: id(1000 + n),
  subject: `dev|${sub}`,
  email: `${sub}@example.test`,
  name,
  org,
  role,
});
export const SECTOR_USERS: Record<string, SectorUser> = {
  dentalManager: user(
    1,
    'dental-manager',
    'Dana Mock (dental manager)',
    SECTOR_IDS.orgDental,
    'REGISTERED_MANAGER',
  ),
  dentalAdmin: user(
    2,
    'dental-admin',
    'Dev Mock (dental admin)',
    SECTOR_IDS.orgDental,
    'ORG_ADMIN',
  ),
  careHomeManager: user(
    3,
    'carehome-manager',
    'Casey Mock (care home manager)',
    SECTOR_IDS.orgCareHome,
    'REGISTERED_MANAGER',
  ),
  careHomeAdmin: user(
    4,
    'carehome-admin',
    'Charlie Mock (care home admin)',
    SECTOR_IDS.orgCareHome,
    'ORG_ADMIN',
  ),
};

type Cadence = 'weekly' | 'monthly' | 'quarterly' | 'six-monthly' | 'annual';
// [code, title, domain, cadence, what the audit checks, what happens on failure]
type Template = [string, string, string, Cadence, string, string];

/** Draft audit templates with a PROPOSED cadence. Specialist validation is required before use. */
export const DENTAL_TEMPLATES: Template[] = [
  [
    'DEN-01',
    'Infection prevention and decontamination',
    'SAFE',
    'six-monthly',
    'Instrument decontamination steps, records of cycles and tests, storage, and hand hygiene observation.',
    'Stop use of affected instruments; re-train and re-audit.',
  ],
  [
    'DEN-02',
    'Radiation protection',
    'SAFE',
    'annual',
    'Equipment inspection records, justification and reporting, and local rules acknowledged.',
    'Take equipment out of use until the specialist adviser confirms it is safe.',
  ],
  [
    'DEN-03',
    'Medical emergencies and equipment',
    'SAFE',
    'monthly',
    'Emergency drugs and equipment present and in date; staff training current.',
    'Replace or restock the same day; log the gap.',
  ],
  [
    'DEN-04',
    'Clinical records',
    'EFFECTIVE',
    'quarterly',
    'Sample of records for consent, medical history update and treatment notes.',
    'Individual feedback and a follow-up sample.',
  ],
  [
    'DEN-05',
    'Sharps and clinical waste',
    'SAFE',
    'quarterly',
    'Sharps handling, containers, segregation and waste transfer records.',
    'Correct immediately; review the incident log.',
  ],
  [
    'DEN-06',
    'Complaints and patient feedback',
    'RESPONSIVE',
    'quarterly',
    'Complaint handling times and learning, and feedback themes acted on.',
    'Assign owners and track actions to closure.',
  ],
];
export const CARE_HOME_TEMPLATES: Template[] = [
  [
    'CH-01',
    'Medicines management',
    'SAFE',
    'monthly',
    'Administration records, controlled drugs balance, storage temperatures and PRN protocols.',
    'Immediate review of the person affected; report errors.',
  ],
  [
    'CH-02',
    'Care plans and risk assessments',
    'EFFECTIVE',
    'monthly',
    'Sample of care plans reviewed on time, person involved, risks assessed.',
    'Update the plan and verify with the person or their representative.',
  ],
  [
    'CH-03',
    'Falls and incidents',
    'SAFE',
    'monthly',
    'Falls and incidents reviewed for patterns, actions and notifications.',
    'Escalate patterns; review staffing and environment.',
  ],
  [
    'CH-04',
    'Nutrition and hydration',
    'EFFECTIVE',
    'quarterly',
    'Food and fluid records, weight monitoring and referrals.',
    'Refer to the right professional and re-check within a week.',
  ],
  [
    'CH-05',
    'Infection prevention and control',
    'SAFE',
    'quarterly',
    'Cleaning schedules, laundry, outbreak plan and hand hygiene observation.',
    'Deep clean and re-audit; apply the outbreak plan where needed.',
  ],
  [
    'CH-06',
    'Safeguarding and deprivation of liberty',
    'SAFE',
    'quarterly',
    'Referral trail, mental capacity assessments, authorisations and expiry dates.',
    'Escalate overdue authorisations the same day.',
  ],
  [
    'CH-07',
    'Fire and environment',
    'SAFE',
    'monthly',
    'Alarm tests, escape routes, personal evacuation plans, water safety checks.',
    'Fix and verify before the next shift; record who verified.',
  ],
  [
    'CH-08',
    'Dignity and resident experience',
    'CARING',
    'six-monthly',
    'Observation of care, resident and relative feedback, activity provision.',
    'Share findings with staff and agree actions.',
  ],
];

const STAFF: [number, string, string, string, string, string][] = [
  // [n, staffNo, name, job title, org key, staff role]
  [1, 'ST-1001', 'Pat Mock', 'Dentist (mock)', 'dental', 'DENTIST'],
  [2, 'ST-1002', 'Sam Mock', 'Dental nurse (mock)', 'dental', 'DENTAL_NURSE'],
  [3, 'ST-1003', 'Riley Mock', 'Practice receptionist (mock)', 'dental', 'RECEPTIONIST'],
  [4, 'ST-2001', 'Morgan Mock', 'Senior care assistant (mock)', 'care', 'SENIOR_CARER'],
  [5, 'ST-2002', 'Jamie Mock', 'Care assistant (mock)', 'care', 'CARE_ASSISTANT'],
  [6, 'ST-2003', 'Alex Mock', 'Activities coordinator (mock)', 'care', 'ACTIVITIES_COORDINATOR'],
];

/** Mock services and registered activities, so the sector organisations are not empty (98). */
const SERVICES: Record<'dental' | 'care', [string, string][]> = {
  dental: [
    ['GENERAL_DENTAL', 'General dental care (mock)'],
    ['HYGIENE', 'Dental hygiene clinic (mock)'],
  ],
  care: [
    ['RESIDENTIAL', 'Residential care (mock)'],
    ['RESPITE', 'Respite stays (mock)'],
  ],
};
const ACTIVITIES: Record<'dental' | 'care', [string, string][]> = {
  dental: [
    ['TDDI', 'Treatment of disease, disorder or injury'],
    ['DIAGNOSTIC', 'Diagnostic and screening procedures'],
    ['SURGICAL', 'Surgical procedures'],
  ],
  care: [
    ['ACCOMMODATION', 'Accommodation for persons who require nursing or personal care'],
    ['TDDI', 'Treatment of disease, disorder or injury'],
  ],
};

export async function seedSectors(adminUrl: string): Promise<void> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    const ctx = (org: string) => c.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
    const orgs: [string, string, string[], string, string][] = [
      [
        SECTOR_IDS.orgDental,
        'Mock Dental Practice (synthetic)',
        ['dental'],
        SECTOR_IDS.locDental,
        'Main surgery',
      ],
      [
        SECTOR_IDS.orgCareHome,
        'Mock Care Home (synthetic)',
        ['care_home'],
        SECTOR_IDS.locCareHome,
        'Main house',
      ],
    ];
    for (const [oid, name, packs, loc, locName] of orgs) {
      await ctx(oid);
      await c.query(
        `INSERT INTO organisation (id, name, sector_packs) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
        [oid, name, packs],
      );
      await c.query(
        `INSERT INTO location (id, organisation_id, name, registered) VALUES ($1, $2, $3, true) ON CONFLICT (id) DO NOTHING`,
        [loc, oid, locName],
      );
      for (const u of Object.values(SECTOR_USERS).filter((x) => x.org === oid)) {
        await c.query(
          `INSERT INTO app_user (id, idp_subject, email, display_name, status) VALUES ($1, $2, $3, $4, 'ACTIVE')
           ON CONFLICT (id) DO NOTHING`,
          [u.id, u.subject, u.email, u.name],
        );
        const role = await c.query(
          `SELECT id FROM role WHERE organisation_id IS NULL AND key = $1`,
          [u.role],
        );
        if (!role.rowCount) throw new Error(`System role ${u.role} missing: run migrations first`);
        await c.query(
          `INSERT INTO membership (organisation_id, user_id, role_id, valid_from)
           SELECT $1, $2, $3, now() - interval '1 day'
            WHERE NOT EXISTS (SELECT 1 FROM membership WHERE organisation_id = $1 AND user_id = $2)`,
          [oid, u.id, role.rows[0].id],
        );
      }
      const mgr = Object.values(SECTOR_USERS).find(
        (x) => x.org === oid && x.role === 'REGISTERED_MANAGER',
      )!;
      const key = oid === SECTOR_IDS.orgDental ? 'dental' : 'care';
      for (const [code, svc] of SERVICES[key])
        await c.query(
          `INSERT INTO service_type (organisation_id, code, name) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [oid, code, svc],
        );
      for (const [code, activity] of ACTIVITIES[key])
        await c.query(
          `INSERT INTO registered_activity (organisation_id, location_id, code, name)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [oid, loc, code, activity],
        );
      for (const [n, no, name2, title, , role] of STAFF.filter((s) => s[4] === key)) {
        const sid = id(2000 + n);
        const ins = await c.query(
          `INSERT INTO staff (id, organisation_id, staff_no, display_name, lifecycle_state, primary_location_id, job_title)
           VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $6) ON CONFLICT (id) DO NOTHING`,
          [sid, oid, no, name2, loc, title],
        );
        if (ins.rowCount)
          await c.query(
            `INSERT INTO staff_lifecycle_event (organisation_id, staff_id, from_state, to_state, reason, actor_user_id)
             VALUES ($1, $2, NULL, 'ACTIVE', 'Seeded synthetic record', $3)`,
            [oid, sid, mgr.id],
          );
        // Every mock person holds their sector role, so nobody shows as active with no role (96).
        // Earlier seeds created them without one; this adds it once.
        await c.query(
          `INSERT INTO staff_role_approval (organisation_id, staff_id, role, reason, approved_by)
           SELECT $1, $2, $3::staff_role, 'Seeded synthetic approval (mock)', $4
            WHERE NOT EXISTS (SELECT 1 FROM staff_role_approval WHERE staff_id = $2)`,
          [oid, sid, role, mgr.id],
        );
      }
      const templates = oid === SECTOR_IDS.orgDental ? DENTAL_TEMPLATES : CARE_HOME_TEMPLATES;
      const pack = oid === SECTOR_IDS.orgDental ? 'dental' : 'care_home';
      for (const [code, title, domain, cadence, question, failure] of templates) {
        const t = await c.query(
          `INSERT INTO audit_template (organisation_id, code, title, domain, source_ref, active, created_by,
             sector_pack, proposed_cadence)
           VALUES ($1, $2, $3, $4, $5, false, $6, $7, $8)
           ON CONFLICT (organisation_id, code) DO NOTHING RETURNING id`,
          [
            oid,
            code,
            title,
            domain,
            `Draft - proposed ${cadence} cadence - specialist validation required before use`,
            mgr.id,
            pack,
            String(cadence).slice(0, 40),
          ],
        );
        // Earlier seeds created these without a pack; mark them once (still inactive drafts).
        await c.query(
          `UPDATE audit_template SET sector_pack = $3, proposed_cadence = $4
            WHERE organisation_id = $1 AND code = $2 AND sector_pack IS NULL`,
          [oid, code, pack, String(cadence).slice(0, 40)],
        );
        if (!t.rowCount) continue;
        await c.query(
          `INSERT INTO audit_template_version (organisation_id, template_id, version, status, controls, sample_method, sample_size, methods)
           VALUES ($1, $2, 1, 'DRAFT', $3, 'Configurable starting point; record population and selection method', 3, '{RECORDS,OBSERVATION}')`,
          [
            oid,
            t.rows[0].id,
            JSON.stringify([{ code, question, failureAction: failure, critical: false }]),
          ],
        );
      }
    }
    // Local username + password sign-in (AUTH_MODE=local); skipped when NODE_ENV=production.
    await seedLocalCredentials(c, Object.values(SECTOR_USERS));
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}
