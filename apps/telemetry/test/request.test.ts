import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { Aggregator, emptyAggregate } from '../src/aggregate.js'
import { loadAllowlist } from '../src/allowlist.js'
import { EVENTS_PATH, handleEvent, readBody, route, send } from '../src/request.js'
import { MAX_BODY_BYTES } from '../src/schema.js'
import { sessionEvent } from './fixtures.js'

const ALLOWLIST = loadAllowlist()

interface Captured {
  status: number | undefined
  headers: Record<string, unknown>
  bodies: string[]
  ended: boolean
}

function fakeResponse(): { response: ServerResponse; captured: Captured } {
  const captured: Captured = { status: undefined, headers: {}, bodies: [], ended: false }
  const response = {
    headersSent: false,
    writeHead(status: number, headers?: Record<string, unknown>) {
      captured.status = status
      Object.assign(captured.headers, headers ?? {})
      ;(response as { headersSent: boolean }).headersSent = true
      return response
    },
    setHeader(name: string, value: unknown) {
      captured.headers[name.toLowerCase()] = value
      return response
    },
    write(chunk: unknown) {
      captured.bodies.push(String(chunk))
      return true
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) captured.bodies.push(String(chunk))
      captured.ended = true
      return response
    },
  } as unknown as ServerResponse
  return { response, captured }
}

