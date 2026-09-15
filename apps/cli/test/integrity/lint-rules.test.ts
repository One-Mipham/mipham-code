import { describe, expect, it } from 'vitest'
import { ESLint, type Linter } from 'eslint'
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../../../..')
const FIXTURE = path.join(HERE, 'fixtures', 'floating-promise.ts')

/**
 * The one test in the suite that cannot fit in the 5s default.
 *
 * It is the only place that runs type-aware linting in-process: ESLint has to
 * build a TypeScript program before it can answer. Under v8 coverage the
 * compiler itself is instrumented while it does that, so the two costs
 * compound instead of adding. Measured against the exact command CI runs
 * (`pnpm --filter @miphamai/cli coverage`): ~2.4s bare, ~10s under coverage
 * locally, and 25.9s / 28.9s / 31.2s across three consecutive CI runs — which
 * is why the Test job went red on every push rather than flaking.
 *
 * Note the *drift* in those three numbers: they only rise. The cost is building
 * a TS program over everything the cli tsconfig includes, which grows with the
 * repo, so this bound is chasing a moving target — re-measure before assuming
 * the headroom below still holds.
 *
 * A generous bound is the right shape here: the failure mode is slowness, not a
 * hang — the work is bounded (lint one file) — and a shared runner is slower
 * than a dev machine by a factor nothing else in the suite approaches. 120s
 * leaves ~4x headroom over the slowest run so far and costs nothing; a bound
 * this loose still catches a genuine hang, which is all it is for.
 */
const TYPE_AWARE_LINT_TIMEOUT_MS = 120_000

/**
 * `eslint .` deliberately skips the fixtures directory, so a green repo-wide lint
 * run says nothing about whether `no-floating-promises` can actually fire — it
 * would stay green even if the rule were misconfigured. This re-lints the
 * fixture with the same parser + rule wiring to prove the rule bites.
 */
describe('no-floating-promises is enforced, not merely declared', () => {
  it('resolves the repo root from the fixture', () => {
    // Pins REPO_ROOT: if this walks off the repo, `tsconfigRootDir` below would
    // point above the tsconfig and the type-aware rule would go quiet.
    expect(existsSync(path.join(REPO_ROOT, 'apps/cli/tsconfig.json'))).toBe(true)
    expect(existsSync(FIXTURE)).toBe(true)
  })

  it(
    'flags the floating promise in the fixture',
    async () => {
      // `overrideConfigFile: true` drops the repo config, and with it the ignore
      // entry that hides this fixture. The parser/plugin are CommonJS default
      // exports, hence the cast to ESLint's flat-config shape.
      const overrideConfig = [
        {
          files: ['**/*.ts'],
          languageOptions: {
            parser: tsParser,
            parserOptions: { projectService: true, tsconfigRootDir: REPO_ROOT },
          },
          plugins: { '@typescript-eslint': tsPlugin },
          rules: { '@typescript-eslint/no-floating-promises': 'error' },
        },
      ] as unknown as Linter.Config[]

      const eslint = new ESLint({ cwd: REPO_ROOT, overrideConfigFile: true, overrideConfig })

      const results = await eslint.lintFiles([FIXTURE])

      expect(results.flatMap((r) => r.messages.map((m) => m.ruleId))).toEqual([
        '@typescript-eslint/no-floating-promises',
      ])
    },
    TYPE_AWARE_LINT_TIMEOUT_MS,
  )
})
