import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';

// Workflow pass H1, L5 and navigation (written 6 Nov 2026; not yet run).
const ORG = '01900000-0000-7000-8000-000000000001';
const ME = '01900000-0000-7000-8000-000000000101';
const me = (permissions: string[]): MeResponse => ({
  user: { id: ME, email: 'w@example.test', displayName: 'Dev' },
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

function renderWith(
  path: string,
  permissions: string[],
  get: (p: string) => unknown,
  send = vi.fn(async (): Promise<unknown> => ({})),
) {
  const api: ApiClient = {
    me: async () => me(permissions),
    readyz: async () => ({ status: 'ready' }),
    get: async (p) => get(p) ?? { data: [] },
    send,
  };
  render(<App api={api} history={createMemoryHistory({ initialEntries: [path] })} />);
  return { send };
}

const overview = {
  generatedAt: '2026-11-06T10:00:00.000Z',
  publishedRating: { rating: 'GOOD', publishedOn: '2025-03-01', locationName: 'Watford' },
  coverage: {
    numerator: 8,
    denominator: 10,
    percent: 80,
    label: 'Internal measure — not a CQC rating',
  },
  keyQuestions: [
    {
      domain: 'SAFE',
      label: 'Safe',
      verified: 3,
      applicable: 4,
      openActions: 1,
      gaps: [{ title: 'Vehicle cleaning', reasonText: 'Evidence waiting for verification' }],
      audits: [
        {
          id: 'a1',
          code: 'AUD-102',
          title: 'Vehicle cleaning audit',
          submittedAt: '2026-10-21T09:00:00.000Z',
          outcome: 'RED',
        },
      ],
      policies: [],
    },
    {
      domain: 'CARING',
      label: 'Caring',
      verified: 0,
      applicable: 0,
      openActions: 0,
      gaps: [],
      audits: [],
      policies: [],
    },
  ],
};

describe('L5 inspection view', () => {
  it('shows the published rating and labels coverage as an internal measure', async () => {
    renderWith('/inspection', ['inspection.view', 'dashboard.view'], (p) =>
      p === '/api/v1/inspection/overview' ? overview : undefined,
    );
    const rating = await screen.findByRole('region', { name: 'Rating' });
    expect(rating).toHaveTextContent('Good – Watford');
    expect(rating).toHaveTextContent('80% (8 of 10) – Internal measure — not a CQC rating');
    expect(screen.getByText('No requirements set up for this key question.')).toBeInTheDocument();
    const audits = screen.getByRole('table', { name: 'Safe audits' });
    expect(within(audits).getByText(/Non-compliant/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save|edit|delete/i })).not.toBeInTheDocument();
  });

  it('an inspector without audit work lands on the inspection view', async () => {
    renderWith('/', ['inspection.view', 'dashboard.view'], (p) =>
      p === '/api/v1/inspection/overview' ? overview : undefined,
    );
    expect(await screen.findByRole('heading', { name: 'Inspection view' })).toBeInTheDocument();
  });
});

describe('H1 report an incident', () => {
  it('sends the report and shows the reference number to quote', async () => {
    const send = vi.fn(async (): Promise<unknown> => ({
      id: 'e1',
      code: 'EVT-0042',
      triageDueAt: '2026-11-09T23:59:59.000Z',
      stillAtRiskAlerted: true,
      message: 'Report EVT-0042 received.',
    }));
    renderWith(
      '/report',
      ['events.event.report'],
      (p) => (p === '/api/v1/incidents/types' ? { data: ['INCIDENT', 'COMPLAINT'] } : undefined),
      send,
    );
    const form = await screen.findByRole('form', { name: 'Report an incident' });
    await userEvent.type(within(form).getByLabelText('Short title'), 'Synthetic slip');
    await userEvent.type(
      within(form).getByLabelText('What happened'),
      'Synthetic: a slip on a wet floor.',
    );
    await userEvent.type(
      within(form).getByLabelText('Job or booking references (not names)'),
      'J-1234',
    );
    await userEvent.click(within(form).getByLabelText(/Someone is still at risk now/));
    await userEvent.click(within(form).getByRole('button', { name: 'Send report' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'POST',
        '/api/v1/incidents/report',
        ORG,
        expect.objectContaining({
          kind: 'INCIDENT',
          title: 'Synthetic slip',
          peopleRefs: ['J-1234'],
          stillAtRisk: true,
        }),
      ),
    );
    expect(await screen.findByText('Your reference number is EVT-0042.')).toBeInTheDocument();
  });

  it('asks for complaint details only when the report is a complaint', async () => {
    renderWith('/report', ['events.event.report'], (p) =>
      p === '/api/v1/incidents/types' ? { data: ['INCIDENT', 'COMPLAINT'] } : undefined,
    );
    const form = await screen.findByRole('form', { name: 'Report an incident' });
    expect(within(form).queryByLabelText('Date received')).not.toBeInTheDocument();
    await within(form).findByRole('option', { name: /complaint/i });
    await userEvent.selectOptions(
      within(form).getByLabelText('What are you reporting?'),
      'COMPLAINT',
    );
    expect(within(form).getByLabelText('Date received')).toBeInTheDocument();
  });
});

describe('navigation by role', () => {
  it('shows Inspection and Report an incident only to those who hold the permission', async () => {
    renderWith('/report', ['events.event.report', 'inspection.view'], () => undefined);
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: 'Inspection' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Report an incident' })).toBeInTheDocument();
  });

  it('hides them from someone without either permission', async () => {
    renderWith('/', ['staff.self.view'], () => undefined);
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    expect(within(nav).queryByRole('link', { name: 'Inspection' })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Report an incident' })).not.toBeInTheDocument();
  });
});
