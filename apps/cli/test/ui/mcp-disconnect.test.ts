/**
 * `/mcp disconnect` must take the server's tools out of the engine registry.
 *
 * Closing the connection is not the same object as deregistering the tools: the
 * tools live in the engine's map, which is what the model calls. The command used
 * to close the transport and print "N tool(s) removed" while every tool stayed
 * registered — callable, and failing only once invoked.
 *
 * Negative control: revert the handler and the registry assertions go red while
 * the message assertion stays green — which is exactly the bug. That is why the
 * judge here is the map, not the string.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import type { CommandContext } from '../../src/ui/commands'
import type { ToolDefinition } from '../../src/shared/index.ts'

const h = vi.hoisted(() => ({
  disconnect: vi.fn<(name: string) => string[]>(() => []),
}))

vi.mock('../../src/mcp/client', () => ({
  McpClient: { getInstance: () => ({ disconnect: h.disconnect }) },
}))

const { getCommand } = await import('../../src/ui/commands')

function tool(name: string): ToolDefinition {
  return { name, description: '', inputSchema: { type: 'object' } } as unknown as ToolDefinition
}

function mkTools(entries: string[]): Map<string, ToolDefinition> {
  return new Map(entries.map((n) => [n, tool(n)]))
}

function mkCtx(toolsMap: Map<string, ToolDefinition>): CommandContext {
  return { engine: { getTools: () => toolsMap }, config: {} } as unknown as CommandContext
}

async function runDisconnect(toolsMap: Map<string, ToolDefinition>, name: string): Promise<string> {
  const handler = getCommand('/mcp')
  if (!handler) throw new Error('/mcp is not registered')
  const result = await handler(mkCtx(toolsMap), ['disconnect', name])
  return result.content ?? ''
}

beforeEach(() => {
  h.disconnect.mockClear()
})

describe('/mcp disconnect', () => {
  it('unregisters the server tools from the engine registry', async () => {
    const toolsMap = mkTools(['mcp__srv__read', 'mcp__srv__write', 'Bash'])
    h.disconnect.mockReturnValue(['read', 'write'])

    const content = await runDisconnect(toolsMap, 'srv')

    // The judge: the map is what the model calls.
    expect(toolsMap.has('mcp__srv__read')).toBe(false)
    expect(toolsMap.has('mcp__srv__write')).toBe(false)
    expect(toolsMap.has('Bash')).toBe(true)
    expect(content).toContain('2 tool(s) removed')
  })

  it("does not leave a neighbouring server's tools behind or remove them", async () => {
    const toolsMap = mkTools(['mcp__srv__read', 'mcp__srv-other__read'])

    await runDisconnect(toolsMap, 'srv')

    expect(toolsMap.has('mcp__srv__read')).toBe(false)
    expect(toolsMap.has('mcp__srv-other__read')).toBe(true)
  })

  it('counts what the registry gave up, not what the connection used to hold', async () => {
    // A connection can be gone while its tools are still registered (that is the
    // state this bug left behind). The message must describe the registry.
    const toolsMap = mkTools(['mcp__srv__read', 'mcp__srv__write'])
    h.disconnect.mockReturnValue([])

    const content = await runDisconnect(toolsMap, 'srv')

    expect(toolsMap.size).toBe(0)
    expect(content).toContain('2 tool(s) removed')
  })

  it('reports zero when the server had registered nothing', async () => {
    const toolsMap = mkTools(['Bash'])
    h.disconnect.mockReturnValue([])

    const content = await runDisconnect(toolsMap, 'unknown')

    expect(toolsMap.size).toBe(1)
    expect(content).toContain('no tools were registered')
  })
})
