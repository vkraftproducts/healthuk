// Accessibility pass (NFR-03, WCAG 2.2 AA): runs axe-core in Chromium on every main web screen.
//   pnpm dev   (or API + web), then: node tests/a11y/scan.mjs [baseUrl]
// Exits 1 on any serious or critical violation. Prints a Markdown summary.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const base = process.argv[2] ?? 'http://localhost:5173';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const SCREENS = [
  { name: 'Dashboard', path: '/' },
  { name: 'Staff list', path: '/staff' },
  { name: 'Staff profile', path: '/staff', open: 'a[href^="/staff/"]' },
  { name: 'Vehicles', path: '/vehicles' },
  { name: 'Vehicle detail', path: '/vehicles', open: 'a[href^="/vehicles/"]' },
  { name: 'Compliance', path: '/compliance' },
  { name: 'Premises', path: '/premises' },
  { name: 'Work planner', path: '/planner' },
  { name: 'Reports', path: '/reports' },
  { name: 'Settings', path: '/settings' },
  { name: 'Settings – import and export', path: '/settings', tab: 'Import and export' },
  { name: 'Settings – data protection', path: '/settings', tab: 'Data protection' },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const rows = [];
let serious = 0;

// Sign-in page first (scanned), then sign in as the seeded registered manager.
await page.goto(base, { waitUntil: 'networkidle' });
await scan('Sign in');
await page.getByLabel('Username').fill('manager');
await page.getByLabel('Password').fill(process.env.DEV_PASSWORD ?? 'Exora-dev-2026');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByRole('navigation', { name: 'Primary' }).waitFor();
for (const s of SCREENS) {
  await page.goto(`${base}${s.path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  if (s.open) {
    const link = page.locator(s.open).first();
    if (await link.count()) {
      await link.click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(800);
    }
  }
  if (s.tab) {
    await page.getByRole('tab', { name: s.tab }).click();
    await page.waitForTimeout(800);
  }
  await scan(s.name);
}
async function scan(name) {
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(
    async (tags) =>
      (await window.axe.run(document, { runOnly: { type: 'tag', values: tags } })).violations,
    TAGS,
  );
  for (const v of result) {
    if (v.impact === 'serious' || v.impact === 'critical') serious += 1;
    rows.push(`| ${name} | ${v.id} | ${v.impact} | ${v.nodes.length} | ${v.help} |`);
  }
  if (result.length === 0) rows.push(`| ${name} | – | none | 0 | No violations |`);
}
await browser.close();
console.log('| Screen | Rule | Impact | Elements | Description |\n| --- | --- | --- | --- | --- |');
console.log(rows.join('\n'));
process.exit(serious > 0 ? 1 : 0);
