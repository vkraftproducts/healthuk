import { createMemoryHistory } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
const preview = {
  id: '01900000-0000-7000-8000-0000000009a1',
  code: 'IMP-1',
  kind: 'STAFF',
  filename: 'staff.csv',
  status: 'PREVIEWED',
  rowCount: 2,
  validCount: 1,
  errorCount: 1,
  duplicateCount: 0,
  importedCount: 0,
  rows: [
    {
      rowNo: 2,
      status: 'VALID',
      data: { staffno: 'ST-8001', displayname: 'Synthetic One' },
      errors: [],
      duplicateOf: null,
      resultDetail: null,
    },
    {
      rowNo: 3,
      status: 'ERROR',
      data: { staffno: 'ST-8002' },
      errors: ['Location "Nowhere" not found'],
      duplicateOf: null,
      resultDetail: null,
    },
  ],
};
const item: Record<string, unknown> & { id: string } = {
  id: '01900000-0000-7000-8000-0000000009b1',
  sheet: 'Safe',
  rowNo: 3,
  promptCode: 'P-01',
  kind: 'PROMPT',
  text: 'Fire risk assessment for [ENTER PRACTICE NAME]',
  placeholders: ['[ENTER PRACTICE NAME]'],
  sourceStatus: 'Compliant',
  classification: 'SHARED',
  mappingStatus: 'PROPOSED',
  proposedCode: 'WB-FIRE',
  proposedTitle: 'Fire risk assessment',
};
function renderAt(permissions: string[]) {
  const sent: string[] = [];
  const api: ApiClient = {
    me: async () => me(permissions),
    readyz: async () => ({ status: 'ready' }),
    get: async (path: string) =>
      path.startsWith('/api/v1/workbook-items') ? { data: [item] } : { data: [] },
    send: async (_m: string, path: string) => {
      sent.push(path);
      return path === '/api/v1/imports' ? preview : {};
    },
  };
  render(<App api={api} history={createMemoryHistory({ initialEntries: ['/settings'] })} />);
  return sent;
}
beforeEach(() => sessionStorage.clear());

describe('import and export settings [PRD 4.12]', () => {
  it('previews a CSV with per-row results before anything is created', async () => {
    const sent = renderAt(['admin.import.manage', 'staff.profile.manage', 'admin.export.full']);
    fireEvent.click(await screen.findByRole('tab', { name: 'Import and export' }));
    const file = new File(['staffNo,displayName,location\n'], 'staff.csv', { type: 'text/csv' });
    await userEvent.upload(screen.getByLabelText('CSV file'), file);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(
      await screen.findByText('Preview ready. Nothing has been created yet.'),
    ).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Rows in IMP-1' });
    expect(within(table).getByText('Location "Nowhere" not found')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import 1 ready rows' })).toBeInTheDocument();
    expect(sent).toEqual(['/api/v1/imports']);
    expect(screen.getByRole('button', { name: 'Request full export' })).toBeInTheDocument();
  });

  it('a governance reviewer sees placeholders and source status as references and can decide', async () => {
    renderAt(['admin.requirements.publish']);
    fireEvent.click(await screen.findByRole('tab', { name: 'Import and export' }));
    expect(await screen.findByText('Unresolved: [ENTER PRACTICE NAME]')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Staged workbook rows' });
    expect(within(table).getByText('Compliant')).toBeInTheDocument();
    expect(
      within(table).getByRole('button', { name: 'Approve mapping: Safe row 3 P-01' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Import from CSV')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Request full export' })).toBeNull();
  });

  it('a reject needs a reason and sends it as the decision note', async () => {
    const sent = renderAt(['admin.requirements.publish']);
    fireEvent.click(await screen.findByRole('tab', { name: 'Import and export' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reject mapping: Safe row 3 P-01' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Reject mapping' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Why is it rejected\?/), {
      target: { value: 'Wrong subject' },
    });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(sent).toContain(`/api/v1/workbook-items/${item.id}/decision`));
  });

  it('the proposer cannot decide their own mapping', async () => {
    item.proposedBy = '01900000-0000-7000-8000-000000000101';
    item.proposedByName = 'Dev';
    try {
      renderAt(['admin.requirements.publish']);
      fireEvent.click(await screen.findByRole('tab', { name: 'Import and export' }));
      expect(
        await screen.findByText('You proposed this; someone else decides.'),
      ).toBeInTheDocument();
      expect(screen.getByText('Proposed by Dev')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Approve mapping/ })).toBeNull();
    } finally {
      delete item.proposedBy;
      delete item.proposedByName;
    }
  });
});
