import { createMemoryHistory } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const people = [
  { id: ME, displayName: 'Dev', roleKeys: [], roleNames: ['Governance lead'], locationIds: [] },
  { id: 'u3', displayName: 'Sam Manager', roleKeys: [], roleNames: ['Manager'], locationIds: [] },
];
function renderWith(
  path: string,
  permissions: string[],
  get: (p: string) => unknown,
  send = vi.fn(async () => ({})),
) {
  const api: ApiClient = {
    me: async () => me(permissions),
    readyz: async () => ({ status: 'ready' }),
    get: async (p) => (p === '/api/v1/admin/people' ? { data: people } : get(p)),
    send,
  };
  render(<App api={api} history={createMemoryHistory({ initialEntries: [path] })} />);
  return { send };
}
const version = (o: Record<string, unknown>) => ({
  version: 1,
  controls: [{ code: 'AC-07', question: 'Vehicle cleaned before shift', critical: true }],
  methods: ['RECORDS'],
  sampleMethod: null,
  sampleSize: null,
  createdBy: 'u2',
  createdByName: 'Priya Governance',
  approvedBy: null,
  approvedByName: null,
  approvedAt: null,
  ...o,
});

describe('audit schedule and templates [task 9]', () => {
  const templates = [
    {
      id: 't1',
      code: 'AC-07',
      title: 'Vehicle cleaning',
      domain: 'SAFE',
      active: true,
      versions: [
        version({
          id: 'v1',
          status: 'PUBLISHED',
          approvedBy: 'u3',
          approvedByName: 'Sam Manager',
          approvedAt: '2026-10-01T09:00:00Z',
        }),
      ],
    },
    {
      id: 't2',
      code: 'AC-08',
      title: 'Medicines',
      domain: 'SAFE',
      active: false,
      versions: [version({ id: 'v2', status: 'DRAFT', createdBy: ME, createdByName: 'Dev' })],
    },
    {
      id: 't3',
      code: 'AC-09',
      title: 'Hand hygiene',
      domain: 'SAFE',
      active: false,
      versions: [version({ id: 'v3', status: 'PUBLISHED', approvedByName: 'Sam Manager' })],
    },
  ];
  const runs = [
    {
      ...run,
      status: 'IN_PROGRESS',
      outcome: null,
      overdue: true,
      auditorName: 'Priya Governance',
      ownerName: 'Sam Manager',
    },
  ];
  const get = (p: string) =>
    p.startsWith('/api/v1/audit-templates')
      ? { data: templates }
      : p.startsWith('/api/v1/audit-runs')
        ? { data: runs }
        : p.includes('/locations')
          ? { data: [{ id: 'l1', name: 'Main depot', archived: false }] }
          : { data: [] };
  const perms = ['compliance.audit.view', 'compliance.audit.run', 'compliance.requirement.manage'];

  it('lists audits with names, an overdue warning in words, and the stage', async () => {
    renderWith('/compliance?tab=audits', perms, get);
    const row = await screen.findByRole('row', { name: /AUD-102/ });
    expect(row).toHaveTextContent('Auditor: Priya Governance');
    expect(row).toHaveTextContent('Owner: Sam Manager');
    expect(row).toHaveTextContent('Red – Overdue – was due 21 Oct 2026');
    expect(row).toHaveTextContent('In progress');
  });

  it('schedules an audit from an active template with a named auditor and owner', async () => {
    const { send } = renderWith('/compliance?tab=audits', perms, get);
    const form = await screen.findByRole('heading', { name: 'Schedule an audit' });
    expect(form).toBeInTheDocument();
    const template = screen.getByLabelText('Template');
    expect(
      within(template)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['AC-07 Vehicle cleaning (v1)']);
    await userEvent.type(screen.getByLabelText('Audit title'), 'November cleaning');
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-11-30' } });
    await userEvent.selectOptions(screen.getByLabelText('Owner (acts on the findings)'), 'u3');
    await userEvent.click(screen.getByRole('button', { name: 'Schedule audit' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/audit-runs', ORG, {
        templateVersionId: 'v1',
        title: 'November cleaning',
        auditorUserId: ME,
        ownerUserId: 'u3',
        dueDate: '2026-11-30',
      }),
    );
  });

  it('the author cannot publish their own draft; activation is confirmed in a dialog', async () => {
    const { send } = renderWith('/compliance?tab=audits', perms, get);
    const own = await screen.findByRole('row', { name: /AC-08 Medicines/ });
    expect(own).toHaveTextContent('You wrote this version, so someone else must publish it.');
    expect(within(own).queryByRole('button', { name: /Publish/ })).toBeNull();
    expect(own).toHaveTextContent('Grey – Draft – awaiting a second person to publish');
    const t3 = screen.getByRole('row', { name: /AC-09 Hand hygiene/ });
    expect(t3).toHaveTextContent('Amber – Published – awaiting activation');
    await userEvent.click(within(t3).getByRole('button', { name: 'Activate: AC-09 Hand hygiene' }));
    const dialog = screen.getByRole('dialog', { name: 'Activate: AC-09 Hand hygiene' });
    expect(dialog).toHaveTextContent('Written by Priya Governance; published by Sam Manager');
    expect(dialog).toHaveTextContent('AC-07: Vehicle cleaned before shift (critical control)');
    expect(send).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Activate' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/audit-templates/t3/activate', ORG, {}),
    );
  });

  it('shows the controls of a template without changing anything', async () => {
    const { send } = renderWith('/compliance?tab=audits', ['compliance.audit.view'], get);
    await userEvent.click(
      await screen.findByRole('button', { name: 'View controls: AC-07 Vehicle cleaning' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Controls: AC-07 Vehicle cleaning' });
    expect(dialog).toHaveTextContent('published by Sam Manager, 1 Oct 2026, 10:00');
    expect(screen.queryByRole('heading', { name: 'Schedule an audit' })).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(send).not.toHaveBeenCalled();
  });
});

describe('carrying out an audit [task 9]', () => {
  const openRun = {
    ...run,
    status: 'IN_PROGRESS',
    outcome: null,
    outcomeReason: null,
    submittedAt: null,
    auditorUserId: ME,
    auditorName: 'Dev',
    ownerUserId: 'u3',
    ownerName: 'Sam Manager',
    overdue: false,
    methods: ['RECORDS', 'OBSERVATION'],
    samples: [
      {
        id: 's',
        populationDesc: 'Crew on shift',
        selectionMethod: 'Random',
        dateFrom: '2026-10-01',
        dateTo: '2026-10-21',
        subjectType: 'STAFF',
        subjectIds: ['s1'],
        repeatWarning: [],
      },
    ],
    responses: [
      {
        id: 'r1',
        controlCode: 'AC-07',
        subjectId: 's1',
        result: 'PARTIAL',
        method: 'RECORDS',
        note: 'Two logs missing',
        recordedBy: 'u2',
        recordedByName: 'Priya Governance',
        recordedAt: '2026-10-20T10:15:00Z',
      },
    ],
    findings: [],
    actions: [],
  };
  const staff = [
    { id: 's1', displayName: 'Alex Crew', staffNo: 'S0001' },
    { id: 's2', displayName: 'Bea Crew', staffNo: 'S0002' },
  ];
  const get = (p: string) =>
    p.startsWith('/api/v1/audit-runs')
      ? openRun
      : p.startsWith('/api/v1/staff')
        ? { data: staff }
        : { data: [] };
  const perms = ['compliance.audit.view', 'compliance.audit.run'];

  it('shows responses with the item, who recorded them and when, in UK format', async () => {
    renderWith(`/compliance/audits/${RUN}`, perms, get);
    const row = await screen.findByRole('row', { name: /Two logs missing/ });
    expect(row).toHaveTextContent('Alex Crew (S0001)');
    expect(row).toHaveTextContent('Amber – Partial');
    expect(row).toHaveTextContent('Priya Governance, 20 Oct 2026, 11:15');
    expect(
      screen.getByText(/Crew on shift – Random \(1, 1 Oct 2026 to 21 Oct 2026\)/),
    ).toBeInTheDocument();
  });

  it('records a response against a sampled item; a failed answer asks for a note', async () => {
    const { send } = renderWith(`/compliance/audits/${RUN}`, perms, get);
    const form = await screen.findByRole('form', { name: 'Record a response' });
    await userEvent.selectOptions(within(form).getByLabelText('Sampled item (optional)'), 's1');
    await userEvent.selectOptions(within(form).getByLabelText('Result'), 'NON_COMPLIANT');
    await userEvent.selectOptions(within(form).getByLabelText('How it was checked'), 'OBSERVATION');
    await userEvent.type(
      within(form).getByLabelText('Note (required for this result)'),
      'Cab not cleaned',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Save response' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', `/api/v1/audit-runs/${RUN}/responses`, ORG, {
        responses: [
          {
            controlCode: 'AC-07',
            subjectId: 's1',
            result: 'NON_COMPLIANT',
            method: 'OBSERVATION',
            note: 'Cab not cleaned',
          },
        ],
      }),
    );
  });

  it('records a sample by picking named items', async () => {
    const { send } = renderWith(`/compliance/audits/${RUN}`, perms, get);
    const form = await screen.findByRole('form', { name: 'Record the sample' });
    await userEvent.type(
      within(form).getByLabelText('Population (what you sampled from)'),
      'Night crew',
    );
    await userEvent.type(within(form).getByLabelText('How the sample was chosen'), 'Every other');
    fireEvent.change(within(form).getByLabelText('Records from'), {
      target: { value: '2026-10-01' },
    });
    fireEvent.change(within(form).getByLabelText('Records to'), {
      target: { value: '2026-10-31' },
    });
    await userEvent.click(await within(form).findByLabelText('Bea Crew (S0002)'));
    await userEvent.click(within(form).getByRole('button', { name: 'Record sample' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', `/api/v1/audit-runs/${RUN}/samples`, ORG, {
        populationDesc: 'Night crew',
        selectionMethod: 'Every other',
        dateFrom: '2026-10-01',
        dateTo: '2026-10-31',
        subjectType: 'STAFF',
        subjectIds: ['s2'],
      }),
    );
  });

  it('submitting is confirmed and explains that responses are then fixed', async () => {
    const { send } = renderWith(`/compliance/audits/${RUN}`, perms, get);
    await userEvent.click(await screen.findByRole('button', { name: 'Submit for review' }));
    const dialog = screen.getByRole('dialog', {
      name: 'Submit for review: AUD-102 Vehicle cleaning audit',
    });
    expect(dialog).toHaveTextContent('Responses are fixed once submitted');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Submit for review' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', `/api/v1/audit-runs/${RUN}/submit`, ORG, {}),
    );
  });

  it('after submission a reviewer raises a re-audit from a failed finding', async () => {
    const { send } = renderWith(
      `/compliance/audits/${RUN}`,
      ['compliance.audit.view', 'compliance.audit.run', 'compliance.action.manage'],
      (p) => (p.startsWith('/api/v1/audit-runs') ? run : { data: [] }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Raise an action: AC-07' }));
    expect(screen.queryByRole('form', { name: 'Record a response' })).toBeNull();
    const dialog = screen.getByRole('dialog', {
      name: 'Raise an action: AC-07: Premises and equipment',
    });
    const confirm = within(dialog).getByRole('button', { name: 'Raise action' });
    expect(confirm).toBeDisabled();
    await userEvent.selectOptions(within(dialog).getByLabelText('Type'), 'REAUDIT');
    await userEvent.type(
      within(dialog).getByLabelText('What needs to happen'),
      'Re-check cleaning',
    );
    await userEvent.selectOptions(within(dialog).getByLabelText('Owner'), 'u3');
    fireEvent.change(within(dialog).getByLabelText('Deadline'), {
      target: { value: '2026-12-01' },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Schedule re-audit' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/findings/f/actions', ORG, {
        title: 'Re-check cleaning',
        ownerUserId: 'u3',
        deadline: '2026-12-01',
        kind: 'REAUDIT',
      }),
    );
    expect(screen.getByRole('button', { name: 'Add an observation' })).toBeInTheDocument();
  });
});
