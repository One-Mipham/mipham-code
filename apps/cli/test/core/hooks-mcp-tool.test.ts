import { describe, it, expect, vi, afterEach } from 'vitest'
import { executeHook } from '../../src/core/hooks-executor'
import { McpClient } from '../../src/mcp/client'
import type { HookContext } from '../../src/shared/index'
import type { ToolCallResult } from '../../src/mcp/types'

/**
 * `mcp_tool` was a declared hook type with nothing behind it: the executor
 * matched the case and returned "allow", whatever server and tool the hook
 * named. The operator's settings said they were guarded and nothing ran.
 *
 * The tool's answer is this hook's answer, read by the same contract a command
 * hook's stdout follows — a structured decision decides, plain text is context.
 * The wait is the other half: startup connects servers without blocking, so a
 * hook that fires alongside one has to wait for it rather than read "becoming
 * connected" as "not there".
 */

const text = (t: string, isError = false): ToolCallResult => ({
  content: [{ type: 'text', text: t }],
  ...(isError ? { isError: true } : {}),
})

function hook(
  overrides: Partial<{ mcpServer: string; mcpTool: string }> = {},
): Parameters<typeof executeHook>[0] {
  return { type: 'mcp_tool', mcpServer: 'guard', mcpTool: 'check', ...overrides }
}

function ctx(): HookContext {
  return { event: 'PreToolUse', toolName: 'Bash', sessionId: 's' }
}

/** Spies on the singleton so the hook's two MCP calls are observable in order. */
function spyClient(result: ToolCallResult, ready = true) {
  const client = McpClient.getInstance()
  const calls: string[] = []
  vi.spyOn(client, 'waitUntilReady').mockImplementation(async () => {
    calls.push('wait')
    return ready
  })
  vi.spyOn(client, 'callTool').mockImplementation(async () => {
    calls.push('call')
    return result
  })
  return { client, calls }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('an mcp_tool hook calls the tool it names', () => {
  it('waits for the server, then calls the named tool with the event context', async () => {
    const { client, calls } = spyClient(text('ok'))

    await executeHook(hook(), ctx())

    expect(calls).toEqual(['wait', 'call'])
    expect(client.waitUntilReady).toHaveBeenCalledWith('guard')
    expect(client.callTool).toHaveBeenCalledWith(
      'guard',
      'check',
      expect.objectContaining({ event: 'PreToolUse', toolName: 'Bash', sessionId: 's' }),
    )
  })

  it('calls nothing when the hook names no server, or no tool', async () => {
    const { client } = spyClient(text('ok'))

    const noServer = await executeHook(hook({ mcpServer: undefined }), ctx())
    const noTool = await executeHook(hook({ mcpTool: undefined }), ctx())

    expect([noServer.allowed, noTool.allowed]).toEqual([true, true])
    expect(client.callTool).not.toHaveBeenCalled()
  })
})

describe('the tool’s answer is the hook’s answer', () => {
  it('lets a structured decision block the event', async () => {
    spyClient(text(JSON.stringify({ decision: 'block', reason: 'nope' })))

    const result = await executeHook(hook(), ctx())

    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('nope')
  })

  it('carries a plain-text answer as context', async () => {
    spyClient(text('policy: prefer rg over grep'))

    const result = await executeHook(hook(), ctx())

    expect(result.allowed).toBe(true)
    expect(result.additionalContext).toBe('policy: prefer rg over grep')
  })

  it('reports an MCP error as context rather than deciding with it', async () => {
    // "the server refused" is a decision; "the call did not happen" is not. The
    // client reports the second as an isError result with a message, and a hook
    // that read that message as a verdict would turn every unreachable server
    // into a deny.
    spyClient(text('boom', true))

    const result = await executeHook(hook(), ctx())

    expect(result.allowed).toBe(true)
    expect(result.additionalContext).toContain('guard/check')
    expect(result.additionalContext).toContain('boom')
  })
})

describe('a server that is still connecting', () => {
  it('says so, and does not call the tool', async () => {
    // Past the wait, calling anyway would report "not connected" — true of the
    // moment, and the wrong thing to tell the operator, whose server is on its way.
    const { client } = spyClient(text('ok'), false)

    const result = await executeHook(hook(), ctx())

    expect(result.allowed).toBe(true)
    expect(result.additionalContext).toContain('guard')
    expect(result.additionalContext).toContain('still connecting')
    expect(client.callTool).not.toHaveBeenCalled()
  })
})
