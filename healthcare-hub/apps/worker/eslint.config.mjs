import { baseConfig } from '@hub/config/eslint';

// Request-handling code must never use the unscoped Prisma client (CLAUDE.md non-negotiable #2).
// Tests and dev scripts may use @hub/db/admin to prepare databases.
export default [
  ...baseConfig({ rawPrismaBanned: true }),
  { files: ['test/**', 'scripts/**'], rules: { 'no-restricted-imports': 'off' } },
];
