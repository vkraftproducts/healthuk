import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';

const ORG = '01900000-0000-7000-8000-000000000001';
const ME = '01900000-0000-7000-8000-000000000101';
const OTHER = '01900000-0000-7000-8000-000000000102';
const me = (permissions: string[]): MeResponse => ({
  user: { id: ME, email: 'm@example.test', displayName: 'Dev' },
  memberships: [
    {
      organisationId: ORG,
      organisationName: 'Meadowbank',
      locationId: null,
      roleKey: 'X',
      roleName: 'X',
    },
  ],
  permissions,
  activeOrganisationId: ORG,
  mfa: { required: true, satisfied: true },
});
const doc = (o: Record<string, unknown>) => ({
  id: crypto.randomUUID(),
  itemId: crypto.randomUUID(),
  versionNo: 1,
  title: 'licence.pdf',
  sensitivity: 'NORMAL',
  mime: 'application/pdf',
  sizeBytes: 2048,
  sha256: 'x',
  scanStatus: 'CLEAN',
  state: 'PENDING_VERIFICATION',
  uploadedBy: OTHER,
  uploadedByName: 'Hana HR',
  uploadedAt: '2026-11-03T10:00:00Z',
  validFrom: null,
  validTo: '2029-05-01',
  decision: null,
  decisionReason: null,
  reviewerId: null,
  reviewerName: null,
  decidedAt: null,
  linkedInstanceIds: [],
  mine: false,
  requirements: [
    {
      instanceId: crypto.randomUUID(),
      templateTitle: 'Driving licence',
      deadlineKind: 'EXPIRY',
      subjectType: 'STAFF',
      subjectId: crypto.randomUUID(),
      subjectLabel: 'Synthetic Crew (ST-0042)',
    },
  ],
  ...o,
});

function renderQueue(rows: unknown[], send = vi.fn(async () => ({}))) {
  const api: ApiClient = {
    me: async () => me(['compliance.evidence.verify', 'compliance.requirement.view']),
    readyz: async () => ({ status: 'ready' }),
    get: async (p) => (p === '/api/v1/evidence/review-queue' ? { data: rows } : { data: [] }),
    send,
  };
  render(<App api={api} history={createMemoryHistory({ initialEntries: ['/compliance'] })} />);
  return { send };
}

beforeEach(() => sessionStorage.clear());

describe('evidence review queue (B4)', () => {
  it('is the default compliance tab for a verifier and verifies with the confirmed expiry', async () => {
    const d = doc({});
    const { send } = renderQueue([d, doc({ title: 'mine.pdf', uploadedBy: ME, mine: true })]);
    const table = await screen.findByRole('table', { name: 'Evidence waiting for review' });
    const row = within(table).getByRole('row', { name: /licence\.pdf/ });
    expect(row).toHaveTextContent('Driving licence – Staff: Synthetic Crew (ST-0042)');
    expect(row).toHaveTextContent('by Hana HR');
    expect(row).toHaveTextContent('Until 1 May 2029');
    const mine = within(table).getByRole('row', { name: /mine\.pdf/ });
    expect(within(mine).queryByRole('button', { name: /Verify/ })).toBeNull();
    expect(mine).toHaveTextContent('another person must verify it');
    await userEvent.click(within(row).getByRole('button', { name: 'Verify licence.pdf' }));
    const dlg = await screen.findByRole('dialog', { name: 'Verify licence.pdf' });
    expect(within(dlg).getByLabelText('Confirmed expiry date (required)')).toHaveValue(
      '2029-05-01',
    );
    await userEvent.click(within(dlg).getByRole('button', { name: 'Verify' }));
    expect(send).toHaveBeenCalledWith('POST', `/api/v1/evidence/${d.id}/verify`, ORG, {
      decision: 'ACCEPTED',
      confirmedValidTo: '2029-05-01',
    });
  });

  it('reject needs a reason', async () => {
    const d = doc({});
    const { send } = renderQueue([d]);
    const table = await screen.findByRole('table', { name: 'Evidence waiting for review' });
    await userEvent.click(within(table).getByRole('button', { name: 'Reject licence.pdf' }));
    const dlg = await screen.findByRole('dialog');
    const ok = within(dlg).getByRole('button', { name: 'Reject' });
    expect(ok).toBeDisabled();
    await userEvent.type(within(dlg).getByRole('textbox'), 'Photo is unreadable');
    await userEvent.click(ok);
    expect(send).toHaveBeenCalledWith('POST', `/api/v1/evidence/${d.id}/verify`, ORG, {
      decision: 'REJECTED',
      reason: 'Photo is unreadable',
    });
  });
});
