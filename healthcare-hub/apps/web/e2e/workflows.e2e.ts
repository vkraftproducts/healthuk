import { expect, test } from '@playwright/test';
import { signIn, visit } from './support.js';

/**
 * One core journey per role. Read-only where possible so the suite can be re-run against the same
 * database; anything written is synthetic and clearly labelled.
 */

test('manager: alerts centre explains who is told about what', async ({ page }) => {
  await signIn(page, 'manager');
  await visit(page, '/alerts');
  await expect(page.getByRole('heading', { name: 'Alerts', level: 1 })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Your alerts' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Who is told about what' })).toBeVisible();
});

test('director: dashboard and reports, no CQC rating claims', async ({ page }) => {
  await signIn(page, 'director');
  await expect(page.getByRole('heading', { name: 'Home dashboard' })).toBeVisible();
  await expect(page.getByText(/CQC rating:\s*(Outstanding|Good)/i)).toHaveCount(0);
  await visit(page, '/reports');
  await expect(page.getByRole('heading', { name: 'Reports', level: 1 })).toBeVisible();
});

test('HR: staff register and the queue of staff requests', async ({ page }) => {
  await signIn(page, 'hr');
  await visit(page, '/staff');
  await expect(page.getByRole('table', { name: 'Staff register' })).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Staff requests waiting for a decision' }),
  ).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Correction requests waiting for HR' }),
  ).toBeVisible();
});

test('fleet: vehicle status, readiness check and status history', async ({ page }) => {
  await signIn(page, 'fleet');
  await visit(page, '/vehicles');
  const first = page
    .getByRole('main')
    .getByRole('link')
    .filter({ hasText: /\w+-\w+/ })
    .first();
  await first.waitFor({ timeout: 10_000 }).catch(() => undefined);
  test.skip((await first.count()) === 0, 'No vehicles seeded; run pnpm demo:data');
  await first.click();
  await page.getByRole('tab', { name: 'Status and readiness' }).click();
  await expect(page.getByRole('heading', { name: 'Vehicle status' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Status history' })).toBeVisible();
  const form = page.getByRole('form', { name: /Check readiness of / });
  await form.getByRole('button', { name: 'Check readiness' }).click();
  await expect(page.getByText(/^Result:/)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Vehicle readiness checks' })).toBeVisible();
});

test('dispatcher: planner shows shifts; vehicles are view-only', async ({ page }) => {
  await signIn(page, 'dispatcher');
  await visit(page, '/planner');
  await expect(page.getByRole('heading', { name: 'Work planner' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Plan a shift' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Vehicles and crews' })).toBeVisible();
  const manage = page.getByRole('button', { name: /^Manage shift for / }).first();
  if (await manage.count()) {
    await manage.click();
    await expect(page.getByRole('table', { name: /^Crew on / })).toBeVisible();
    await expect(page.getByRole('table', { name: /^Jobs on / })).toBeVisible();
  }
  await visit(page, '/vehicles');
  const first = page
    .getByRole('main')
    .getByRole('link')
    .filter({ hasText: /\w+-\w+/ })
    .first();
  if (await first.count()) {
    await first.click();
    await page.getByRole('tab', { name: 'Status and readiness' }).click();
    await expect(page.getByRole('button', { name: /off the road$/ })).toHaveCount(0);
  }
});

test('premises: premises safety register', async ({ page }) => {
  await signIn(page, 'premises');
  await visit(page, '/premises');
  await expect(page.getByRole('heading', { name: 'Premises safety', level: 1 })).toBeVisible();
});

test('governance: data protection logs are visible in Settings', async ({ page }) => {
  await signIn(page, 'governance');
  await visit(page, '/settings');
  await page.getByRole('tab', { name: 'Data protection' }).click();
  await expect(page.getByRole('table', { name: 'Retention runs' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Disclosures' })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Record a disclosure' })).toBeVisible();
});

test('crew: my record, readiness check and supervision request form', async ({ page }) => {
  await signIn(page, 'crew');
  await visit(page, '/me');
  await expect(page.getByRole('heading', { name: 'My record', level: 1 })).toBeVisible();
  await expect(page.getByRole('table', { name: 'My requirements' })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Book supervision' })).toBeVisible();
  const check = page.getByRole('form', { name: 'Check my readiness' });
  await check.getByRole('button', { name: 'Check readiness' }).click();
  await expect(page.getByRole('status', { name: 'Readiness result' })).toBeVisible();
});

test('auditor: can look but has no change buttons on staff', async ({ page }) => {
  await signIn(page, 'auditor');
  await visit(page, '/staff');
  await expect(page.getByRole('table', { name: 'Staff register' })).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Staff requests waiting for a decision' }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Add staff/ })).toHaveCount(0);
});
