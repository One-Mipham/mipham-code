import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => `${actual.tmpdir()}/mipham-test-tel-transport` }
})

import { tmpdir } from 'node:os'
import { rmSync, mkdirSync } from 'node:fs'
import { enqueueSync, readQueue, type QueuedEvent } from '../../src/telemetry/queue'
import { flushQueue, flushQueueInBackground } from '../../src/telemetry/transport'
import { OFFICIAL_TELEMETRY_ENDPOINT } from '../../src/telemetry/endpoint'

const HOME = `${tmpdir()}/mipham-test-tel-transport`
const ENDPOINT = 'https://telemetry.example/v1/events'

function event(id: string): QueuedEvent {
  return { id, kind: 'session', payload: { installId: 'i', counters: {} } }
}

function ok(): Response {
  return new Response('{}', { status: 200 })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  rmSync(HOME, { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true })
  fetchMock = vi.fn().mockImplementation(async () => ok())
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

afterAll(() => rmSync(HOME, { recursive: true, force: true }))

describe('transport — the zero-network guarantee', () => {
  // ROADMAP's hard requirement for T1: "off" must be an assertion, not a
  // promise.
  //
  // An empty endpoint is no longer the shipped default — the resolver now
  // supplies a real URL — but it is still a reachable state, and it is the one
  // the `none` sentinel produces. The *default* case is covered in
  // `index.test.ts` ("sends nothing and writes no queue file before anyone
  // opts in"), which is now the only place the "off ⇒ no network" guarantee is
  // asserted end to end: `initTelemetry` checks `consent.enabled` before it
  // ever reaches this function.

  it('sends nothing when the endpoint is empty — where the none sentinel lands', async () => {
    enqueueSync(event('a'))
    const result = await flushQueue('')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toEqual({ sent: 0, failed: 0 })
    expect(readQueue().map((e) => e.id)).toEqual(['a'])
  })

  it('sends nothing when the queue is empty', async () => {
    await flushQueue(ENDPOINT)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the background flush is a no-op with no destination', async () => {
    enqueueSync(event('a'))
    flushQueueInBackground('')
    await Promise.resolve()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does send to the shipped endpoint when that is the one configured', async () => {
    // The complement of the three above, and the reason they are no longer
    // sufficient on their own: an empty destination is now the exception, so
    // "sends nothing" has to be shown next to "sends here".
    enqueueSync(event('a'))
    const result = await flushQueue(OFFICIAL_TELEMETRY_ENDPOINT)
    expect(result).toEqual({ sent: 1, failed: 0 })
    expect(fetchMock.mock.calls[0]![0]).toBe(OFFICIAL_TELEMETRY_ENDPOINT)
  })
})

describe('transport — delivery', () => {
  it('posts each queued event and clears it on success', async () => {
    enqueueSync(event('a'))
    enqueueSync(event('b'))

    const result = await flushQueue(ENDPOINT)

    expect(result).toEqual({ sent: 2, failed: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(readQueue()).toEqual([])
  })

  it('posts the event as JSON to the configured endpoint', async () => {
    enqueueSync(event('a'))
    await flushQueue(ENDPOINT)

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(ENDPOINT)
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body).id).toBe('a')
  })

  it('keeps the event queued when the endpoint is unreachable', async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error('ECONNREFUSED')
    })
    enqueueSync(event('a'))

    vi.useFakeTimers()
    const pending = flushQueue(ENDPOINT)
    await vi.runAllTimersAsync()
    const result = await pending

    expect(result).toEqual({ sent: 0, failed: 1 })
    expect(readQueue().map((e) => e.id)).toEqual(['a'])
  })

  it('retries a 502 and succeeds on the second attempt', async () => {
    fetchMock
      .mockImplementationOnce(async () => new Response('bad gateway', { status: 502 }))
      .mockImplementation(async () => ok())
    enqueueSync(event('a'))

    vi.useFakeTimers()
    const pending = flushQueue(ENDPOINT)
    await vi.runAllTimersAsync()
    const result = await pending

    expect(result).toEqual({ sent: 1, failed: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(readQueue()).toEqual([])
  })

  it('drops an event the endpoint permanently rejects instead of wedging the queue', async () => {
    // A 4xx will never succeed on retry. Retrying forever would block every
    // later event behind one bad payload.
    fetchMock.mockImplementation(async () => new Response('nope', { status: 400 }))
    enqueueSync(event('a'))
    enqueueSync(event('b'))

    const result = await flushQueue(ENDPOINT)

    expect(result).toEqual({ sent: 2, failed: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(readQueue()).toEqual([])
  })

  it('reports failure without throwing when every attempt fails', async () => {
    fetchMock.mockImplementation(async () => new Response('down', { status: 503 }))
    enqueueSync(event('a'))

    vi.useFakeTimers()
    const pending = flushQueue(ENDPOINT)
    await vi.runAllTimersAsync()
    const result = await pending

    expect(result.failed).toBe(1)
    expect(readQueue().map((e) => e.id)).toEqual(['a'])
  })

  it('never rejects from the background flush', async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error('boom')
    })
    enqueueSync(event('a'))
    expect(() => flushQueueInBackground(ENDPOINT)).not.toThrow()
    await Promise.resolve()
  })
})
