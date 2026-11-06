import { expect, test } from '@playwright/test';
import { seriousA11yViolations, signIn, visit, type UserKey } from './support.js';

/** Main screens for each role have no serious or critical axe violations (WCAG 2.2 AA tags). */
const SCREENS: [UserKey, string[]][] = [
  ['manager', ['/', '/alerts', '/settings']],
  ['hr', ['/staff']],
  ['fleet', ['/vehicles']],
  ['dispatcher', ['/planner']],
  ['governance', ['/compliance']],
  ['premises', ['/premises']],
  ['crew', ['/me']],
];

for (const [user, paths] of SCREENS) {
  test(`${user}: ${paths.join(', ')} pass axe`, async ({ page }) => {
    await signIn(page, user);
    for (const path of paths) {
      await visit(page, path);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      expect(await seriousA11yViolations(page), `axe on ${path}`).toEqual([]);
    }
  });
}