function fakeRequest(
  body: string | Buffer | readonly Buffer[],
  headers: Record<string, string | undefined> = {},
  declaredLength?: number,
): { request: IncomingMessage; destroyed: () => boolean } {
  const chunks = Array.isArray(body) ? body : [Buffer.from(body as string)]
  let destroyed = false
  const request = {
    headers: {
      ...(declaredLength === undefined ? {} : { 'content-length': String(declaredLength) }),
      ...headers,
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
    destroy() {
      destroyed = true
    },
  } as unknown as IncomingMessage
  return { request, destroyed: () => destroyed }
}

function deps(): {
  aggregator: Aggregator
  allowlist: typeof ALLOWLIST
  canonicalHost: string
  onAccepted: () => void
} {
  return {
    aggregator: new Aggregator('2026-09-15', emptyAggregate('2026-09-15')),
    allowlist: ALLOWLIST,
    canonicalHost: 'log.onemipath.invalid',
    onAccepted: () => {},
  }
}

describe('routing', () => {
  it('answers POST on the one path the existing Python client pinned', () => {
    expect(EVENTS_PATH).toBe('/v1/events')
    expect(route(EVENTS_PATH, 'POST')).toBeUndefined()
  })

  it('404s any other path and 405s any other method', () => {
    expect(route('/v1/event', 'POST')).toEqual({ status: 404 })
    expect(route('/', 'POST')).toEqual({ status: 404 })
    expect(route(`${EVENTS_PATH}/`, 'POST')).toEqual({ status: 404 })
    expect(route(EVENTS_PATH, 'GET')).toEqual({ status: 405 })
    expect(route(EVENTS_PATH, 'PUT')).toEqual({ status: 405 })
    expect(route(EVENTS_PATH, undefined)).toEqual({ status: 405 })
  })
})

describe('every response is empty and un-embellished', () => {
  it('sends no body, no Location and no Retry-After', () => {
    for (const status of [204, 400, 404, 405, 413, 500, 503] as const) {
      const { response, captured } = fakeResponse()
      send(response, { status })
      expect(captured.status).toBe(status)
      expect(captured.bodies).toEqual([])
      expect(captured.ended).toBe(true)
      // A 3xx would be followed transparently by undici; `Retry-After` is
      // trusted unboundedly by the client and parks its event loop.
      expect(captured.headers).toEqual({})
    }
  })
})

describe('reading the body', () => {
  it('reads a normal body', async () => {
    const { request } = fakeRequest('{"a":1}')
    expect(await readBody(request)).toEqual({ ok: true, body: '{"a":1}' })
  })

  it('refuses on the declared length alone, before reading anything', async () => {
    const { request, destroyed } = fakeRequest('', {}, MAX_BODY_BYTES + 1)
    const result = await readBody(request)
    expect(result).toEqual({ ok: false })
    // Refusing before reading is the difference between a limit and a memory
    // exhaustion primitive.
    expect(destroyed()).toBe(false)
  })

  it('counts the real bytes of a chunked body and destroys the socket on overflow', async () => {
    const chunk = Buffer.alloc(32 * 1024, 0x61)
    const { request, destroyed } = fakeRequest([chunk, chunk, chunk])
    expect(await readBody(request)).toEqual({ ok: false })
    expect(destroyed()).toBe(true)
  })

  it('accepts a body exactly at the limit', async () => {
    const { request } = fakeRequest(Buffer.alloc(MAX_BODY_BYTES, 0x61), {}, MAX_BODY_BYTES)
    const result = await readBody(request)
    expect(result.ok).toBe(true)
  })
})

describe('handleEvent', () => {
  async function deliver(
    body: string,
    headers: Record<string, string | undefined> = {},
    overrides: ReturnType<typeof deps> = deps(),
    declaredLength?: number,
  ) {
    const { request } = fakeRequest(body, headers, declaredLength)
    const { response, captured } = fakeResponse()
    await handleEvent(request, response, overrides)
    return { captured, aggregator: overrides.aggregator }
  }

  it('accepts a well-formed event with an empty 204', async () => {
    const { captured, aggregator } = await deliver(JSON.stringify(sessionEvent()))
    expect(captured.status).toBe(204)
    expect(captured.bodies).toEqual([])
    expect(aggregator.server.received).toBe(1)
    expect(aggregator.server.accepted).toBe(1)
    expect(aggregator.session.byPlatform['darwin/arm64']).toBe(1)
  })

  it('400s a body that is not JSON, and leaves the aggregate otherwise untouched', async () => {
    const { captured, aggregator } = await deliver('not json at all')
    expect(captured.status).toBe(400)
    expect(aggregator.server.rejected['not-json']).toBe(1)
    expect(aggregator.server.accepted).toBe(0)
    expect(aggregator.server.received).toBe(0)
  })

  it('400s each envelope reason under its own name', async () => {
    const cases: [string, string][] = [
      ['null', 'not-object'],
      ['[1]', 'not-object'],
      ['{"kind":"session"}', 'missing-id'],
      ['{"id":"x"}', 'missing-kind'],
    ]
    for (const [body, reason] of cases) {
      const { captured, aggregator } = await deliver(body)
      expect(captured.status, body).toBe(400)
      expect(aggregator.server.rejected[reason], body).toBe(1)
    }
  })

  it('does not let a poison message block the ones behind it', async () => {
    const shared = deps()
    expect((await deliver('{', {}, shared)).captured.status).toBe(400)
    const good = await deliver(JSON.stringify(sessionEvent()), {}, shared)
    expect(good.captured.status).toBe(204)
    expect(good.aggregator.server.accepted).toBe(1)
  })

  it('413s an oversized body and counts it', async () => {
    const { captured, aggregator } = await deliver('', {}, deps(), MAX_BODY_BYTES + 1)
    expect(captured.status).toBe(413)
    expect(aggregator.server.bodyTooLarge).toBe(1)
    expect(aggregator.server.accepted).toBe(0)
  })

  it('acknowledges a duplicate with 204 rather than making the client retry', async () => {
    const shared = deps()
    const body = JSON.stringify(sessionEvent())
    await deliver(body, {}, shared)
    const second = await deliver(body, {}, shared)
    // Anything else here would make the client resend forever.
    expect(second.captured.status).toBe(204)
    expect(second.aggregator.server.duplicates).toBe(1)
  })

  it('counts a non-canonical Host without refusing it', async () => {
    const { captured, aggregator } = await deliver(JSON.stringify(sessionEvent()), {
      host: '192.144.235.27',
    })
    expect(captured.status).toBe(204)
    expect(aggregator.server.hostMismatch).toBe(1)
  })

  it('does not count a request with no Host header as a mismatch', async () => {
    const { aggregator } = await deliver(JSON.stringify(sessionEvent()), {})
    expect(aggregator.server.hostMismatch).toBe(0)
  })

  it('folds a bad Content-Type into an observation, not a refusal', async () => {
    const { captured, aggregator } = await deliver(JSON.stringify(sessionEvent()), {
      'content-type': 'text/plain',
    })
    expect(captured.status).toBe(204)
    expect(aggregator.server.contentTypeUnexpected).toBe(1)
  })

  it('lets a write failure become a 500, which is what keeps the client retrying', async () => {
    const onAccepted = vi.fn(() => {
      throw new Error('disk full')
    })
    const shared = { ...deps(), onAccepted }
    const { request } = fakeRequest(JSON.stringify(sessionEvent()))
    const { response, captured } = fakeResponse()

    await expect(handleEvent(request, response, shared)).rejects.toThrow('disk full')
    // No response was sent, so the caller's catch block produces the 500 —
    // a 4xx here would silently delete the event instead.
    expect(captured.status).toBeUndefined()
  })

  it('never emits 429 or a redirect for any input shape', async () => {
    const bodies = ['{', 'null', '[]', '{"id":"x"}', JSON.stringify(sessionEvent()), '']
    for (const body of bodies) {
      const { captured } = await deliver(body)
      expect([204, 400, 413, 500, 503], `body=${body}`).toContain(captured.status)
      expect(captured.headers).not.toHaveProperty('location')
      expect(captured.headers).not.toHaveProperty('retry-after')
    }
  })
})
