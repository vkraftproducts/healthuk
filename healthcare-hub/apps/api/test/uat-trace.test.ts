import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// TEST_PLAN UAT-01..08 must each stay covered by tagged automated tests (traceability guard).
const ROOT = join(import.meta.dirname, '../../..');
const DIRS = [
  'apps/api/test',
  'apps/web/test',
  'apps/mobile/test',
  'packages/rules/test',
  'packages/domain/test',
];
const sources = DIRS.flatMap((d) =>
  readdirSync(join(ROOT, d))
    .filter((f) => /\.test\.tsx?$/.test(f) && f !== 'uat-trace.test.ts')
    .map((f) => ({ file: `${d}/${f}`, text: readFileSync(join(ROOT, d, f), 'utf8') })),
);

describe('UAT traceability [TEST_PLAN]', () => {
  it.each(['UAT-01', 'UAT-02', 'UAT-03', 'UAT-04', 'UAT-05', 'UAT-06', 'UAT-07', 'UAT-08'])(
    '%s is covered by tagged API tests',
    (id) => {
      const files = sources.filter((s) => s.text.includes(id)).map((s) => s.file);
      expect(files.filter((f) => f.startsWith('apps/api/')).length).toBeGreaterThan(0);
    },
  );
});
