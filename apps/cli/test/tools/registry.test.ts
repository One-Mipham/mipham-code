import { describe, it, expect } from 'vitest'
import { Context } from '../../src/vajra'
import { createToolRegistry } from '../../src/tools/index'
import { collectTools } from '../../src/tools/seam'
import {
  DEFAULT_CREDENTIAL_MASKING_CONFIG,
  DISABLED_CREDENTIAL_MASKING_CONFIG,
} from '../../src/config/defaults'

describe('createToolRegistry (seam)', () => {
  it('returns all 31 built-in tools by default (incl. Read/Bash)', () => {
    const registry = createToolRegistry()
    expect(registry.has('Read')).toBe(true)
    expect(registry.has('Bash')).toBe(true)
    expect(registry.size).toBe(31)
  })

  it('no-arg default is masking-neutral (does not enable credential masking)', () => {
    // 无参路径（daemon/workflow）不得静默启用掩码——defaultVajraContext 必须提供
    // DISABLED 配置（enabled:false），而非 DEFAULT（enabled:true）。
    expect(DISABLED_CREDENTIAL_MASKING_CONFIG.enabled).toBe(false)
    expect(DEFAULT_CREDENTIAL_MASKING_CONFIG.enabled).toBe(true)
    const registry = createToolRegistry()
    expect(registry.has('Read')).toBe(true)
    expect(registry.has('Bash')).toBe(true)
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
