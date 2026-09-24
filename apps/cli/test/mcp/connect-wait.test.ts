import { describe, it, expect, afterEach, vi } from 'vitest'
import { McpClient } from '../../src/mcp/client'

/**
 * A caller can arrive while a server is still mid-handshake: startup connects
 * servers without blocking, and the things that fire alongside it — hooks,
 * SessionStart work — see the client in whatever state the handshake has
 * reached. "Not connected yet" and "not there" are different answers, and only
 * one of them is worth waiting for.
 */

function httpMock(delayMs = 0) {
  return async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string }
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    const reply = (result: unknown): Response =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    if (body.method === 'initialize') {
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

describe('McpClient.waitUntilReady', () => {
  afterEach(async () => {
    await McpClient.getInstance().closeAll()
    McpClient.resetInstance()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('returns at once for a server that was never connecting', async () => {
    // The control for the two below: the method must not simply sleep, so a
    // deadline longer than this whole test is passed and nothing is waited for.
    const started = Date.now()

    const ready = await McpClient.getInstance().waitUntilReady('nobody', 5_000)

    expect(ready).toBe(true)
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('returns as soon as a handshake settles', async () => {
    vi.stubGlobal('fetch', httpMock(20))
    const client = McpClient.getInstance()
    const connecting = client.connect({ name: 'ok', url: 'https://example.com/mcp' })

    const ready = await client.waitUntilReady('ok', 2_000)

    expect(ready).toBe(true)
    expect(client.getConnection('ok')!.status).toBe('connected')
    await connecting
  })

  it('gives up at the deadline on a server that never settles', async () => {
    // A server that hangs is the case the deadline exists for: waiting forever
    // is not "waiting for the server", it is a hook that never returns.
    vi.stubEnv('MIPHAM_MCP_CONNECT_TIMEOUT_MS', '150')
    vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
    const client = McpClient.getInstance()
    const connecting = client
      .connect({ name: 'slow', url: 'https://example.com/mcp' })
      .catch(() => {})

    const started = Date.now()
    const ready = await client.waitUntilReady('slow', 60)
    const elapsed = Date.now() - started

    expect(ready).toBe(false)
    expect(elapsed).toBeGreaterThanOrEqual(50)
    expect(elapsed).toBeLessThan(2_000)
    await connecting
  })
})
