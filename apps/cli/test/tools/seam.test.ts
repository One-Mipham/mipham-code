import { describe, it, expect } from 'vitest'
import { Context } from '../../src/vajra'
import type { ToolDefinition } from '../../src/shared'
import { toolKey, toolService, collectTools } from '../../src/tools/seam'
import { withValidation } from '../../src/tools/validation'

const readTool: ToolDefinition = {
  name: 'Read',
  description: 'read a file',
  category: 'file',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: { file_path: { type: 'string' } },
    required: ['file_path'],
  },
  execute: async () => ({ success: true, content: 'ok' }),
}

describe('tool seam', () => {
  it('toolKey prefixes with tool:', () => {
    expect(toolKey('Read')).toBe('tool:Read')
  })

  it('mounts a tool service and collects it', () => {
    const ctx = new Context()
    ctx.mount(toolService(withValidation(readTool)))
    const tools = collectTools(ctx)
    expect(tools.has('Read')).toBe(true)
    expect(tools.get('Read')!.name).toBe('Read')
  })

  it('adds a new tool by mounting a service — no index.ts edit', () => {
    const ctx = new Context()
    const custom: ToolDefinition = {
      name: 'CustomTool',
      description: 'a plugin tool',
      category: 'system',
      permission: 'auto',
      parameters: {},
      execute: async () => ({ success: true, content: 'custom' }),
    }
    ctx.mount(toolService(withValidation(custom)))
    const tools = collectTools(ctx)
    expect(tools.has('CustomTool')).toBe(true)
    expect(tools.has('Read')).toBe(false)
  })

  it('ignores non-tool keys when collecting', () => {
    const ctx = new Context()
    ctx.provide('credentials', { enabled: false })
    ctx.provide('tool:Read', readTool)
    const tools = collectTools(ctx)
    expect(tools.size).toBe(1)
    expect(tools.has('Read')).toBe(true)
  })
})
