import { describe, it, expect, afterEach, vi } from 'vitest'
import { McpClient } from '../../src/mcp/client'

/**
 * A server the user (or a plugin reload) removed must stay removed.
 *
 * The auto-reconnect path only knows "the connect attempt failed", which is
 * also true of an attempt refused *because someone tore it down*. Production
 * shape: a plugin's MCP server is removed while it is between reconnect
 * attempts; `/mcp` then lists a server whose plugin is gone.
 */

const config = { name: 'gone', url: 'https://example.com/mcp' }

/** A URL server that fails the handshake on one chosen attempt, then succeeds. */
function serverFailingOn(failOnAttempt: number) {
  let attempt = 0
  return async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string }
    const reply = (result: unknown): Response =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    if (body.method === 'initialize') {
      attempt++
      if (attempt === failOnAttempt) throw new Error('connect ECONNREFUSED 127.0.0.1:1')
      return reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock', version: '1.0.0' },
      })
    }
    if (body.method === 'tools/list') return reply({ tools: [] })
    return new Response('', { status: 202 })
  }
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

describe('McpClient —— 已拆掉的服务器不被自动重连拉回来（325-046）', () => {
  afterEach(async () => {
    await McpClient.getInstance().closeAll()
    McpClient.resetInstance()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('退避等待期间被 disconnect：下一次尝试不再发生', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', serverFailingOn(2))

    const client = McpClient.getInstance()
    client.setAutoReconnect(true)
    await client.connect(config)
    expect(client.getConnection('gone')?.status).toBe('connected')

    // Losing the connection starts the reconnect loop; its first attempt fails
    // transiently, so it is now sleeping before attempt 2.
    const reconnecting = client.reconnect('gone').catch(() => {})
    await settle()

    client.disconnect('gone')
    await vi.advanceTimersByTimeAsync(2_000)
    await reconnecting

    expect(client.getConnection('gone')).toBeUndefined()
  })

  it('正对照：没有人拆掉它时，退避后的尝试照常重连', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', serverFailingOn(2))

    const client = McpClient.getInstance()
    client.setAutoReconnect(true)
    await client.connect(config)

    const reconnecting = client.reconnect('gone').catch(() => {})
    await settle()
    await vi.advanceTimersByTimeAsync(2_000)
    await reconnecting

    expect(client.getConnection('gone')?.status).toBe('connected')
  })
})
