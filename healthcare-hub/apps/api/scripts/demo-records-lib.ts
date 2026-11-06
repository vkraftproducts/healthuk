// DEV-ONLY: gives the demo data the paperwork behind every status. Nothing turns green without
// a record of what was checked and a document a second person has verified: the role
// requirements say what each role needs, each staff member gets the records (DBS, right to work,
// references, training, induction) and a matching certificate, and each vehicle its MOT,
// insurance and tax certificates. A few gaps are left on purpose so not everything is green.
// Everything goes through the public API, so the real rules decide each status. Safe to re-run.
// Synthetic data only (CLAUDE.md #10): every document says it is a synthetic test document.
import { londonDate } from '@hub/rules';
import type { Call } from './crew-demo-lib.js';
import type { PutFile } from './demo-data-lib.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const MANAGER = 'dev|manager';
const HR = 'dev|hr';
const FLEET = 'dev|fleet';
const GOVERNANCE = 'dev|governance';
/** Titles the first demo loader gave its stand-in files; they are replaced, not trusted. */
const PLACEHOLDER = /^Certificate for /;
/** A proper document whose file arrived and passed the check (an interrupted upload does not count). */
const isProper = (v: Row) =>
  !PLACEHOLDER.test(String(v.title)) && v.scanStatus === 'CLEAN' && v.state !== 'REJECTED';

const CARE_ASSISTANT = [
  'AMB-STF-02',
  'AMB-STF-03',
  'AMB-STF-04',
  'AMB-STF-05',
  'AMB-STF-06',
  'AMB-STF-07',
  'AMB-STF-08',
  'AMB-STF-09',
];
export const ROLE_REQUIREMENTS: Record<string, string[]> = {
  CARE_ASSISTANT,
  DRIVER: ['AMB-STF-01', ...CARE_ASSISTANT],
};
const VEHICLE_REQUIREMENTS = ['AMB-VEH-01', 'AMB-VEH-02', 'AMB-VEH-03'];

/**
 * Whose files to complete. `pending` leaves those requirements without verified evidence on
 * purpose; `amber` gives that requirement evidence that runs out within the due-soon window.
 * Anyone not listed (joiners mid-checks) is left as the rules find them.
 */
const STAFF_FILES: Record<string, { pending?: string[]; amber?: string[] }> = {
  'ST-1001': {},
  'ST-1002': {},
  'ST-1003': {},
  'ST-1004': { amber: ['AMB-STF-05'] },
  'ST-1005': {},
  'ST-1006': { pending: ['AMB-STF-04'] },
  'ST-1007': {},
  'ST-0042': {},
  'ST-0043': {},
};

