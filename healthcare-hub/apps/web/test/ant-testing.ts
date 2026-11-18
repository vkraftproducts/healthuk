import { screen, waitFor, within, type BoundFunctions, type queries } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect } from 'vitest';

/** Wait until an Ant Design table is no longer showing its loading placeholder. */
export async function waitForTableReady(
  table: HTMLElement,
  scope: BoundFunctions<typeof queries> = within(table),
) {
  await waitFor(() => {
    expect(scope.queryByText('Loading…')).not.toBeInTheDocument();
  });
}

/** Opens an Ant Design Select found by its field label. */
export async function openAntSelect(label: string | RegExp) {
  // Ant Select's combobox input is opacity:0; look up by visible field label text.
  const labelNode = await screen.findByText(label, { selector: 'label span, label' });
  const container = labelNode.closest('label') ?? labelNode.parentElement!;
  const combo = within(container as HTMLElement).getByRole('combobox', { hidden: true });
  await userEvent.click(combo);
  // Closed dropdowns stay in the page: the open one is the last listbox.
  const all = await screen.findAllByRole('listbox');
  return all[all.length - 1]!;
}

/** Chooses an option from an open Ant Design Select listbox. */
export async function chooseAntOption(name: string | RegExp) {
  // Ant renders a hidden a11y listbox (role="option", not clickable) and the visible items
  // (.ant-select-item-option). Click the visible item; fall back to the a11y option.
  await screen.findAllByRole('listbox');
  const match = (t: string | null) =>
    t !== null && (typeof name === 'string' ? t.trim() === name : name.test(t));
  const items = [
    ...document.querySelectorAll<HTMLElement>(
      '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option',
    ),
  ];
  const item = items.find((el) => match(el.getAttribute('title')) || match(el.textContent));
  if (item) {
    await userEvent.click(item);
    return;
  }
  const all = await screen.findAllByRole('listbox');
  await userEvent.click(within(all[all.length - 1]!).getByRole('option', { name }));
}

/** Select by visible field label (Ant Design). */
export async function selectAntByLabel(label: string | RegExp, optionName: string | RegExp) {
  await openAntSelect(label);
  await chooseAntOption(optionName);
}

/** Confirm button inside the latest open dialog. */
export async function confirmDialog(buttonName: string | RegExp) {
  const dialog = await findDialog();
  await userEvent.click(within(dialog).getByRole('button', { name: buttonName }));
}

/** Ant Design Modal — wait for dialog role and optional accessible name (title). */
export async function findDialog(name?: string | RegExp) {
  return name !== undefined ? screen.findByRole('dialog', { name }) : screen.findByRole('dialog');
}
/** v36 Settings: [group tab, view inside it] for each section (old names kept as aliases). */
const SETTINGS_VIEW: Record<string, [string, string]> = {
  'Users and roles': ['Access & escalation', 'Accounts & roles'],
  'Accounts & roles': ['Access & escalation', 'Accounts & roles'],
  'Support access': ['Access & escalation', 'Support & retention'],
  'Support & retention': ['Access & escalation', 'Support & retention'],
  'Audit log': ['Access & escalation', 'Audit log'],
  'Escalation and deputies': ['Access & escalation', 'Escalation & deputies'],
  'Escalation & deputies': ['Access & escalation', 'Escalation & deputies'],
  'Organisation and locations': ['Organisation', 'Locations & purpose'],
  'Locations & purpose': ['Organisation', 'Locations & purpose'],
  'Requirement library': ['Organisation', 'Requirement library'],
  'Import and export': ['Organisation', 'Data & sector packs'],
  'Data & sector packs': ['Organisation', 'Data & sector packs'],
  'Data protection': ['Organisation', 'Data protection'],
  Integrations: ['Organisation', 'Integrations'],
};
/** Opens a Settings section: its v36 group tab, then the view inside it. */
export async function openSettingsView(name: string) {
  const [g, v] = SETTINGS_VIEW[name] ?? [name, name];
  const group = await screen.findByRole('tab', { name: g });
  if (group.getAttribute('aria-selected') !== 'true') await userEvent.click(group);
  const SUB: Record<string, string> = {
    'Accounts & roles': 'Users & access',
    'Support & retention': 'Users & access',
    'Audit log': 'Users & access',
    'Escalation & deputies': 'Escalation & deputies',
  };
  const subName = SUB[v];
  if (subName && subName !== v) {
    const s = screen.queryByRole('radio', { name: subName });
    if (s && s.getAttribute('aria-checked') !== 'true') await userEvent.click(s);
  } else if (subName) {
    const s = screen.queryByRole('radio', { name: subName });
    if (s && s.getAttribute('aria-checked') !== 'true') await userEvent.click(s);
    return;
  }
  const view = await screen.findByRole('radio', { name: v }).catch(() => null);
  if (view && view.getAttribute('aria-checked') !== 'true') await userEvent.click(view);
}

/** Types a date into an Ant Design DatePicker input (format YYYY-MM-DD) and confirms it. */
export async function typeAntDate(input: HTMLElement, value: string) {
  await userEvent.click(input);
  await userEvent.clear(input);
  await userEvent.type(input, `${value}{enter}`);
}

/** Texts of the visible options in the open Ant Design Select dropdown. */
export function visibleAntOptions(): string[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option',
    ),
  ].map((o) => (o.textContent ?? '').trim());
}
