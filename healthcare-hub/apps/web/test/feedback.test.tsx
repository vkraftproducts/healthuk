import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';

const ORG = '01900000-0000-7000-8000-000000000001';
const me = (orgId: string | null): MeResponse => ({
  user: {
    id: '01900000-0000-7000-8000-000000000101',
    email: 'm@example.test',
    displayName: 'Manager',
  },
  memberships: [
    {
      organisationId: ORG,
      organisationName: 'Org',
      locationId: null,
      roleKey: 'REGISTERED_MANAGER',
      roleName: 'Manager',
    },
  ],
  permissions: ['events.event.view', 'events.event.manage'],
  activeOrganisationId: orgId,
  mfa: { required: false, satisfied: true },
});

function setup() {
  const send = vi.fn(async () => ({}));
  const api = {
    me: async (o: string | null) => me(o),
    readyz: async () => ({ status: 'ready' as const }),
    get: async (p: string) =>
      p.startsWith('/api/v1/feedback/themes')
        ? {
            from: '2026-08-06',
            to: '2026-11-04',
            themes: [
              {
                theme: 'punctuality',
                compliments: 0,
                staffFeedback: 1,
                patientSurveys: 3,
                complaints: 2,
                total: 6,
                averageRating: 3.5,
              },
            ],
            totals: { feedback: 4, complaints: 2, untagged: 1 },
          }
        : p.startsWith('/api/v1/feedback')
          ? {
              data: [
                {
                  id: '1',
                  kind: 'PATIENT_SURVEY',
                  receivedOn: '2026-10-30',
                  locationId: null,
                  source: 'Post-journey survey',
                  summary: 'Driver was late but polite',
                  rating: 3,
                  themes: ['punctuality'],
                  openActions: 1,
                },
              ],
            }
          : { data: [] },
    send,
  } as unknown as ApiClient;
  render(
    <App
      api={api}
      history={createMemoryHistory({ initialEntries: ['/compliance?tab=feedback'] })}
    />,
  );
  return send;
}

describe('feedback, surveys and themes (EVT-04)', () => {
  it('shows themes across feedback and complaints, and the feedback list', async () => {
    setup();
    const theme = (await screen.findAllByRole('row', { name: /punctuality/ }))[0]!;
    expect(theme).toHaveTextContent('6');
    expect(theme).toHaveTextContent('3.5');
    expect(await screen.findByText(/1 have no theme yet/)).toBeInTheDocument();
    expect(await screen.findByRole('row', { name: /Post-journey survey/ })).toHaveTextContent(
      'Patient survey',
    );
  });

  it('records feedback with comma-separated themes', async () => {
    const send = setup();
    await userEvent.type(await screen.findByLabelText(/^Source/), 'Staff huddle');
    await userEvent.type(screen.getByLabelText(/^Summary/), 'Handover notes were clear');
    await userEvent.type(screen.getByLabelText(/^Themes, separated/), 'communication, handover');
    await userEvent.click(screen.getByRole('button', { name: 'Save feedback' }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    const call = send.mock.calls[0] as unknown[];
    expect(call[1]).toBe('/api/v1/feedback');
    expect(call[3]).toMatchObject({
      themes: ['communication', 'handover'],
      source: 'Staff huddle',
    });
  });
});