export interface DemoRecordsResult {
  roleRequirementsAdded: number;
  records: number;
  documents: number;
  verified: number;
  placeholdersReplaced: number;
  /** What this run added, by document title: empty on a re-run. */
  added: string[];
  problems: string[];
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
function addYears(date: string, years: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}
/** A stable small number from a string, so each person's dates and numbers differ but repeat. */
function seed(s: string): number {
  let h = 7;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 100_003;
  return h;
}

/** A real, viewable one-page PDF with the given lines of text (Helvetica, A4). */
export function syntheticPdf(lines: string[]): Uint8Array {
  const esc = (t: string) => t.replace(/[\\()]/g, (m) => `\\${m}`).replace(/[^\x20-\x7e]/g, '-');
  const content = [
    'BT',
    '/F1 16 Tf',
    '56 780 Td',
    `(${esc(lines[0] ?? '')}) Tj`,
    '/F1 11 Tf',
    '0 -28 Td',
    ...lines.slice(1).flatMap((l) => [`(${esc(l)}) Tj`, '0 -18 Td']),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

const SYNTHETIC = 'SYNTHETIC TEST DOCUMENT - NOT A REAL CERTIFICATE';

export async function completeDemoRecords(
  call: Call,
  putFile: PutFile,
  now = new Date(),
): Promise<DemoRecordsResult> {
  const today = londonDate(now);
  const out: DemoRecordsResult = {
    roleRequirementsAdded: 0,
    records: 0,
    documents: 0,
    verified: 0,
    placeholdersReplaced: 0,
    added: [],
    problems: [],
  };
  const get = async (path: string, sub = MANAGER) => (await call('GET', path, sub)).body as Row;
  const post = async (what: string, path: string, sub: string, body?: unknown) => {
    const r = await call('POST', path, sub, body);
    if (r.status >= 300) {
      out.problems.push(`${what}: ${r.status} ${String(r.body.detail ?? r.body.code ?? '')}`);
      return null;
    }
    return r.body as Row;
  };

  const users = ((await get('/api/v1/admin/users')).data ?? []) as Row[];
  const hrId = users.find((u) => u.email === 'hr@example.test')?.id as string | undefined;
  if (!hrId) {
    out.problems.push('Seeded HR user not found: run pnpm db:seed first');
    return out;
  }

  // ---- templates: adopted from the library and published (four-eyes) --------------------------
  let templates = ((await get('/api/v1/requirements/templates')).data ?? []) as Row[];
  const adopted = (code: string) =>
    templates.find(
      (t) =>
        t.code === code &&
        !t.isLibrary &&
        (t.versions as Row[]).some((v) => v.status === 'EFFECTIVE'),
    );
  for (const code of [
    ...new Set([...ROLE_REQUIREMENTS.DRIVER!, ...VEHICLE_REQUIREMENTS, 'AMB-PRM-01']),
  ]) {
    if (adopted(code)) continue;
    const library = templates.find((t) => t.code === code && t.isLibrary);
    const draftCopy =
      templates.find((t) => t.code === code && !t.isLibrary) ??
      (library &&
        (await post(
          `adopt ${code}`,
          `/api/v1/requirements/templates/${library.id}/adopt`,
          MANAGER,
        )));
    const draft = (draftCopy?.versions as Row[] | undefined)?.find((v) => v.status === 'DRAFT');
    if (draftCopy && draft)
      await post(
        `publish ${code}`,
        `/api/v1/requirements/templates/${draftCopy.id}/versions/${draft.id}/publish`,
        GOVERNANCE,
      );
  }
  templates = ((await get('/api/v1/requirements/templates')).data ?? []) as Row[];

  // ---- what each role needs ---------------------------------------------------------------------
  const existing = ((await get('/api/v1/staff/role-requirements')).data ?? []) as Row[];
  for (const [role, codes] of Object.entries(ROLE_REQUIREMENTS))
    for (const code of codes) {
      const t = adopted(code);
      if (!t || existing.some((r) => r.role === role && r.templateCode === code)) continue;
      if (
        await post(`require ${code} for ${role}`, '/api/v1/staff/role-requirements', MANAGER, {
          role,
          templateId: t.id,
        })
      )
        out.roleRequirementsAdded += 1;
    }

  /**
   * Makes `instance` rest on a proper document: uploads it (a new version when a stand-in is
   * there, it is replaced) and has `verifier` verify it unless `verify` is false. Skips anything
   * already backed by a proper current document.
   */
  const evidence = async (
    instance: Row,
    doc: {
      title: string;
      lines: string[];
      validFrom?: string;
      validTo?: string;
      sensitivity?: string;
    },
    verifier: string,
    verify = true,
  ) => {
    const versions = ((await get(`/api/v1/requirements/instances/${instance.id}/evidence`)).data ??
      []) as Row[];
    const proper = versions.find((v) => isProper(v));
    if (proper && (instance.currentlyVerified || !verify)) return;
    const standIn = versions.find((v) => PLACEHOLDER.test(String(v.title)));
    const bytes = syntheticPdf([doc.title, SYNTHETIC, '', ...doc.lines]);
    const up = await post(`upload ${doc.title}`, '/api/v1/evidence/uploads', MANAGER, {
      title: doc.title,
      mime: 'application/pdf',
      sizeBytes: bytes.length,
      // Its own item: a version under a stand-in item would inherit the stand-in's title. The
      // stand-in stays linked as history (evidence is never deleted) but is no longer the latest.
      requirementInstanceIds: [instance.id],
      ...(doc.validFrom ? { validFrom: doc.validFrom } : {}),
      ...(doc.validTo ? { validTo: doc.validTo } : {}),
      sensitivity: doc.sensitivity ?? 'NORMAL',
    });
    if (!up) return;
    const put = await putFile(up.uploadUrl as string, bytes, 'application/pdf');
    if (put >= 300) {
      out.problems.push(`file for ${doc.title}: ${put}`);
      return;
    }
    if (
      !(await post(
        `complete ${doc.title}`,
        `/api/v1/evidence/${up.evidenceVersionId}/complete`,
        MANAGER,
      ))
    )
      return;
    out.documents += 1;
    out.added.push(doc.title);
    if (standIn) out.placeholdersReplaced += 1;
    if (!verify) return;
    if (
      await post(
        `verify ${doc.title}`,
        `/api/v1/evidence/${up.evidenceVersionId}/verify`,
        verifier,
        {
          decision: 'ACCEPTED',
          ...(doc.validTo ? { confirmedValidTo: doc.validTo } : {}),
        },
      )
    )
      out.verified += 1;
  };
  const record = async (staffId: string, slug: string, data: Row, instanceId: string) => {
    // One record per requirement: a retry after an interrupted run must not add a second.
    const held = ((await get(`/api/v1/staff/${staffId}/${slug}`)).data ?? []) as Row[];
    if (slug !== 'references' && held.some((r) => r.requirementInstanceId === instanceId)) return;
    if (
      await post(`${slug} record`, `/api/v1/staff/${staffId}/${slug}`, MANAGER, {
        data,
        requirementInstanceId: instanceId,
      })
    )
      out.records += 1;
  };

  // ---- staff files ------------------------------------------------------------------------------
  const staff = ((await get('/api/v1/staff?limit=100')).data ?? []) as Row[];
  for (const s of staff) {
    const plan = STAFF_FILES[s.staffNo as string];
    if (!plan) continue;
    const n = seed(s.staffNo as string);
    const who = `${s.displayName} (${s.staffNo})`;
    const instances = ((await get(`/api/v1/requirements/instances?subjectId=${s.id}&limit=100`))
      .data ?? []) as Row[];
    const licences = ((await get(`/api/v1/staff/${s.id}/licences`)).data ?? []) as Row[];
    const references = ((await get(`/api/v1/staff/${s.id}/references`)).data ?? []) as Row[];
    for (const i of instances) {
      const code = i.templateCode as string;
      if (i.status === 'RED') continue; // genuinely overdue: left for the manager to chase
      const pending = plan.pending?.includes(code);
      if (pending && references.length > 0) continue; // already recorded as awaited
      // A proper document is already there (verified or awaiting review): nothing to add.
      const versions = ((await get(`/api/v1/requirements/instances/${i.id}/evidence`)).data ??
        []) as Row[];
      if (versions.some((v) => isProper(v))) continue;
      const shortLife = plan.amber?.includes(code);
      const done = addDays(today, -(40 + (n % 200)));
      const recurring = (years: number) =>
        i.dueDate ?? (shortLife ? addDays(today, 12) : addYears(done, years));
      switch (code) {
        case 'AMB-STF-01': {
          const lic = licences[0]?.data as Row | undefined;
          const expiry = (lic?.photocardExpiry as string) ?? addYears(today, 4);
          if (!lic)
            await record(
              s.id,
              'licences',
              {
                categories: ['B', 'C1'],
                photocardExpiry: expiry,
                lastCheckedOn: today,
                checkMethod: 'DVLA_SHARE_CODE',
              },
              i.id,
            );
          await evidence(
            i,
            {
              title: `Driving licence check - ${who}`,
              lines: [
                `Holder: ${s.displayName}`,
                'Categories: B, C1',
                `Photocard expires: ${expiry}`,
                `Checked: ${today} via DVLA share code`,
                'Penalty points: 0',
              ],
              validTo: expiry,
              sensitivity: 'HR',
            },
            HR,
          );
          break;
        }
        case 'AMB-STF-02': {
          const issued = addDays(today, -(120 + (n % 400)));
          const review = addYears(issued, 3);
          const cert = `00${String(1_000_000_000 + n * 7919).slice(0, 10)}`;
          await record(
            s.id,
            'dbs',
            {
              eligibility: 'ENHANCED_BARRED',
              barredListChecked: true,
              certificateNumber: cert,
              issueDate: issued,
              updateServiceConsent: true,
              riskDecision: 'CLEAR',
              policyReviewDate: review,
            },
            i.id,
          );
          await evidence(
            i,
            {
              title: `DBS enhanced certificate - ${who}`,
              lines: [
                `Applicant: ${s.displayName}`,
                'Level: Enhanced with adults and children barred lists',
                `Certificate number: ${cert}`,
                `Issued: ${issued}`,
                'Result: no information recorded',
                `Policy review due: ${review}`,
              ],
              validFrom: issued,
              validTo: review,
              sensitivity: 'HR',
            },
            HR,
          );
          break;
        }
        case 'AMB-STF-03': {
          // Checked against a passport: the app needs the document's expiry to verify it.
          const checked = addDays(today, -(200 + (n % 300)));
          const passportExpiry = addYears(checked, 6);
          await record(
            s.id,
            'right-to-work',
            { method: 'MANUAL_DOCUMENT', checkedOn: checked, checkerUserId: hrId },
            i.id,
          );
          await evidence(
            i,
            {
              title: `Right to work check - ${who}`,
              lines: [
                `Worker: ${s.displayName}`,
                'Method: manual check of a UK passport (original seen, copy kept)',
                'Outcome: unlimited right to work in the UK',
                `Passport valid until: ${passportExpiry}`,
                `Checked: ${checked} by Hana Rowe, HR lead`,
              ],
              validFrom: checked,
              validTo: passportExpiry,
              sensitivity: 'HR',
            },
            HR,
          );
          break;
        }
        case 'AMB-STF-04': {
          const asked = addDays(today, -(230 + (n % 200)));
          for (const [k, referee, org] of [
            [0, 'Pat Morley', 'Synthetic Patient Transport Ltd'],
            [1, 'Dr Sam Okafor', 'Synthetic Community Health Trust'],
          ] as const)
            await record(
              s.id,
              'references',
              {
                refereeName: referee,
                refereeOrganisation: org,
                relationship: k === 0 ? 'Previous line manager' : 'Previous clinical supervisor',
                requestedOn: asked,
                ...(pending ? {} : { receivedOn: addDays(asked, 9 + k) }),
                outcome: pending ? 'PENDING' : 'SATISFACTORY',
              },
              i.id,
            );
          if (!pending)
            await evidence(
              i,
              {
                title: `References - ${who}`,
                lines: [
                  `Candidate: ${s.displayName}`,
                  'Reference 1: Pat Morley, previous line manager - satisfactory',
                  'Reference 2: Dr Sam Okafor, previous clinical supervisor - satisfactory',
                  `Requested: ${asked}`,
                ],
                sensitivity: 'HR',
              },
              HR,
            );
          break;
        }
        case 'AMB-STF-05':
        case 'AMB-STF-06':
        case 'AMB-STF-07':
        case 'AMB-STF-08': {
          const course = {
            'AMB-STF-05': ['MH-PRACTICAL', 'Moving and handling (people), practical', 1],
            'AMB-STF-06': ['BLS-AED', 'Basic life support and AED', 1],
            'AMB-STF-07': ['SAFEGUARDING-L2', 'Safeguarding adults and children, level 2', 3],
            'AMB-STF-08': ['IPC-L2', 'Infection prevention and control, level 2', 1],
          }[code] as [string, string, number];
          const validTo = recurring(course[2]);
          const completed = shortLife ? addDays(validTo, -365) : addDays(validTo, -365 * course[2]);
          await record(
            s.id,
            'training',
            {
              courseCode: course[0],
              title: course[1],
              completedOn: completed,
              expiresOn: validTo,
              provider: 'Synthetic Training Academy',
            },
            i.id,
          );
          await evidence(
            i,
            {
              title: `${course[1]} - ${who}`,
              lines: [
                `Learner: ${s.displayName}`,
                `Course: ${course[1]} (${course[0]})`,
                'Provider: Synthetic Training Academy',
                `Completed: ${completed}`,
                `Valid until: ${validTo}`,
                `Certificate no: STA-${course[0]}-${n}`,
              ],
              validFrom: completed,
              validTo,
            },
            HR,
            !pending,
          );
          break;
        }
        case 'AMB-STF-09': {
          const on = addDays(today, -(150 + (n % 300)));
          await record(s.id, 'induction', { completedOn: on, signedOffByUserId: hrId }, i.id);
          await evidence(
            i,
            {
              title: `Induction sign-off - ${who}`,
              lines: [
                `Employee: ${s.displayName}`,
                `Induction completed: ${on}`,
                'Covered: policies, safeguarding, vehicle familiarisation, incident reporting',
                'Signed off by: Hana Rowe, HR lead',
              ],
            },
            HR,
          );
          break;
        }
      }
    }
  }

  // ---- vehicles: MOT, insurance and tax -----------------------------------------------------------
  const vehicles = ((await get('/api/v1/vehicles')).data ?? []) as Row[];
  for (const v of vehicles) {
    const n = seed(v.callsign as string);
    let instances = ((await get(`/api/v1/requirements/instances?subjectId=${v.id}&limit=100`))
      .data ?? []) as Row[];
    for (const code of VEHICLE_REQUIREMENTS) {
      if (instances.some((i) => i.templateCode === code)) continue;
      const t = adopted(code);
      if (t)
        await post(`require ${code} for ${v.callsign}`, '/api/v1/requirements/instances', MANAGER, {
          templateId: t.id,
          subjectType: 'VEHICLE',
          subjectId: v.id,
          locationId: v.baseLocationId,
          expiryDate: addDays(today, 60 + (n % 290)),
        });
    }
    instances = ((await get(`/api/v1/requirements/instances?subjectId=${v.id}&limit=100`)).data ??
      []) as Row[];
    for (const i of instances) {
      if (i.status === 'RED') continue; // expired: left red on purpose
      const expiry = (i.expiryDate as string | null) ?? addDays(today, 90);
      const doc = {
        'AMB-VEH-01': {
          title: `MOT test certificate - ${v.callsign} (${v.registration})`,
          lines: [
            `Vehicle: ${v.callsign}, registration ${v.registration}`,
            `MOT test number: ${String(4_000_000_000 + n * 977).slice(0, 12)}`,
            `Odometer at test: ${(42_000 + n * 13).toLocaleString('en-GB')} miles`,
            'Result: pass, no advisories',
            `Expires: ${expiry}`,
          ],
        },
        'AMB-VEH-02': {
          title: `Motor insurance certificate - ${v.callsign} (${v.registration})`,
          lines: [
            `Vehicle: ${v.callsign}, registration ${v.registration}`,
            'Insurer: Synthetic Mutual Fleet Insurance',
            `Policy: SMF-${n}-AMB`,
            'Use: social, domestic and business including hire or reward (patient transport)',
            `Valid until: ${expiry}`,
          ],
        },
        'AMB-VEH-03': {
          title: `Vehicle tax confirmation - ${v.callsign} (${v.registration})`,
          lines: [
            `Vehicle: ${v.callsign}, registration ${v.registration}`,
            'Status: taxed (DVLA vehicle enquiry)',
            `Tax due: ${expiry}`,
          ],
        },
      }[i.templateCode as string];
      if (!doc) continue;
      await evidence(i, { ...doc, validFrom: addYears(expiry, -1), validTo: expiry }, FLEET);
    }
  }

  // ---- premises: swap stand-ins for proper documents (verification state unchanged) --------------
  const premises = ((await get('/api/v1/requirements/instances?subjectType=PREMISES&limit=100'))
    .data ?? []) as Row[];
  for (const i of premises) {
    const versions = ((await get(`/api/v1/requirements/instances/${i.id}/evidence`)).data ??
      []) as Row[];
    if (!versions.some((v) => PLACEHOLDER.test(String(v.title)))) continue;
    const due = (i.dueDate as string | null) ?? addDays(today, 30);
    const doc = {
      'AMB-PRM-01': [
        'Fire risk assessment - Watford base',
        [
          'Premises: Watford ambulance base',
          'Assessor: Synthetic Fire Safety Ltd (competent person)',
          'Risk rating: tolerable',
          'Actions: 2 low-priority (signage, door closer adjustment)',
          `Next review: ${due}`,
        ],
      ],
      'AMB-PRM-03': [
        'Gas safety record - Watford base',
        [
          'Premises: Watford ambulance base',
          'Engineer: Gas Safe registered, ID 000000 (synthetic)',
          'Appliances: 2 boilers, both safe',
          `Next check due: ${due}`,
        ],
      ],
    }[i.templateCode as string] as [string, string[]] | undefined;
    if (doc)
      await evidence(
        i,
        { title: doc[0], lines: doc[1], validTo: due },
        GOVERNANCE,
        i.currentlyVerified as boolean,
      );
  }
  return out;
}
