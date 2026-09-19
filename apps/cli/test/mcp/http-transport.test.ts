import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { HttpTransport } from '../../src/mcp/http-transport'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function sseResponse(events: string[]): Response {
  return new Response(events.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('HttpTransport', () => {
  let transport: HttpTransport
  let calls: Array<{ url: string; init: RequestInit }>
  let fetchImpl: FetchLike

  beforeEach(() => {
    calls = []
    fetchImpl = async (url, init) => {
      calls.push({ url, init: init ?? {} })
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: { ok: true } })
    }
  })

  afterEach(async () => {
    try {
      await transport?.close()
    } catch {
      /* ok */
    }
  })

  function headersOf(call: { url: string; init: RequestInit }): Record<string, string> {
    return (call.init.headers ?? {}) as Record<string, string>
  }

  describe('start and close', () => {
    it('marks connected on start, disconnected on close', async () => {
      transport = new HttpTransport(fetchImpl)
      await transport.start('http://localhost:8004/mcp')
      expect(transport.isConnected()).toBe(true)
      await transport.close()
      expect(transport.isConnected()).toBe(false)
    })
  })

  describe('sendRequest', () => {
    it('POSTs JSON-RPC and returns the JSON result', async () => {
      transport = new HttpTransport(fetchImpl)
      await transport.start('http://localhost:8004/mcp')
      const result = await transport.sendRequest('tools/list')
      expect(result).toEqual({ ok: true })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.url).toBe('http://localhost:8004/mcp')
      expect(calls[0]!.init.method).toBe('POST')
      expect(headersOf(calls[0]!)['Content-Type']).toContain('application/json')
    })

    it('returns the result of a single SSE event', async () => {
      fetchImpl = async () =>
        sseResponse(['data: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"echo"}]}}\n\n'])
      transport = new HttpTransport(fetchImpl)
      await transport.start('http://localhost:8004/mcp')
      const result = (await transport.sendRequest('tools/list')) as {
        tools: Array<{ name: string }>
      }
      expect(result.tools).toHaveLength(1)
      expect(result.tools[0]!.name).toBe('echo')
    })

    it('reassembles chunked SSE tool content into a single result', async () => {
      fetchImpl = async () =>
        sseResponse([
          'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"part1"}]},"isError":false}\n\n',
          'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"part2"}]},"isError":false}\n\n',
        ])
      transport = new HttpTransport(fetchImpl)
      await transport.start('http://localhost:8004/mcp')
      const result = (await transport.sendRequest('tools/call')) as {
        content: Array<{ type: string; text?: string }>
        isError: boolean
      }
      expect(result.content[0]!.text).toBe('part1part2')
      expect(result.isError).toBe(false)
    })

    it('injects Authorization Bearer from env.FORGE_API_KEY', async () => {
      transport = new HttpTransport(fetchImpl)
      await transport.start('http://localhost:8004/mcp', {}, { FORGE_API_KEY: 'secret' })
      await transport.sendRequest('tools/list')
      expect(headersOf(calls[0]!)['Authorization']).toBe('Bearer secret')
    })

    it('prefers explicit headers over env-derived auth', async () => {
      transport = new HttpTransport(fetchImpl)
      await transport.start(
        'http://localhost:8004/mcp',
        { Authorization: 'Bearer explicit' },
        { FORGE_API_KEY: 'secret' },
      )
      await transport.sendRequest('tools/list')
      expect(headersOf(calls[0]!)['Authorization']).toBe('Bearer explicit')
    })

    it('rejects on JSON-RPC error', async () => {
      fetchImpl = async () =>
        jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Unknown method' } })
      transport = new HttpTransport(fetchImpl)
      await transport.start('http://localhost:8004/mcp')
      await expect(transport.sendRequest('nope')).rejects.toThrow('Unknown method')
    })

    it('rejects on non-2xx HTTP response', async () => {
      fetchImpl = async () => jsonResponse({ detail: 'Invalid API key' }, 401)
      transport = new HttpTransport(fetchImpl)
      await transport.start('http://localhost:8004/mcp')
      await expect(transport.sendRequest('tools/list')).rejects.toThrow()
    })

    it('throws when not connected', async () => {
      transport = new HttpTransport(fetchImpl)
      await expect(transport.sendRequest('tools/list')).rejects.toThrow('not connected')
    })

    it('marks the transport disconnected when the server cannot be reached', async () => {
      // fetch itself rejected: no HTTP response ever arrived, so the endpoint is
      // not usable. Reporting "connected" here is what leaves /mcp showing a
      // green server that answers nothing.
      fetchImpl = async () => {
        throw new TypeError('fetch failed')
      }
      transport = new HttpTransport(fetchImpl)
      await transport.start('http://localhost:8004/mcp')

      await expect(transport.sendRequest('tools/list')).rejects.toThrow('fetch failed')
      expect(transport.isConnected()).toBe(false)
    })

    it('stays connected when the server answers with an HTTP error', async () => {
      // Guard: a rejected status (401, 500) proves the endpoint IS reachable —
      // only a request that never got an answer counts as a lost connection.
      fetchImpl = async () => jsonResponse({ detail: 'nope' }, 401)
      transport = new HttpTransport(fetchImpl)
      await transport.start('http://localhost:8004/mcp')

      await expect(transport.sendRequest('tools/list')).rejects.toThrow()
      expect(transport.isConnected()).toBe(true)
    })
  })

  describe('onNotification', () => {
    it('dispatches a notification interleaved with the response', async () => {
      // Streamable HTTP carries server-initiated notifications on the same SSE
      // stream as the response to the request in flight.
      fetchImpl = async () =>
        sseResponse([
          'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n',
          'data: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"echo"}]}}\n\n',
        ])
      transport = new HttpTransport(fetchImpl)
      await transport.start('http://localhost:8004/mcp')

      const seen: string[] = []
      transport.onNotification((n) => seen.push(n.method))

      const result = (await transport.sendRequest('tools/list')) as {
        tools: Array<{ name: string }>
      }

      expect(seen).toEqual(['notifications/tools/list_changed'])
      // The notification must not be mistaken for part of the response.
      expect(result.tools).toHaveLength(1)
    })

    it('dispatches a notification alongside a chunked tool result', async () => {
      // The other branch of the reassembler: several result frames plus a
      // notification, where the notification previously counted as a chunk.
      fetchImpl = async () =>
        sseResponse([
          'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"part1"}]},"isError":false}\n\n',
          'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n',
          'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"part2"}]},"isError":false}\n\n',
        ])
      transport = new HttpTransport(fetchImpl)
      await transport.start('http://localhost:8004/mcp')

      const seen: string[] = []
      transport.onNotification((n) => seen.push(n.method))

      const result = (await transport.sendRequest('tools/call')) as {
        content: Array<{ type: string; text?: string }>
      }

      expect(seen).toEqual(['notifications/tools/list_changed'])
      expect(result.content[0]!.text).toBe('part1part2')
    })
  })

  describe('sendNotification', () => {
    it('fires a POST without awaiting a response', async () => {
      transport = new HttpTransport(fetchImpl)
      await transport.start('http://localhost:8004/mcp')
      transport.sendNotification('notifications/initialized')
      await new Promise((r) => setTimeout(r, 10))
      expect(calls).toHaveLength(1)
    })
  })
})
