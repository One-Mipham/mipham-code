import { describe, it, expect } from 'vitest'
import { createToolRegistry } from '../../src/tools/index'

const ctx = { cwd: process.cwd(), sessionId: 'test', provider: '', model: '' }

/**
 * Regression coverage for v2.1.229 alignment: tool calls with a non-string
 * glob/file_path/command must return a graceful error, not crash the process.
 * The crash is prevented by `withValidation` in tools/index.ts.
 */
describe('tool parameter validation (withValidation)', () => {
  it('returns a graceful error when a string param is non-string', async () => {
    const registry = createToolRegistry()
    const glob = registry.get('Glob')!

    const result = await glob.execute({ pattern: 123 }, ctx)

    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('returns a graceful error when a required param is missing', async () => {
    const registry = createToolRegistry()
    const read = registry.get('Read')!

    const result = await read.execute({}, ctx)

    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('returns a graceful error when bash command is non-string', async () => {
    const registry = createToolRegistry()
    const bash = registry.get('Bash')!

    const result = await bash.execute({ command: { not: 'a string' } }, ctx)

    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })
})
