import { describe, it, expect, afterEach } from 'vitest'
import {
  convertMcpTool,
  registerMcpServerTools,
  unregisterMcpServerTools,
  applyToolChanges,
  syncMcpToolsOnChange,
} from '../../src/mcp/registry'
import { McpClient } from '../../src/mcp/client'
import type { ToolDefinition as McpToolDefinition } from '../../src/mcp/types'
import type { ToolDefinition } from '../../src/shared/types'

describe('mcp/registry', () => {
  afterEach(async () => {
    await McpClient.getInstance().closeAll()
    McpClient.resetInstance()
  })

  async function connectMockServer(name = 'mock'): Promise<void> {
    await McpClient.getInstance().connect({
      name,
      command: 'bun',
      args: ['run', 'test/mcp/mock-server.ts'],
    })
  }

  // ── convertMcpTool ──

  describe('convertMcpTool', () => {
    it('produces correct namespaced tool name', () => {
      const tool = convertMcpTool('chrome-devtools-mcp', {
        name: 'click',
        description: 'Clicks an element',
        inputSchema: { type: 'object', properties: { uid: { type: 'string' } }, required: ['uid'] },
      })

      expect(tool.name).toBe('mcp__chrome-devtools-mcp__click')
    })

    it('prefixes description with [MCP:serverName]', () => {
      const tool = convertMcpTool('my-server', {
        name: 'do-thing',
        description: 'Does a thing',
        inputSchema: { type: 'object', properties: {} },
      })

      expect(tool.description).toBe('[MCP:my-server] Does a thing')
    })

    it('falls back to tool name when description is missing', () => {
      const tool = convertMcpTool('my-server', {
        name: 'no-desc',
        inputSchema: { type: 'object', properties: {} },
      })

      expect(tool.description).toBe('[MCP:my-server] no-desc')
    })

    it('passes through inputSchema as parameters', () => {
      const tool = convertMcpTool('srv', {
        name: 't',
        inputSchema: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'string' } },
          required: ['x'],
        },
      })

      expect(tool.parameters.type).toBe('object')
      expect(tool.parameters.properties).toEqual({ x: { type: 'number' }, y: { type: 'string' } })
      expect(tool.parameters.required).toEqual(['x'])
    })

    it('handles missing properties', () => {
      const tool = convertMcpTool('srv', {
        name: 't',
        inputSchema: { type: 'object' },
      })

      expect(tool.parameters.properties).toEqual({})
      expect(tool.parameters.required).toBeUndefined()
    })

    it('handles missing required', () => {
      const tool = convertMcpTool('srv', {
        name: 't',
        inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
      })

      expect(tool.parameters.required).toBeUndefined()
    })

    it('sets category to system', () => {
      const tool = convertMcpTool('srv', {
        name: 't',
        inputSchema: { type: 'object', properties: {} },
      })

      expect(tool.category).toBe('system')
    })

    it('sets permission to ask by default', () => {
      const tool = convertMcpTool('srv', {
        name: 't',
        inputSchema: { type: 'object', properties: {} },
      })

      expect(tool.permission).toBe('ask')
    })

    it('sanitizes special characters in server name', () => {
      const tool = convertMcpTool('plugin chrome-devtools-mcp', {
        name: 'click',
        inputSchema: { type: 'object', properties: {} },
      })

      expect(tool.name).toBe('mcp__plugin_chrome-devtools-mcp__click')
    })

    it('sanitizes special characters in tool name', () => {
      const tool = convertMcpTool('srv', {
        name: 'my tool!@#',
        inputSchema: { type: 'object', properties: {} },
      })

      expect(tool.name).toBe('mcp__srv__my_tool')
    })

    it('truncates names over 128 characters', () => {
      const longName = 'a'.repeat(150)
      const tool = convertMcpTool('srv', {
        name: longName,
        inputSchema: { type: 'object', properties: {} },
      })

      expect(tool.name.length).toBeLessThanOrEqual(128)
      expect(tool.name).toMatch(/^mcp__srv__a+$/)
    })
  })

  // ── registerMcpServerTools ──

  describe('registerMcpServerTools', () => {
    it('registers tools from a connected server', async () => {
      await connectMockServer('test-srv')

      const toolsMap = new Map<string, ToolDefinition>()
      const count = registerMcpServerTools('test-srv', toolsMap)

      expect(count).toBe(2)
      expect(toolsMap.has('mcp__test-srv__echo')).toBe(true)
      expect(toolsMap.has('mcp__test-srv__add')).toBe(true)
    })

    it('registered tool has correct execute function', async () => {
      await connectMockServer('test-srv')

      const toolsMap = new Map<string, ToolDefinition>()
      registerMcpServerTools('test-srv', toolsMap)

      const echoTool = toolsMap.get('mcp__test-srv__echo')!
      expect(echoTool).toBeDefined()

      const result = await echoTool.execute({ message: 'hello' }, {} as any)
      expect(result.success).toBe(true)
      expect(result.content).toContain('Echo: hello')
    })

    it('skips registration on tool name collision', async () => {
      await connectMockServer('test-srv')

      const toolsMap = new Map<string, ToolDefinition>()
      // Pre-register a tool that will collide
      toolsMap.set('mcp__test-srv__echo', {
        name: 'mcp__test-srv__echo',
        description: 'existing',
        category: 'system',
        permission: 'auto',
        parameters: {},
        async execute() {
          return { success: true, content: '' }
        },
      })

      const count = registerMcpServerTools('test-srv', toolsMap)
      // echo should be skipped due to collision, only add should register
      expect(count).toBe(1)
      expect(toolsMap.has('mcp__test-srv__add')).toBe(true)
    })

    it('returns 0 for unconnected server', () => {
      const toolsMap = new Map<string, ToolDefinition>()
      const count = registerMcpServerTools('nonexistent', toolsMap)
      expect(count).toBe(0)
    })

    it('multiple servers have distinct namespaces', async () => {
      await connectMockServer('srv-a')
      await connectMockServer('srv-b')

      const toolsMap = new Map<string, ToolDefinition>()
      registerMcpServerTools('srv-a', toolsMap)
      registerMcpServerTools('srv-b', toolsMap)

      expect(toolsMap.has('mcp__srv-a__echo')).toBe(true)
      expect(toolsMap.has('mcp__srv-b__echo')).toBe(true)
      // Both tools should be present (distinct keys)
      expect(toolsMap.size).toBe(4)
    })
  })

  // ── unregisterMcpServerTools ──

  describe('unregisterMcpServerTools', () => {
    it('removes all tools from a server', async () => {
      await connectMockServer('test-srv')

      const toolsMap = new Map<string, ToolDefinition>()
      registerMcpServerTools('test-srv', toolsMap)
      expect(toolsMap.size).toBe(2)

      unregisterMcpServerTools('test-srv', toolsMap)
      expect(toolsMap.size).toBe(0)
    })

    it('does not affect tools from other servers', async () => {
      await connectMockServer('srv-a')
      await connectMockServer('srv-b')

      const toolsMap = new Map<string, ToolDefinition>()
      registerMcpServerTools('srv-a', toolsMap)
      registerMcpServerTools('srv-b', toolsMap)
      expect(toolsMap.size).toBe(4)

      unregisterMcpServerTools('srv-a', toolsMap)
      expect(toolsMap.size).toBe(2)
      expect(toolsMap.has('mcp__srv-b__echo')).toBe(true)
      expect(toolsMap.has('mcp__srv-b__add')).toBe(true)
    })

    it('is a no-op for unknown server', () => {
      const toolsMap = new Map<string, ToolDefinition>()
      expect(() => unregisterMcpServerTools('unknown', toolsMap)).not.toThrow()
    })
  })
})

