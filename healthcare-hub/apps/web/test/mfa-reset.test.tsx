import { createMemoryHistory } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type MeResponse } from '@hub/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ApiClient } from '../src/api.js';
import { App } from '../src/App.js';

const ORG = '01900000-0000-7000-8000-000000000001';
const SELF = '01900000-0000-7000-8000-000000000101';
const me: MeResponse = {
  user: { id: SELF, email: 'admin@example.test', displayName: 'Olu Adeyemi' },
  memberships: [
    {
      organisationId: ORG,
      organisationName: 'Meadowbank Patient Transport',
      locationId: null,
      roleKey: 'ORG_ADMIN',
      roleName: 'Organisation administrator',
    },
  ],
  permissions: ['admin.users.manage', 'admin.org.manage'],
  activeOrganisationId: ORG,
  mfa: { required: true, satisfied: true },
};
const member = (id: string, displayName: string) => ({
  id,
  displayName,
  email: `${id}@example.test`,
  status: 'ACTIVE',
  memberships: [{ membershipId: `m-${id}`, roleName: 'HR lead', validTo: null }],
});
const rows: Record<string, unknown[]> = {
  '/api/v1/admin/users': [member('u1', 'Hana Rowe'), member(SELF, 'Olu Adeyemi')],
};

let sent: { method: string; path: string; body: unknown }[] = [];
function renderUsers() {
  const api = {
    me: async () => me,
    readyz: async () => ({ status: 'ready' }),
    get: async (path: string) => ({ data: rows[path] ?? [] }),
    send: async (method: string, path: string, _o: string | null, body: unknown) => {
      sent.push({ method, path, body });
      return { mfaReset: true };
    },
  } as unknown as ApiClient;
  render(<App api={api} history={createMemoryHistory({ initialEntries: ['/settings'] })} />);
}

beforeEach(() => {
  sent = [];
  sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Reset MFA (local sign-in, ADR 0006)', () => {
  it('resets a member’s MFA through a dialog that needs a reason', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'local');
    const confirmSpy = vi.spyOn(window, 'confirm');
    const promptSpy = vi.spyOn(window, 'prompt');
    renderUsers();
    fireEvent.click(await screen.findByRole('tab', { name: 'Users and roles' }));
    const button = await screen.findByRole('button', { name: 'Reset MFA: Hana Rowe' });
    // Never for yourself.
    expect(screen.queryByRole('button', { name: 'Reset MFA: Olu Adeyemi' })).toBeNull();

    await userEvent.click(button);
    const dialog = screen.getByRole('dialog', { name: 'Reset MFA for Hana Rowe' });
    const confirm = within(dialog).getByRole('button', { name: 'Reset MFA' });
    expect(confirm).toBeDisabled();
    await userEvent.type(
      within(dialog).getByLabelText(/Reason \(recorded in the audit log\)/),
      'Lost phone; identity checked in person',
    );
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent).toEqual([
      {
        method: 'POST',
        path: '/api/v1/admin/users/u1/mfa-reset',
        body: { reason: 'Lost phone; identity checked in person' },
      },
    ]);
    expect(screen.getByText(/MFA reset for Hana Rowe\./)).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('can be cancelled without sending anything', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'local');
    renderUsers();
    fireEvent.click(await screen.findByRole('tab', { name: 'Users and roles' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Reset MFA: Hana Rowe' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sent).toEqual([]);
  });

  it('is not offered when sign-in is not local (the authenticator is held elsewhere)', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'dev');
    renderUsers();
    fireEvent.click(await screen.findByRole('tab', { name: 'Users and roles' }));
    expect(await screen.findByRole('button', { name: 'Revoke access for Hana Rowe' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Reset MFA/ })).toBeNull();
  });
});
