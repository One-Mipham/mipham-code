import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A declared coverage threshold with no command that runs it is not a gate.
 *
 * This repository has shipped that mistake twice — `rules-loader` had a setter
 * nobody called, and the coverage thresholds sat in `vitest.config.ts` with no
 * CI step invoking `--coverage` — so the wiring is asserted rather than assumed.
 *
 * The check is deliberately structural, not a YAML parse: a package whose
 * `vitest.config.ts` declares `thresholds` must (a) expose a `coverage` script
 * and (b) be matched by a `coverage` command in `ci.yml`, either by name or
 * through a recursive run. Those are the only two shapes CI uses here.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../../../..')
const CI_PATH = join(REPO_ROOT, '.github/workflows/ci.yml')
const WORKSPACES = ['apps', 'packages']

interface Workspace {
  /** The `name` from package.json — the same string `pnpm --filter` matches. */
  readonly name: string
  readonly path: string
  readonly scripts: Readonly<Record<string, string>>
  readonly config: string
}

/**
 * Blank out comments before looking for a `thresholds:` property.
 *
 * `apps/telemetry/vitest.config.ts` discusses its placeholder thresholds in
 * prose, so a naive text search would find the word in a comment and report a
 * gate that does not exist. Stripping comments also means a commented-out
 * threshold cannot satisfy the guard.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function declaresThresholds(configSource: string): boolean {
  return /\bthresholds\s*:/.test(stripComments(configSource))
}

/** YAML comments count as prose, not as a step that runs. */
function executableLines(ciSource: string): string[] {
  return ciSource
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .filter((line) => line.trim().length > 0)
}

function runsCoverage(ciSource: string, packageName: string): boolean {
  return executableLines(ciSource).some((line) => {
    const tokens = line.trim().split(/\s+/)
    if (!tokens.includes('coverage')) return false
    const recursive = tokens.includes('-r') || tokens.includes('--recursive')
    return line.includes(packageName) || recursive
  })
}

function readWorkspaces(): Workspace[] {
  const found: Workspace[] = []
  for (const group of WORKSPACES) {
    const groupDir = join(REPO_ROOT, group)
    if (!existsSync(groupDir)) continue
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = `${group}/${entry.name}`
      const configPath = join(REPO_ROOT, path, 'vitest.config.ts')
      if (!existsSync(configPath)) continue
      const manifest = JSON.parse(readFileSync(join(REPO_ROOT, path, 'package.json'), 'utf-8')) as {
        name: string
        scripts?: Record<string, string>
      }
      found.push({
        name: manifest.name,
        path,
        scripts: manifest.scripts ?? {},
        config: readFileSync(configPath, 'utf-8'),
      })
    }
  }
  return found
}

const CI = readFileSync(CI_PATH, 'utf-8')
const WORKSPACE_LIST = readWorkspaces()
const WITH_THRESHOLDS = WORKSPACE_LIST.filter((w) => declaresThresholds(w.config))

describe('coverage thresholds have a command that runs them', () => {
  it('resolves the repository root and finds the workspaces', () => {
    expect(existsSync(CI_PATH)).toBe(true)
    // Without this the discovery loop below could return an empty list and every
    // assertion after it would pass vacuously.
    expect(WORKSPACE_LIST.map((w) => w.path)).toEqual(
      expect.arrayContaining(['apps/cli', 'apps/telemetry']),
    )
    expect(WITH_THRESHOLDS.length).toBeGreaterThan(0)
  })

  it.each(WITH_THRESHOLDS.map((w) => [w.path, w] as const))(
    '%s declares thresholds, so it has a coverage script',
    (_path, workspace) => {
      expect(workspace.scripts['coverage']).toMatch(/--coverage/)
    },
  )

  it.each(WITH_THRESHOLDS.map((w) => [w.path, w] as const))(
    '%s declares thresholds, so CI runs its coverage',
    (_path, workspace) => {
      expect(runsCoverage(CI, workspace.name)).toBe(true)
    },
  )

  it('detects the declaration, and is not fooled by prose or a comment', () => {
    expect(declaresThresholds('coverage: { thresholds: { lines: 54 } }')).toBe(true)
    // The exact shape that made a plain text search useless.
    expect(declaresThresholds('// Placeholder thresholds, raised later\ncoverage: {}')).toBe(false)
    expect(declaresThresholds('/* thresholds: 0 */')).toBe(false)
  })

  it('recognises a coverage run and is not fooled by a comment that mentions one', () => {
    expect(runsCoverage('- run: pnpm --filter @miphamai/x coverage', '@miphamai/x')).toBe(true)
    expect(runsCoverage('- run: pnpm -r coverage', '@miphamai/x')).toBe(true)
    // A plain `test` run is not a coverage run, recursive or not.
    expect(runsCoverage('- run: pnpm -r test', '@miphamai/x')).toBe(false)
    // The real CI file explains the wiring in Chinese prose above the step it
    // describes; that prose must not be able to satisfy the guard.
    expect(
      runsCoverage(
        '# 覆盖率阈值门禁定义在 apps/cli/vitest.config.ts 的 coverage.thresholds\n- run: pnpm -r test',
        '@miphamai/cli',
      ),
    ).toBe(false)
  })
})
