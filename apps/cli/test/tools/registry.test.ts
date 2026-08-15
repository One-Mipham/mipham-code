import { describe, it, expect } from 'vitest'
import { Context } from '../../src/vajra'
import { createToolRegistry } from '../../src/tools/index'
import { collectTools } from '../../src/tools/seam'
import { DEFAULT_CREDENTIAL_MASKING_CONFIG } from '../../src/config/defaults'

describe('createToolRegistry (seam)', () => {
  it('returns all built-in tools by default (incl. Read/Bash)', () => {
    const registry = createToolRegistry()
    expect(registry.has('Read')).toBe(true)
    expect(registry.has('Bash')).toBe(true)
    expect(registry.size).toBeGreaterThanOrEqual(30)
  })

  it('mounts into a caller-provided context so plugins can add tools', () => {
    const ctx = new Context()
    ctx.provide('credentials', DEFAULT_CREDENTIAL_MASKING_CONFIG)
    createToolRegistry(ctx)
    // 挂一个插件工具，不改 tools/index.ts
    ctx.mount({
      apply(applyCtx) {
        applyCtx.provide('tool:CustomPluginTool', {
          name: 'CustomPluginTool',
          description: 'plugin',
          category: 'system',
          permission: 'auto',
          parameters: {},
          execute: async () => ({ success: true, content: 'ok' }),
        })
      },
    })
    const tools = collectTools(ctx)
    expect(tools.has('CustomPluginTool')).toBe(true)
    expect(tools.has('Read')).toBe(true)
  })
})
