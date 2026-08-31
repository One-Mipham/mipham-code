import { describe, it, expect, vi } from 'vitest'
import {
  parseVitestFailures,
  collectLocalImports,
  buildFixPrompt,
  fixCodeTarget,
} from '../../src/core/fix-code'

describe('parseVitestFailures', () => {
  it('extracts failing test file paths from vitest output', () => {
    const output = [
      ' FAIL  test/foo.test.ts > foo > fails on purpose',
      'AssertionError: expected 2 to be 3',
      '',
      ' FAIL  test/bar.test.ts > bar > another failure',
      'AssertionError: expected x',
    ].join('\n')
    expect(parseVitestFailures(output)).toEqual(['test/foo.test.ts', 'test/bar.test.ts'])
  })

  it('returns empty when no tests failed', () => {
    expect(parseVitestFailures('Test Files  1 passed (1)\nTests  1 passed (1)')).toEqual([])
  })

  it('dedupes the same file reported twice', () => {
    const output = [' FAIL  test/foo.test.ts > a > x', ' FAIL  test/foo.test.ts > b > y'].join('\n')
    expect(parseVitestFailures(output)).toEqual(['test/foo.test.ts'])
  })
})

describe('collectLocalImports', () => {
  it('extracts relative imports only', () => {
    const content = [
      `import { foo } from './solution'`,
      `import bar from '../util/helper'`,
      `import { test, expect } from 'vitest'`,
      `import * as path from 'node:path'`,
      `import './setup'`,
    ].join('\n')
    expect(collectLocalImports(content)).toEqual(['./solution', '../util/helper'])
  })

  it('ignores packages and node builtins', () => {
    expect(collectLocalImports(`import { x } from 'lodash'\nimport y from 'node:fs'`)).toEqual([])
  })

  it('handles type imports', () => {
    expect(collectLocalImports(`import type { Config } from '../types'`)).toEqual(['../types'])
  })
})

describe('buildFixPrompt', () => {
  it('embeds test, source, failure, and the frozen-test rule', () => {
    const p = buildFixPrompt({
      testPath: 'test/foo.test.ts',
      testContent: 'expect(add(1,2)).toBe(4)',
      sourcePath: 'src/add.ts',
      sourceContent: 'export function add(a,b){ return a-b }',
      failure: 'expected 3 to be 4',
    })
    expect(p).toContain('test/foo.test.ts')
    expect(p).toContain('src/add.ts')
    expect(p).toContain('export function add(a,b){ return a-b }')
    expect(p).toContain('expected 3 to be 4')
    expect(p.toLowerCase()).toContain('do not modify the test')
  })
})

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    runVitest: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    generateFix: vi.fn(),
    resolveSourceFile: vi.fn(),
    ...overrides,
  }
}

const TEST_CONTENT = `import { add } from './src/add'\nimport { expect } from 'vitest'\n`
const SOURCE_ORIGINAL = 'export function add(a: number, b: number): number { return a - b }'

describe('fixCodeTarget', () => {
  it('reports fixed without work when the test already passes', async () => {
    const deps = makeDeps({ runVitest: vi.fn().mockReturnValue({ exitCode: 0, output: '' }) })
    const r = await fixCodeTarget(deps, 'test/foo.test.ts')
    expect(r.fixed).toBe(true)
    expect(r.attempts).toBe(0)
    expect(deps.generateFix).not.toHaveBeenCalled()
  })

  it('generates a source fix and keeps it in apply mode', async () => {
    const deps = makeDeps({
      runVitest: vi
        .fn()
        .mockReturnValueOnce({
          exitCode: 1,
          output: ' FAIL  test/foo.test.ts > add\nexpected 3 to be 1',
        })
        .mockReturnValueOnce({ exitCode: 0, output: 'passed' }),
      readFile: vi.fn((p: string) => (p === 'test/foo.test.ts' ? TEST_CONTENT : SOURCE_ORIGINAL)),
      resolveSourceFile: vi.fn().mockReturnValue('src/add.ts'),
      generateFix: vi
        .fn()
        .mockResolvedValue('export function add(a: number, b: number): number { return a + b }'),
    })
    const r = await fixCodeTarget(deps, 'test/foo.test.ts', { apply: true })
    expect(r.fixed).toBe(true)
    expect(r.sourceFile).toBe('src/add.ts')
    expect(deps.writeFile).toHaveBeenLastCalledWith(
      'src/add.ts',
      'export function add(a: number, b: number): number { return a + b }',
    )
  })

  it('restores the original source after a passing fix in dry-run', async () => {
    const deps = makeDeps({
      runVitest: vi
        .fn()
        .mockReturnValueOnce({ exitCode: 1, output: 'fail' })
        .mockReturnValueOnce({ exitCode: 0, output: 'pass' }),
      readFile: vi.fn((p: string) => (p === 'test/foo.test.ts' ? TEST_CONTENT : SOURCE_ORIGINAL)),
      resolveSourceFile: vi.fn().mockReturnValue('src/add.ts'),
      generateFix: vi.fn().mockResolvedValue('fixed'),
    })
    const r = await fixCodeTarget(deps, 'test/foo.test.ts', { apply: false })
    expect(r.fixed).toBe(true)
    expect(deps.writeFile).toHaveBeenNthCalledWith(1, 'src/add.ts', 'fixed')
    expect(deps.writeFile).toHaveBeenLastCalledWith('src/add.ts', SOURCE_ORIGINAL)
  })

  it('retries and reports failure when the fix never passes', async () => {
    const deps = makeDeps({
      runVitest: vi.fn().mockReturnValue({ exitCode: 1, output: 'still failing' }),
      readFile: vi.fn((p: string) => (p === 'test/foo.test.ts' ? TEST_CONTENT : SOURCE_ORIGINAL)),
      resolveSourceFile: vi.fn().mockReturnValue('src/add.ts'),
      generateFix: vi.fn().mockResolvedValue('bad fix'),
    })
    const r = await fixCodeTarget(deps, 'test/foo.test.ts', { apply: true, maxRetries: 2 })
    expect(r.fixed).toBe(false)
    expect(r.attempts).toBe(2)
    expect(deps.generateFix).toHaveBeenCalledTimes(2)
  })

  it('reports failure when the test has no local imports to locate a source', async () => {
    const deps = makeDeps({
      runVitest: vi.fn().mockReturnValue({ exitCode: 1, output: 'fail' }),
      readFile: vi.fn().mockReturnValue(`import { expect } from 'vitest'\n`),
      generateFix: vi.fn(),
    })
    const r = await fixCodeTarget(deps, 'test/foo.test.ts')
    expect(r.fixed).toBe(false)
    expect(r.sourceFile).toBeNull()
    expect(deps.generateFix).not.toHaveBeenCalled()
  })
})
