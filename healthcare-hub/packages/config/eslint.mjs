// Shared flat ESLint config. Encodes CLAUDE.md non-negotiables:
//  - no console (use the pino logger; PII redaction lives there)
//  - no raw Prisma client in request-handling modules (use withTenant())
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export function baseConfig({ rawPrismaBanned = false } = {}) {
  return tseslint.config(
    { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'src/generated/**', '*.config.*'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
      rules: {
        'no-console': 'error',
        '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
        '@typescript-eslint/consistent-type-imports': 'error',
        ...(rawPrismaBanned
          ? {
              'no-restricted-imports': [
                'error',
                {
                  patterns: [
                    {
                      group: [
                        '**/db/raw*',
                        '@hub/db/raw',
                        '@hub/db/raw/*',
                        '@hub/db/admin',
                        '@hub/db/admin/*',
                      ],
                      message:
                        'Raw/unscoped database access is forbidden in request handlers. Use withTenant() (CLAUDE.md #2).',
                    },
                  ],
                },
              ],
            }
          : {}),
      },
    },
  );
}
