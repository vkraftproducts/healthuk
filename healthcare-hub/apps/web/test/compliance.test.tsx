import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
      organisationName: 'Meadowbank Patient Transport',
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

describe('compliance actions list', () => {
  const base = { status: 'OPEN', ownerUserId: 'other' };
  const list = [
    action({ ...base, code: 'ACT-1', title: 'Clean', sourceType: 'FINDING', auditRunId: 'r1' }),
    action({
      ...base,
      code: 'ACT-2',
      title: 'Again',
      sourceType: 'FINDING',
      auditRunId: 'r1',
      kind: 'REAUDIT',
      reauditRunId: 'r2',
    }),
    action({ ...base, code: 'ACT-3', title: 'Learn', sourceType: 'EVENT' }),
    action({ ...base, code: 'ACT-4', title: 'Reduce', sourceType: 'RISK' }),
    action({ ...base, code: 'ACT-5', title: 'Reply', sourceType: 'CORRESPONDENCE' }),
  ];
  const open = () => {
    const api: ApiClient = {
      me: async () => me(['compliance.audit.view', 'compliance.risk.manage', 'events.event.view']),
      readyz: async () => ({ status: 'ready' }),
      get: async (p: string) => ({ data: p.startsWith('/api/v1/actions') ? list : [] }),
      send: async () => ({}),
    };
    render(
      <App
        api={api}
        history={createMemoryHistory({ initialEntries: ['/compliance?tab=actions'] })}
      />,
    );
  };
  it('links each action and its next step to where the work is done', async () => {
    open();
    await screen.findByRole('table', { name: 'Open actions' });
    const expected: [string, string, string][] = [
      ['ACT-1 Clean', 'Open the audit', `/compliance/audits/r1`],
      ['ACT-2 Again (re-audit)', 'Complete the re-audit', `/compliance/audits/r2`],
      ['ACT-3 Learn', 'Open the event', '/compliance?tab=events'],
      ['ACT-4 Reduce', 'Open the risk', '/compliance?tab=risks'],
      ['ACT-5 Reply', 'Open the registration records', '/compliance?tab=registration'],
    ];
    for (const [title, step, href] of expected) {
      const row = screen.getByRole('row', { name: new RegExp(title.replace(/[()]/g, '.')) });
      expect(within(row).getByRole('link', { name: title })).toHaveAttribute('href', href);
      expect(within(row).getByRole('link', { name: step })).toHaveAttribute('href', href);
    }
  });
  it('switches tab when a link names another tab on the same page, and keeps tabs in the URL', async () => {
    open();
    await userEvent.click(await screen.findByRole('link', { name: 'Open the risk' }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Risk register' })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Actions' }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Actions' })).toHaveAttribute('aria-selected', 'true'),
    );
    await userEvent.click(await screen.findByRole('link', { name: 'Open the risk' }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Risk register' })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
  });
});

describe('uploading evidence for an action', () => {
  afterEach(() => vi.unstubAllGlobals());
  const rows = [
    action({
      id: 'a1',
      code: 'ACT-1',
      title: 'Mine',
      ownerUserId: ME,
      status: 'OPEN',
      sourceType: 'FINDING',
      auditRunId: 'r1',
    }),
    action({
      id: 'a2',
      code: 'ACT-2',
      title: 'From event',
      ownerUserId: ME,
      status: 'REJECTED',
      sourceType: 'EVENT',
    }),
    action({
      id: 'a3',
      code: 'ACT-3',
      title: 'Re-audit',
      ownerUserId: ME,
      status: 'OPEN',
      sourceType: 'FINDING',
      kind: 'REAUDIT',
      reauditRunId: 'r2',
    }),
    action({
      id: 'a4',
      code: 'ACT-4',
      title: 'Someone else',
      ownerUserId: 'other',
      status: 'OPEN',
      sourceType: 'FINDING',
      auditRunId: 'r1',
    }),
    action({
      id: 'a5',
      code: 'ACT-5',
      title: 'Finished',
      ownerUserId: ME,
      status: 'VERIFIED',
      sourceType: 'FINDING',
      auditRunId: 'r1',
    }),
    action({
      id: 'a6',
      code: 'ACT-6',
      title: 'Sent',
      ownerUserId: ME,
      status: 'EVIDENCE_SUBMITTED',
      sourceType: 'RISK',
    }),
  ];
  const open = async (permissions: string[], send: ApiClient['send'] = async () => ({})) => {
    const api: ApiClient = {
      me: async () => me(['compliance.audit.view', ...permissions]),
      readyz: async () => ({ status: 'ready' }),
      get: async () => ({ data: rows }),
      send,
    };
    render(
      <App
        api={api}
        history={createMemoryHistory({ initialEntries: ['/compliance?tab=actions'] })}
      />,
    );
    await screen.findByRole('table', { name: 'Open actions' });
  };
  const uploadable = () =>
    screen
      .queryAllByRole('button', { name: /evidence for ACT-/ })
      .map((b) => b.getAttribute('aria-label'));

  it('offers upload on every open action of its owner, whatever raised it', async () => {
    await open(['compliance.evidence.upload']);
    expect(uploadable()).toEqual([
      'Upload evidence for ACT-1',
      'Upload evidence for ACT-2',
      'Add evidence for ACT-6',
    ]);
    expect(screen.getByRole('row', { name: /ACT-4/ })).toHaveTextContent('Open the audit');
  });
  it("offers upload on other people's actions to those who manage actions, as the API allows", async () => {
    await open(['compliance.evidence.upload', 'compliance.action.manage']);
    expect(uploadable()).toContain('Upload evidence for ACT-4');
  });
  it('offers no upload without the upload permission', async () => {
    await open(['compliance.action.manage']);
    expect(uploadable()).toEqual([]);
  });
  it('submits the file against the action whose button was pressed', async () => {
    const put = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', put);
    const send = vi.fn(async () => ({
      uploadUrl: 'http://api.test/blob',
      evidenceVersionId: 'ver',
      evidenceItemId: 'item',
    }));
    await open(['compliance.evidence.upload'], send as unknown as ApiClient['send']);
    await userEvent.click(screen.getByRole('button', { name: 'Upload evidence for ACT-2' }));
    await userEvent.upload(
      screen.getByLabelText('Action evidence file'),
      new File(['x'], 'proof.pdf', { type: 'application/pdf' }),
    );
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/actions/a2/evidence', ORG, {
        evidenceItemIds: ['item'],
      }),
    );
    expect(put).toHaveBeenCalledWith(
      'http://api.test/blob',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(await screen.findByRole('status', { name: '' })).toHaveTextContent(/Evidence submitted/);
  });
});

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
