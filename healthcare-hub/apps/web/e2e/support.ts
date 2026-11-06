import { createRequire } from 'node:module';
import { expect, type Page } from '@playwright/test';
import { SELF_SERVICE_PERMISSIONS, SYSTEM_ROLES } from '../../../packages/contracts/src/rbac.js';
import { NAV_ITEMS, canSee, type NavItem } from '../src/nav.js';

/** Seeded development users (apps/web/src/auth.ts) and the system role each one holds. */
export const USERS = {
  manager: { name: 'Manager', role: 'REGISTERED_MANAGER' },
  director: { name: 'Dee Rector', role: 'DIRECTOR' },
  hr: { name: 'Hana Rowe', role: 'HR_LEAD' },
  fleet: { name: 'Finn Lee', role: 'FLEET_LEAD' },
  premises: { name: 'Priya Mason', role: 'PREMISES_LEAD' },
  governance: { name: 'Gina Ode', role: 'GOVERNANCE_LEAD' },
  dispatcher: { name: 'Dispatcher', role: 'DISPATCHER' },
  auditor: { name: 'Audrey Ward', role: 'AUDITOR' },
  crew: { name: 'Alex Morgan', role: 'CREW' },
} as const;
export type UserKey = keyof typeof USERS;

export const REFUSED = 'Your role does not give access to this page.';

/** Signs in through the development sign-in page and waits for the app shell. */
export async function signIn(page: Page, user: UserKey | 'other-manager') {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  const name = user === 'other-manager' ? 'Other Manager' : USERS[user].name;
  await page.getByRole('radio', { name: new RegExp(`^${name}\\b`) }).check();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
}

const label = (n: NavItem, perms: readonly string[]) =>
  n.to === '/' && !perms.includes('dashboard.view') ? 'Home' : n.label;

/**
 * Navigation a role must see, and must not see, from the same rules the app uses. Items that
 * self-service permissions can open (granted with a staff record) are left out of "must not".
 */
export function expectedNav(user: UserKey): { shown: string[]; hidden: string[] } {
  const role = SYSTEM_ROLES.find((r) => r.key === USERS[user].role);
  if (!role) throw new Error(`Unknown role for ${user}`);
  const perms = role.permissions;
  return {
    shown: NAV_ITEMS.filter((n) => canSee(n, perms)).map((n) => label(n, perms)),
    hidden: NAV_ITEMS.filter(
      (n) => !canSee(n, perms) && !n.anyOf.some((p) => SELF_SERVICE_PERMISSIONS.includes(p)),
    ).map((n) => n.label),
  };
}

export async function navLabels(page: Page): Promise<string[]> {
  const nav = page.getByRole('navigation', { name: 'Primary' });
  return (await nav.getByRole('link').allInnerTexts()).map((t) => t.trim()).filter(Boolean);
}

/** Opens a page by URL, as someone typing it in would (hidden links are not security). */
export async function visit(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
}

const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

/** Serious and critical axe violations on the current page (WCAG 2.2 AA tags). */
export async function seriousA11yViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: axePath });
  return page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const axe = (window as any).axe;
    const r = await axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
    });
    return (r.violations as { id: string; impact: string; nodes: unknown[] }[])
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id} (${v.nodes.length})`);
  });
}
