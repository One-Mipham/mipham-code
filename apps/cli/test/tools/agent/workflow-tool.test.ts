import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { workflowTool } from '../../../src/tools/agent/workflow'

/**
 * The Workflow tool used to build a two-method stub and `as`-cast it to
 * `QueryEngine`. `runWorkflow` reads four accessors — the missing
 * `getPermission` threw before the script's first line, so **every** Workflow
 * call from the model failed. Nothing caught it because no test ever executed
 * the tool; the cast made the compiler equally blind.
 *
 * This test is the negative control that was missing: it runs the tool end to
 * end with a script that touches nothing but `args`.
 */
describe('Workflow tool', () => {
  let dir: string
  let originalCwd: string

  beforeAll(() => {
    originalCwd = process.cwd()
    // The tool persists `.last-run.json` under `process.cwd()`; point that at a
    // scratch directory so running the test does not write into the repo.
    dir = mkdtempSync(join(tmpdir(), 'mipham-workflow-tool-'))
    process.chdir(dir)
  })

  afterAll(() => {
    process.chdir(originalCwd)
    rmSync(dir, { recursive: true, force: true })
  })

  it('executes a script that calls no agents', async () => {
    const ctx = {
      cwd: dir,
      sessionId: 'test-session',
      provider: 'test',
      model: 'test-model',
      registry: {},
      toolRegistry: new Map(),
      permissionSystem: undefined,
      llm: undefined,
    } as unknown as Parameters<typeof workflowTool.execute>[1]

    const result = await workflowTool.execute(
      { script: 'return { doubled: args.n * 2 }', args: { n: 21 } },
      ctx,
    )

    expect(result.success).toBe(true)
    expect(result.content).toContain('42')
  })
})
