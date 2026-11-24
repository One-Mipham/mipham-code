import { describe, it, expect } from 'vitest'
import { createToolRegistry } from '../../src/tools/index'
import { withValidation } from '../../src/tools/validation'
import type { ToolDefinition } from '../../src/shared'

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

  // 模型截断了参数 JSON 时，providers 交回 `{ _parseError, _raw }`。若照常校验，
  // 模型读到的是「缺少必需参数 file_path」—— 而它写过这个参数，于是会去补参数，
  // 而不是去补那半个 JSON。这条钉的是错误的**归因**，不只是「有报错」。
  it('names unparseable arguments instead of reporting the parameters as missing', async () => {
    const registry = createToolRegistry()
    const read = registry.get('Read')!

    const result = await read.execute(
      { _parseError: 'Unexpected end of JSON input; received 12 characters', _raw: '{"file_path"' },
      ctx,
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('not valid JSON')
    expect(result.error).toContain('received 12 characters')
    expect(result.error).not.toContain('Missing required parameter')
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

/**
 * CC 2.1.72-044 / 2.1.140-011: models sometimes spell a scalar as a string —
 * `"true"` for a boolean, `" 5 "` or `"+5"` for `offset`/`limit`. Rejecting
 * those cost a turn re-typing a value that had already been supplied, so the
 * unambiguous spellings are coerced before validation. Everything else must
 * still be refused (the coercion is not a loosened type check).
 */
describe('scalar coercion before validation', () => {
  const echo = withValidation({
    name: 'Echo',
    description: 'echo params',
    parameters: {
      type: 'object',
      properties: {
        flag: { type: 'boolean' },
        n: { type: 'integer' },
        ratio: { type: 'number' },
      },
      required: [],
    },
    execute: async (params: Record<string, unknown>) => ({
      success: true,
      content: JSON.stringify(params),
    }),
  } as unknown as ToolDefinition)

  it('coerces "true"/"false" and padded or plus-prefixed numbers', async () => {
    const result = await echo.execute({ flag: 'true', n: ' +5 ', ratio: '0.5' }, ctx)
    expect(result.success).toBe(true)
    expect(JSON.parse(result.content)).toEqual({ flag: true, n: 5, ratio: 0.5 })
  })

  it('positive control: native JSON scalars pass through unchanged', async () => {
    const result = await echo.execute({ flag: false, n: 5, ratio: 0.5 }, ctx)
    expect(result.success).toBe(true)
    expect(JSON.parse(result.content)).toEqual({ flag: false, n: 5, ratio: 0.5 })
  })

  it('still refuses values that are not the declared type', async () => {
    const coercedBoolean = await echo.execute({ flag: 'yes' }, ctx)
    expect(coercedBoolean.success).toBe(false)
    expect(coercedBoolean.error).toBeTruthy()

    const coercedInteger = await echo.execute({ n: '5.5' }, ctx)
    expect(coercedInteger.success).toBe(false)
  })
})
