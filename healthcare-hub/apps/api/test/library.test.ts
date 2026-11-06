import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Db } from '@hub/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, makeApp, sign, uploadAndVerify } from './harness.js';

// A5: publishing a requirement applies it at once to everything it covers.
const urls = inject('urls');
let app: NestFastifyApplication;
let db: Db;
const ORG = SEED_IDS.orgExample;
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: string, url: string, sub: string, body?: unknown) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: {
      authorization: `Bearer ${await sign({ sub })}`,
      'x-org-id': ORG,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as J };
}

beforeAll(async () => {
  ({ app, db } = await makeApp(urls));
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe('requirement library publish (A5)', () => {
  it('a published auto-apply vehicle requirement reaches every existing vehicle, and needs a second person', async () => {
    const code = `TVEH-${Date.now().toString(36).toUpperCase()}`;
    const t = await call('POST', '/api/v1/requirements/templates', 'dev|admin', {
      code,
      title: 'Synthetic vehicle check',
      version: {
        basisType: 'ORG_POLICY',
        subjectType: 'VEHICLE',
        applicabilityRule: { autoApply: true },
        recurrence: { type: 'COMPLETION_BASED', interval: { unit: 'YEARS', every: 1 } },
        blocking: 'NONE',
        deadlineKind: 'DUE',
      },
    });
    expect(t.status).toBe(201);
    const url = `/api/v1/requirements/templates/${t.body.id}/versions/${t.body.versions[0].id}/publish`;
    const self = await call('POST', url, 'dev|admin');
    expect([403, 422]).toContain(self.status); // author cannot publish (or lacks permission)
    const before = await call(
      'GET',
      `/api/v1/requirements/instances?subjectId=${SEED_IDS.vehicleAmb1}&limit=100`,
      'dev|manager',
    );
    expect((before.body.data as J[]).some((i) => i.templateCode === code)).toBe(false);
    expect((await call('POST', url, 'dev|manager')).status).toBe(201);
    const after = await call(
      'GET',
      `/api/v1/requirements/instances?subjectId=${SEED_IDS.vehicleAmb1}&limit=100`,
      'dev|manager',
    );
    const inst = (after.body.data as J[]).find((i) => i.templateCode === code);
    expect(inst).toBeDefined();
    expect(inst!.currentlyVerified ?? false).toBe(false);

    // B4: the uploaded document waits in the review queue with what it is for.
    const version = await uploadAndVerify(app, ORG, [inst!.id], {
      uploader: 'dev|fleet',
      verifier: null,
    });
    const queue = await call('GET', '/api/v1/evidence/review-queue', 'dev|manager');
    expect(queue.status).toBe(200);
    const item = (queue.body.data as J[]).find((x) => x.id === version);
    expect(item).toBeDefined();
    expect(item!.mine).toBe(false);
    expect(item!.requirements[0].subjectType).toBe('VEHICLE');
    expect(item!.requirements[0].templateTitle).toBe('Synthetic vehicle check');
    expect(item!.uploadedByName).toBeTruthy();
    const own = await call('GET', '/api/v1/evidence/review-queue', 'dev|fleet');
    expect((own.body.data as J[]).find((x) => x.id === version)!.mine).toBe(true);
    // Crew cannot see the queue.
    expect((await call('GET', '/api/v1/evidence/review-queue', 'dev|crew')).status).toBe(403);
    // Once verified it leaves the queue.
    const ok = await call('POST', `/api/v1/evidence/${version}/verify`, 'dev|manager', {
      decision: 'ACCEPTED',
    });
    expect(ok.status).toBe(201);
    const after2 = await call('GET', '/api/v1/evidence/review-queue', 'dev|manager');
    expect((after2.body.data as J[]).some((x) => x.id === version)).toBe(false);
  });
});
