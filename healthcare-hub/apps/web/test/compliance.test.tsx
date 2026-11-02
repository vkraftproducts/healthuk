import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import type { MeResponse } from '@hub/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';

const ORG = '01900000-0000-7000-8000-000000000001';
const ME = '01900000-0000-7000-8000-000000000101';
const RUN = '01900000-0000-7000-8000-000000000401';
const me = (permissions: string[]): MeResponse => ({
  user: { id: ME, email: 'g@example.test', displayName: 'Dev' },
  memberships: [
    {
      organisationId: ORG,
      organisationName: 'Example organisation',
      locationId: null,
      roleKey: 'X',
      roleName: 'X',
    },
  ],
  permissions,
  activeOrganisationId: ORG,
  mfa: { required: true, satisfied: true },
});
const action = (o: Record<string, unknown>) => ({
  id: crypto.randomUUID(),
  kind: 'ACTION',
  severity: 'HIGH',
  deadline: '2026-10-29',
  overdue: false,
  history: [],
  evidenceItemIds: [],
  ...o,
});
const run = {
  id: RUN,
  code: 'AUD-102',
  title: 'Vehicle cleaning audit',
  domain: 'SAFE',
  templateCode: 'AC-07',
  dueDate: '2026-10-21',
  periodFrom: '2026-10-01',
  periodTo: '2026-10-21',
  status: 'ACTIONS_OPEN',
  outcome: 'RED',
  outcomeReason: 'Action outstanding',
  submittedAt: '2026-10-21T16:00:00Z',
  ownerUserId: ME,
  samples: [
    {
      id: 's',
      populationDesc: 'Pre-shift cleaning records',
      selectionMethod: 'Random',
      subjectIds: ['a', 'b', 'c', 'd', 'e'],
    },
  ],
  controls: [{ code: 'AC-07', question: 'Premises and equipment', critical: true }],
  findings: [
    { id: 'f', controlCode: 'AC-07', summary: '4 pass / 1 fail', result: 'NON_COMPLIANT' },
  ],
  actions: [
    action({
      code: 'ACT-218',
      title: 'Investigate missed clean',
      ownerUserId: ME,
      status: 'EVIDENCE_SUBMITTED',
    }),
    action({
      code: 'ACT-219',
      title: 'Re-audit vehicle cleaning',
      ownerUserId: 'other',
      status: 'OPEN',
      kind: 'REAUDIT',
    }),
  ],
};
function renderAt(path: string, permissions: string[]) {
  const api: ApiClient = {
    me: async () => me(permissions),
    readyz: async () => ({ status: 'ready' }),
    get: async () => run,
    send: async () => ({}),
  };
  render(<App api={api} history={createMemoryHistory({ initialEntries: [path] })} />);
}
beforeEach(() => sessionStorage.clear());

describe('audit workspace (wireframe 03)', () => {
  it('shows the finding, the outcome in words, and that closure requires verification', async () => {
    renderAt(`/compliance/audits/${RUN}`, ['compliance.audit.view', 'compliance.action.verify']);
    expect(
      await screen.findByRole('heading', { name: /AUD-102 Vehicle cleaning audit/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Closure requires verification.')).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /AC-07/ })).toHaveTextContent(
      'Non compliant – 4 pass / 1 fail',
    );
    expect(
      screen.getByText(/Original audit, findings and source version remain unchanged/),
    ).toBeInTheDocument();
  });
  it('the owner of an action cannot verify it; the re-audit is closed by completing it', async () => {
    renderAt(`/compliance/audits/${RUN}`, ['compliance.audit.view', 'compliance.action.verify']);
    const table = await screen.findByRole('table', { name: 'Actions from this audit' });
    const own = within(table).getByRole('row', { name: /ACT-218/ });
    expect(within(own).queryByRole('button', { name: 'Verify' })).toBeNull();
    expect(own).toHaveTextContent('Awaiting a verifier');
    expect(within(table).getByRole('row', { name: /ACT-219/ })).toHaveTextContent(
      'Complete the re-audit',
    );
  });
});
