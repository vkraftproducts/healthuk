import { expect, test } from '@playwright/test';
import { NAV_ITEMS } from '../src/nav.js';
import { REFUSED, USERS, expectedNav, navLabels, signIn, visit, type UserKey } from './support.js';

/** Every seeded role: the menu matches its permissions and hidden pages refuse by URL too. */
for (const user of Object.keys(USERS) as UserKey[]) {
  test.describe(`${USERS[user].name} (${USERS[user].role})`, () => {
    test('sees the menu for the role, and nothing more', async ({ page }) => {
      await signIn(page, user);
      const { shown, hidden } = expectedNav(user);
      const labels = await navLabels(page);
      for (const l of shown) expect(labels, `${l} should be in the menu`).toContain(l);
      for (const l of hidden) expect(labels, `${l} should not be in the menu`).not.toContain(l);
    });

    test('pages outside the role refuse when opened by URL', async ({ page }) => {
      await signIn(page, user);
      const { hidden } = expectedNav(user);
      for (const item of NAV_ITEMS.filter((n) => hidden.includes(n.label))) {
        await visit(page, item.to);
        await expect(page.getByRole('alert').filter({ hasText: REFUSED })).toBeVisible();
      }
    });

    test('every page in the menu opens without an error', async ({ page }) => {
      await signIn(page, user);
      const { shown } = expectedNav(user);
      for (const item of NAV_ITEMS.filter((n) => shown.includes(n.label) && n.to !== '/')) {
        await visit(page, item.to);
        await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
        await expect(page.getByText(REFUSED)).toHaveCount(0);
        await expect(page.getByText(/Something went wrong/i)).toHaveCount(0);
      }
    });
  });
}

test('a manager in another organisation cannot see Exora staff', async ({ page }) => {
  await signIn(page, 'other-manager');
  await visit(page, '/staff');
  const register = page.getByRole('table', { name: 'Staff register' });
  await expect(register).toBeVisible();
  await expect(register.getByText(USERS.crew.name)).toHaveCount(0);
  await expect(register.getByText(USERS.hr.name)).toHaveCount(0);
});
