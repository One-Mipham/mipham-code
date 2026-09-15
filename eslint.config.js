import { FlatCompat } from '@eslint/eslintrc'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const compat = new FlatCompat({ baseDirectory: __dirname })

export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/out/**',
      '**/.playwright-mcp/**',
      '**/infrastructure/vscode/**',
      '**/skills/workflows/*.js',
      '**/.claude/**',
      '**/next-env.d.ts',
      // Runtime artifacts (telemetry queue, task-runner scratch output). ESLint 9+
      // lints dotfiles, so without this the generated
      // `.mipham/task-runner-test/solution.ts` is parsed as project source.
      '**/.mipham/**',
      // Fixtures are deliberately wrong; see test/integrity/lint-rules.test.ts.
      'apps/cli/test/integrity/fixtures/**',
    ],
  },
  ...compat.extends('plugin:@typescript-eslint/recommended'),
  {
    // Type information is a precondition for the type-aware rules below: with
    // no projectService the parser has no types and `no-floating-promises`
    // cannot run at all.
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: {
          // Build/config entry points sit outside every tsconfig; without this
          // the parser aborts the whole file with
          // "was not found by the project service".
          allowDefaultProject: [
            'apps/cli/scripts/*.ts',
            'apps/cli/vitest.config.ts',
            'apps/cli/vitest.setup.ts',
          ],
        },
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // `error`, not `warn`: the root lint script is a bare `eslint .` with no
      // `--max-warnings`, so a warning here would never fail anything.
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
]
