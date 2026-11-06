import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';

const ORG = '01900000-0000-7000-8000-000000000001';
const ME = '01900000-0000-7000-8000-000000000101';
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
const version = (o: Record<string, unknown>) => ({
  id: crypto.randomUUID(),
  version: 1,
  status: 'EFFECTIVE',
  basisType: 'STATUTORY',
  regulationRef: 'Reg 19 Schedule 3',
  subjectType: 'STAFF',
  recurrence: { type: 'INTERVAL', interval: { unit: 'YEARS', every: 3 } },
  blocking: 'STATUTORY',
  deadlineKind: 'DUE',
  createdBy: 'someone-else',
  ...o,
});
const LIB_AMB = {
  id: 'lib1',
  code: 'AMB-STF-01',
  title: 'Enhanced DBS check',
  pack: 'AMBULANCE_V1',
  isLibrary: true,
  versions: [version({})],
};
const LIB_DEN = {
  id: 'lib2',
  code: 'DEN-STF-01',
  title: 'GDC registration',
  pack: 'DENTAL_V1',
  isLibrary: true,
  versions: [version({})],
};
const OURS_DRAFT = {
  id: 'o1',
  code: 'AMB-STF-02',
  title: 'Right to work',
  pack: 'AMBULANCE_V1',
  isLibrary: false,
  versions: [version({ status: 'DRAFT' })],
};
const OURS_MINE = {
  id: 'o2',
  code: 'AMB-STF-03',
  title: 'References',
  pack: 'AMBULANCE_V1',
  isLibrary: false,
  versions: [version({ status: 'DRAFT', createdBy: ME })],
};

function renderLib(permissions: string[], send = vi.fn(async () => ({}))) {
  const api: ApiClient = {
    me: async () => me(permissions),
    readyz: async () => ({ status: 'ready' }),
    get: async (p) =>
      p === '/api/v1/requirements/templates'
        ? { data: [LIB_AMB, LIB_DEN, OURS_DRAFT, OURS_MINE] }
        : { data: [] },
    send,
  };
  render(<App api={api} history={createMemoryHistory({ initialEntries: ['/settings'] })} />);
  return { send };
}
const ALL = [
  'admin.settings.manage',
  'admin.requirements.publish',
  'compliance.requirement.manage',
  'staff.profile.manage',
];

beforeEach(() => sessionStorage.clear());

describe('requirement library (Settings)', () => {
  it('adopts an ambulance item as a draft with an in-app dialog', async () => {
    const { send } = renderLib(ALL);
    await userEvent.click(await screen.findByRole('tab', { name: 'Requirement library' }));
    const lib = await screen.findByRole('table', { name: 'Library items' });
    expect(within(lib).getByRole('row', { name: /Enhanced DBS/ })).toHaveTextContent(
      'Every 3 years',
    );
    await userEvent.click(within(lib).getByRole('button', { name: 'Adopt Enhanced DBS check' }));
    const d = await screen.findByRole('dialog', { name: /Adopt Enhanced DBS check/ });
    await userEvent.click(within(d).getByRole('button', { name: 'Adopt as draft' }));
    expect(send).toHaveBeenCalledWith('POST', '/api/v1/requirements/templates/lib1/adopt', ORG, {});
  });

  it('a sector pack needs the validating specialist named', async () => {
    const { send } = renderLib(ALL);
    await userEvent.click(await screen.findByRole('tab', { name: 'Requirement library' }));
    await userEvent.selectOptions(await screen.findByLabelText('Pack'), 'DENTAL_V1');
    expect(screen.getByRole('note')).toHaveTextContent('has not been validated');
    await userEvent.click(screen.getByRole('button', { name: 'Adopt GDC registration' }));
    const d = await screen.findByRole('dialog');
    const ok = within(d).getByRole('button', { name: 'Adopt as draft' });
    expect(ok).toBeDisabled();
    await userEvent.type(within(d).getByLabelText(/Specialist who validated/), 'Dr A Example');
    expect(ok).toBeDisabled();
    await userEvent.type(within(d).getByLabelText(/Their organisation/), 'Dental Advisers Ltd');
    await userEvent.click(ok);
    expect(send).toHaveBeenCalledWith('POST', '/api/v1/requirements/templates/lib2/adopt', ORG, {
      specialistValidatedBy: 'Dr A Example',
      specialistOrganisation: 'Dental Advisers Ltd',
    });
  });

  it('publish is offered to a second person only, and unmapped roles are flagged', async () => {
    renderLib(ALL);
    await userEvent.click(await screen.findByRole('tab', { name: 'Requirement library' }));
    const ours = await screen.findByRole('table', {
      name: 'Requirements adopted by this organisation',
    });
    expect(within(ours).getByRole('button', { name: 'Publish Right to work' })).toBeEnabled();
    expect(within(ours).getByRole('button', { name: 'Publish References' })).toBeDisabled();
    expect(
      screen.getAllByText('Nothing mapped: nobody can be approved for this role.').length,
    ).toBeGreaterThan(0);
  });
});
