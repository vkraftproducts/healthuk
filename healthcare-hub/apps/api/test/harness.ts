import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, type JWK } from 'jose';
import { createDb } from '@hub/db';
import { SEED_IDS, SEED_USERS, SEED_SUPPORT } from '@hub/db/admin';
import { needsSchedule3 } from '@hub/rules';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';

export const ISSUER = 'https://idp.test.example';
export const AUDIENCE = 'healthcare-hub-api';
export { SEED_IDS, SEED_USERS, SEED_SUPPORT };

const { publicKey, privateKey } = await generateKeyPair('RS256');
const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
const other = await generateKeyPair('RS256');

export interface TokenOpts {
  sub: string;
  amr?: string[];
  iss?: string;
  aud?: string;
  expiresIn?: string | number;
  wrongKey?: boolean;
  email?: string;
  emailVerified?: boolean;
}

export async function sign(o: TokenOpts): Promise<string> {
  return new SignJWT({
    amr: o.amr ?? ['pwd', 'mfa'],
    ...(o.email ? { email: o.email, email_verified: o.emailVerified ?? true } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setSubject(o.sub)
    .setIssuer(o.iss ?? ISSUER)
    .setAudience(o.aud ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(o.expiresIn ?? '5m')
    .sign(o.wrongKey ? other.privateKey : privateKey);
}

export async function makeApp(
  urls: { app: string },
  extraControllers: Parameters<typeof createApp>[0]['extraControllers'] = [],
  configOverrides: Record<string, string> = {},
) {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: urls.app,
    OIDC_ISSUER: ISSUER,
    OIDC_AUDIENCE: AUDIENCE,
    OIDC_JWKS_URI: 'https://idp.test.example/jwks',
    LOG_LEVEL: 'silent' as never,
    ...configOverrides,
  } as Record<string, string>);
  const logger = createLogger('silent');
  const db = createDb(urls.app);
  const app = await createApp({
    config,
    logger,
    db,
    keyResolver: createLocalJWKSet({ keys: [publicJwk] }),
    extraControllers,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, db };
}

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Injector {
  inject(o: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    payload?: string | Buffer;
  }): Promise<{ statusCode: number; body: string }>;
}

async function hit(
  app: Injector,
  org: string,
  sub: string,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: J }> {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${await sign({ sub })}`,
      'x-org-id': org,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as J) : {} };
}

const TEST_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
);

/**
 * Makes sure `role` has at least one published staff requirement mapped to it (a non-blocking
 * test template, so it does not change readiness elsewhere). Returns the template id.
 */
export async function ensureRoleRequirement(app: Injector, org: string, role: string) {
  const maps = await hit(app, org, 'dev|manager', 'GET', '/api/v1/staff/role-requirements');
  const existing = (maps.body.data as J[] | undefined)?.find((m) => m.role === role);
  if (existing) return existing.templateId as string;
  // Neutral code: names containing LICENCE or DRIV are treated as licence checks.
  const code = `TCHK-${role.slice(0, 3)}-${Date.now().toString(36).toUpperCase()}`;
  const t = await hit(app, org, 'dev|admin', 'POST', '/api/v1/requirements/templates', {
    code,
    title: `Test check for ${role}`,
    version: {
      basisType: 'ORG_POLICY',
      subjectType: 'STAFF',
      recurrence: { type: 'COMPLETION_BASED', interval: { unit: 'YEARS', every: 1 } },
      blocking: 'NONE',
      deadlineKind: 'DUE',
    },
  });
  if (t.status !== 201) throw new Error(`template: ${t.status} ${JSON.stringify(t.body)}`);
  const p = await hit(
    app,
    org,
    'dev|manager',
    'POST',
    `/api/v1/requirements/templates/${t.body.id}/versions/${t.body.versions[0].id}/publish`,
  );
  if (p.status !== 201) throw new Error(`publish: ${p.status} ${JSON.stringify(p.body)}`);
  const m = await hit(app, org, 'dev|manager', 'POST', '/api/v1/staff/role-requirements', {
    role,
    templateId: t.body.id,
  });
  if (m.status !== 201 && m.status !== 409)
    throw new Error(`map: ${m.status} ${JSON.stringify(m.body)}`);
  return t.body.id as string;
}

/** Uploads a synthetic file for the instances (as `uploader`) and verifies it (as `verifier`). */
export async function uploadAndVerify(
  app: Injector,
  org: string,
  instanceIds: string[],
  o: { uploader?: string; verifier?: string | null; validTo?: string } = {},
) {
  const uploader = o.uploader ?? 'dev|hr';
  const validTo = o.validTo ?? `${new Date().getUTCFullYear() + 1}-12-31`;
  const req = await hit(app, org, uploader, 'POST', '/api/v1/evidence/uploads', {
    title: 'Synthetic test evidence',
    mime: 'application/pdf',
    sizeBytes: TEST_PDF.length,
    requirementInstanceIds: instanceIds,
    validTo,
  });
  if (req.status !== 201) throw new Error(`upload: ${req.status} ${JSON.stringify(req.body)}`);
  await app.inject({
    method: 'PUT',
    url: new URL(req.body.uploadUrl as string).pathname,
    headers: { 'content-type': 'application/pdf' },
    payload: TEST_PDF,
  });
  const done = await hit(
    app,
    org,
    uploader,
    'POST',
    `/api/v1/evidence/${req.body.evidenceVersionId}/complete`,
  );
  if (done.status !== 201) throw new Error(`complete: ${done.status} ${JSON.stringify(done.body)}`);
  if (o.verifier === null) return req.body.evidenceVersionId as string; // leave it for review
  const v = await hit(
    app,
    org,
    o.verifier ?? 'dev|manager',
    'POST',
    `/api/v1/evidence/${req.body.evidenceVersionId}/verify`,
    { decision: 'ACCEPTED', confirmedValidTo: validTo },
  );
  if (v.status !== 201) throw new Error(`verify: ${v.status} ${JSON.stringify(v.body)}`);
  return req.body.evidenceVersionId as string;
}

/**
 * B1 for tests: starts checks for each role, uploads and verifies evidence for every open item
 * (HR uploads, the manager verifies), so the approval gate can pass honestly.
 */
export async function completeChecks(app: Injector, org: string, staffId: string, roles: string[]) {
  if (roles.some(needsSchedule3)) await recordSchedule3(app, org, staffId);
  for (const role of roles) {
    await ensureRoleRequirement(app, org, role);
    const r = await hit(app, org, 'dev|hr', 'POST', `/api/v1/staff/${staffId}/role-checks`, {
      role,
    });
    if (r.status !== 201) throw new Error(`role-checks: ${r.status} ${JSON.stringify(r.body)}`);
    const open = (r.body.blockers as J[]).map((b) => b.instanceId as string);
    if (open.length > 0) await uploadAndVerify(app, org, open);
  }
}

const schedule3Done = new Set<string>();

/**
 * Records a complete synthetic Schedule 3 staff file (as HR): right to work and identity, an
 * enhanced DBS with the barred list, two satisfactory references, employment history, a
 * qualification and health clearance. Regulated roles cannot be approved without it.
 */
export async function recordSchedule3(app: Injector, org: string, staffId: string) {
  if (schedule3Done.has(staffId)) return;
  const hr = await hit(app, org, 'dev|hr', 'GET', '/api/v1/me');
  const checker = hr.body.user?.id as string;
  const nextYear = `${new Date().getUTCFullYear() + 1}-12-31`;
  const records: [string, Record<string, unknown>][] = [
    [
      'right-to-work',
      { method: 'MANUAL_DOCUMENT', checkedOn: '2024-01-02', checkerUserId: checker },
    ],
    [
      'dbs',
      {
        eligibility: 'ENHANCED_BARRED',
        barredListChecked: true,
        certificateNumber: '001234567890',
        issueDate: '2024-01-03',
        updateServiceConsent: false,
        riskDecision: 'CLEAR',
        policyReviewDate: nextYear,
      },
    ],
    ...[1, 2].map((n): [string, Record<string, unknown>] => [
      'references',
      {
        refereeName: `Synthetic referee ${n}`,
        refereeOrganisation: 'Synthetic employer',
        relationship: 'Line manager',
        requestedOn: '2023-12-01',
        receivedOn: '2023-12-10',
        outcome: 'SATISFACTORY',
      },
    ]),
    [
      'employment-history',
      { employer: 'Synthetic employer', role: 'Assistant', from: '2015-01-01' },
    ],
    [
      'training',
      { courseCode: 'CARE-CERT', title: 'Care Certificate (synthetic)', completedOn: '2024-02-01' },
    ],
    ['oh-clearance', { fitStatus: 'FIT', assessedOn: '2024-01-05' }],
  ];
  for (const [slug, data] of records) {
    const r = await hit(app, org, 'dev|hr', 'POST', `/api/v1/staff/${staffId}/${slug}`, { data });
    if (r.status !== 201)
      throw new Error(`schedule 3 ${slug}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  schedule3Done.add(staffId);
}

/** Candidate to Active through the real gate: checks, review, approval, activation. */
export async function activateStaff(
  app: Injector,
  org: string,
  staffId: string,
  roles: string[],
  approver = 'dev|hr',
) {
  await completeChecks(app, org, staffId, roles);
  const move = async (to: string) => {
    const r = await hit(app, org, 'dev|hr', 'POST', `/api/v1/staff/${staffId}/transition`, {
      to,
      reason: `To ${to}`,
    });
    if (r.status !== 201) throw new Error(`move ${to}: ${r.status} ${JSON.stringify(r.body)}`);
  };
  const s = await hit(app, org, 'dev|hr', 'GET', `/api/v1/staff/${staffId}`);
  if (s.body.lifecycleState === 'CHECKS_IN_PROGRESS') await move('READY_FOR_REVIEW');
  for (const role of roles) {
    const a = await hit(app, org, approver, 'POST', `/api/v1/staff/${staffId}/role-approvals`, {
      role,
      reason: 'Checks complete',
    });
    if (a.status !== 201) throw new Error(`approve ${role}: ${a.status} ${JSON.stringify(a.body)}`);
  }
  await move('APPROVED_FOR_ROLE');
  await move('ACTIVE');
}

/**
 * A verified driving licence check for one person (instance of a published, unmapped licence
 * requirement, so it only affects this person). Needed before the planner accepts them as driver.
 */
export async function addVerifiedLicence(app: Injector, org: string, staffId: string) {
  const code = `DRIVING-LICENCE-T${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e4)}`;
  const t = await hit(app, org, 'dev|admin', 'POST', '/api/v1/requirements/templates', {
    code,
    title: 'Driving licence entitlement (test)',
    version: {
      basisType: 'STATUTORY',
      subjectType: 'STAFF',
      recurrence: { type: 'EVENT_TRIGGERED' },
      blocking: 'STATUTORY',
      deadlineKind: 'EXPIRY',
    },
  });
  if (t.status !== 201) throw new Error(`licence template: ${t.status} ${JSON.stringify(t.body)}`);
  const p = await hit(
    app,
    org,
    'dev|manager',
    'POST',
    `/api/v1/requirements/templates/${t.body.id}/versions/${t.body.versions[0].id}/publish`,
  );
  if (p.status !== 201) throw new Error(`licence publish: ${p.status}`);
  const i = await hit(app, org, 'dev|manager', 'POST', '/api/v1/requirements/instances', {
    templateId: t.body.id,
    subjectType: 'STAFF',
    subjectId: staffId,
  });
  if (i.status !== 201) throw new Error(`licence instance: ${i.status} ${JSON.stringify(i.body)}`);
  await uploadAndVerify(app, org, [i.body.id as string], { verifier: 'dev|fleet' });
  return i.body.id as string;
}
