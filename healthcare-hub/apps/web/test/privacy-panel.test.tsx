import { createMemoryHistory } from '@tanstack/react-router';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { MeResponse } from '@hub/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';

const ORG = '01900000-0000-7000-8000-000000000001';
const me = (permissions: string[]): MeResponse => ({
  user: { id: '01900000-0000-7000-8000-000000000101', email: 'm@example.test', displayName: 'Dev' },
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
const data: Record<string, unknown[]> = {
  '/api/v1/retention-rules': [
    {
      id: 'r1',
      category: 'PATIENT_CONTACT',
      retainMonths: 96,
      triggerDesc: 'Journey date',
      action: 'REVIEW',
      candidates: 3,
      held: 1,
      status: 'REQUIRES_APPROVAL',
      basis: 'Placeholder: confirm',
    },
  ],
  '/api/v1/breaches': [
    {
      id: 'b1',
      code: 'BRE-1',
      title: 'Rota sent to wrong address',
      icoDeadline: '2026-11-03T09:00:00Z',
      clock: 'DUE_SOON',
      status: 'OPEN',
    },
  ],
};
function renderAt(permissions: string[]) {
  const api: ApiClient = {
    me: async () => me(permissions),
    readyz: async () => ({ status: 'ready' }),
    get: async (path: string) => ({ data: data[path] ?? [] }),
    send: async () => ({}),
  };
  render(<App api={api} history={createMemoryHistory({ initialEntries: ['/settings'] })} />);
}
beforeEach(() => sessionStorage.clear());

describe('data protection settings', () => {
  it('shows placeholder rules as requiring approval (no approve until a basis is recorded) and the ICO clock in words', async () => {
    renderAt(['privacy.manage']);
    fireEvent.click(await screen.findByRole('tab', { name: 'Data protection' }));
    expect(await screen.findByText('3 (1 on hold)')).toBeInTheDocument();
    const rules = screen.getByRole('table', { name: 'Retention rules' });
    expect(within(rules).getByText(/Requires approval/)).toBeInTheDocument();
    expect(within(rules).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(await screen.findByText(/ICO deadline within 24 hours/)).toBeInTheDocument();
  });

  it('is hidden without the privacy permission', async () => {
    renderAt(['admin.audit.view']);
    await screen.findByRole('tab', { name: 'Audit log' });
    expect(screen.queryByRole('tab', { name: 'Data protection' })).toBeNull();
  });
});