// ── applyToolChanges（动态工具更新核心）──

describe('applyToolChanges', () => {
  it('adds new tools and removes stale tools', () => {
    const map = new Map<string, ToolDefinition>()
    const oldTool = convertMcpTool('srv', makeMcpTool('old_tool'))
    map.set(oldTool.name, oldTool)

    const result = applyToolChanges(
      'srv',
      [makeMcpTool('new_tool')],
      [makeMcpTool('old_tool')],
      map,
    )

    expect(result).toEqual({ added: 1, removed: 1 })
    expect(map.has('mcp__srv__new_tool')).toBe(true)
    expect(map.has('mcp__srv__old_tool')).toBe(false)
  })

  it('removed count reflects only tools actually present', () => {
    const map = new Map<string, ToolDefinition>()
    const result = applyToolChanges('srv', [], [makeMcpTool('ghost')], map)
    expect(result).toEqual({ added: 0, removed: 0 })
  })
})

// ── syncMcpToolsOnChange（接线）──

describe('syncMcpToolsOnChange', () => {
  it('registers a tools-changed handler that applies changes', () => {
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
    const fakeClient = {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        const list = handlers.get(event) ?? []
        list.push(handler)
        handlers.set(event, list)
      },
    } as unknown as McpClient

    const map = new Map<string, ToolDefinition>()
    syncMcpToolsOnChange(fakeClient, map)

    handlers.get('tools-changed')![0]!('srv', [makeMcpTool('runtime_tool')], [])
    expect(map.has('mcp__srv__runtime_tool')).toBe(true)
  })

  it('removes tools reported as removed by the server', () => {
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
    const fakeClient = {
      on: (_event: string, handler: (...args: unknown[]) => void) => {
        handlers.set('tools-changed', [handler])
      },
    } as unknown as McpClient

    const map = new Map<string, ToolDefinition>()
    const existing = convertMcpTool('srv', makeMcpTool('doomed'))
    map.set(existing.name, existing)
    syncMcpToolsOnChange(fakeClient, map)

    handlers.get('tools-changed')![0]!('srv', [], [makeMcpTool('doomed')])
    expect(map.has('mcp__srv__doomed')).toBe(false)
  })
})

function makeMcpTool(name: string, description = 'desc'): McpToolDefinition {
  return { name, description, inputSchema: { type: 'object', properties: {} } }
}
