import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadAllowlist } from '../src/allowlist.js'
import type { Config } from '../src/config.js'
import { decrypt } from '../src/crypto.js'
import { MAX_BODY_BYTES } from '../src/schema.js'
import { createCollector, type CollectorHandle } from '../src/server.js'
import { LockHeldError } from '../src/store.js'
import { crashEvent, sessionEvent } from './fixtures.js'

const ALLOWLIST = loadAllowlist()
const KEY = Buffer.alloc(32, 9)
const PATH = '/v1/events'

function newDir(): string {
  return mkdtempSync(join(tmpdir(), 'mipham-telemetry-server-'))
}

function configFor(dataDir: string, overrides: Partial<Config> = {}): Config {
  return {
    host: '127.0.0.1',
    // Ephemeral by default. A fixed port makes the suite fail whenever the
    // previous run left a process behind, and says nothing about the service.
    port: 0,
    dataDir,
    keyPath: join(dataDir, 'aggregate.key'),
    canonicalHost: 'log.onemipham.com',
    // One event per flush, so every live request exercises the write path the
    // 500 in `request.ts` depends on.
    flushEvery: 1,
    flushIntervalMs: 60_000,
    ...overrides,
  }
}

/** Start a collector on an ephemeral port and report where it landed. */
async function startCollector(
  dataDir: string,
  overrides: Partial<Config> = {},
): Promise<{ collector: CollectorHandle; port: number }> {
  const config = configFor(dataDir, overrides)
  const collector = createCollector(config, KEY, ALLOWLIST)
  await new Promise<void>((resolve, reject) => {
    collector.server.once('error', reject)
    collector.server.listen(config.port, config.host, () => resolve())
  })
  const address = collector.server.address()
  if (address === null || typeof address === 'string') throw new Error('no bound address')
  return { collector, port: address.port }
}

/**
 * A fresh source address per test.
 *
 * The limiter's buckets are per key, so sharing one key across the file would
 * make every assertion about "how many requests were admitted" depend on how
 * many requests the tests before it made.
 */
let ipCounter = 0
function newIp(): string {
  ipCounter++
  return `198.51.100.${ipCounter % 250}`
}

interface Result {
  status: number
  retryAfter: string | null
  location: string | null
  text: string
}

async function post(
  port: number,
  body: string,
  headers: Record<string, string> = {},
): Promise<Result> {
  const response = await fetch(`http://127.0.0.1:${port}${PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': newIp(), ...headers },
    body,
  })
  return {
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    location: response.headers.get('location'),
    text: await response.text(),
  }
}

interface RawResult {
  status: number
  headers: Record<string, string | string[] | undefined>
}

/**
 * One request on its own socket, for the cases `fetch` cannot express.
 *
 * A fresh connection per request (`agent: false`) is not incidental: this
 * service answers several codes without ever reading the request body, and Node
 * destroys such a socket once the response is out. A pooled client that picks
 * that socket for its next request sees `ECONNRESET` instead of the answer —
 * a property of the test's client, not of the service, and one that a real
 * client (nginx) never exhibits because it does not pipeline that way.
 *
 * Resolution happens as soon as the status line is in, and never rejects after
 * that: the body is empty on every code here, and a socket torn down right
 * after the response must not turn a delivered answer into a test error.
 */
function rawRequest(
  port: number,
  options: {
    method?: string
    path?: string
    body?: string
    headers?: Record<string, string>
    /** `false` sends headers and whatever body was written, and stops there. */
    end?: boolean
  } = {},
): Promise<RawResult> {
  const { method = 'POST', path = PATH, body = '', headers = {}, end = true } = options
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        agent: false,
        headers: { connection: 'close', ...headers },
      },
      (res) => {
        const result: RawResult = { status: res.statusCode ?? 0, headers: res.headers }
        res.resume()
        res.on('end', () => resolve(result))
        res.on('error', () => resolve(result))
        res.on('aborted', () => resolve(result))
      },
    )
    req.on('error', reject)
    if (body.length > 0) req.write(body)
    if (end) req.end()
  })
}

describe('the live collector', () => {
  let dataDir: string
  let collector: CollectorHandle
  let port: number

  beforeEach(async () => {
    dataDir = newDir()
    ;({ collector, port } = await startCollector(dataDir))
  })

  afterEach(async () => {
    // A test that shut the collector down itself leaves this a no-op; the
    // promise resolves either way, and `release` is idempotent.
    await collector.shutdown()
  })

  describe('accepting events', () => {
    it('answers a well-formed event with an empty 204 and aggregates it', async () => {
      const result = await post(port, JSON.stringify(sessionEvent()))
      const agg = collector.store.aggregator

      expect(result.status).toBe(204)
      expect(result.text).toBe('')
      expect(agg.server.received).toBe(1)
      expect(agg.server.accepted).toBe(1)
      expect(agg.byKind.session).toBe(1)
      expect(agg.session.byPlatform['darwin/arm64']).toBe(1)
      expect(agg.session.counters['tool_calls.Read']).toBe(3)
    })

    it('accepts a crash event and counts the frames it refuses to keep', async () => {
      const result = await post(port, JSON.stringify(crashEvent()))
      const agg = collector.store.aggregator

      expect(result.status).toBe(204)
      expect(agg.crash.byErrorName.TypeError).toBe(1)
      expect(agg.crash.byFrameCountBucket['1_5']).toBe(1)
      // Frames arrive and stop at the boundary: counted, never carried.
      expect(agg.server.framesDiscarded).toBe(2)
    })

    it('accepts schemaVersion 2 as supported, and an unknown version without refusing it', async () => {
      // 2 is the version that drops `stackFrames`; it is supported, not unknown.
      const known = await post(port, JSON.stringify(sessionEvent({ schemaVersion: 2 })))
      const afterKnown = collector.store.aggregator
      expect(known.status).toBe(204)
      expect(afterKnown.server.unknownSchema).toBe(0)
      expect(afterKnown.session.byPlatform['darwin/arm64']).toBe(1)

      // The collector always deploys behind the client, so refusing a version it
      // has not seen would erase every event from every newer CLI for as long as
      // the deploy lagged. It is counted, and aggregated by the fields we know.
      const future = await post(
        port,
        JSON.stringify(sessionEvent({ schemaVersion: 99 }, { id: 'v99' })),
      )
      const agg = collector.store.aggregator
      expect(future.status).toBe(204)
      expect(agg.server.unknownSchema).toBe(1)
      expect(agg.session.byPlatform['darwin/arm64']).toBe(2)
    })

    it('accepts an event with no counters at all', async () => {
      const result = await post(port, JSON.stringify(sessionEvent({ counters: {} })))
      expect(result.status).toBe(204)
      expect(collector.store.aggregator.session.counters).toEqual({})
    })
  })

  describe('deduplication', () => {
    it('answers a duplicate with 204 — anything else would make the client resend forever', async () => {
      const body = JSON.stringify(sessionEvent())
      expect((await post(port, body)).status).toBe(204)
      const second = await post(port, body)

      const agg = collector.store.aggregator
      expect(second.status).toBe(204)
      expect(agg.server.duplicates).toBe(1)
      // Counted again in the dimensions, which is why the duplicate count has
      // to be readable next to them in the report.
      expect(agg.server.accepted).toBe(2)
      expect(agg.session.byPlatform['darwin/arm64']).toBe(2)
    })

    it('classifies on the id alone, whatever the payload says', async () => {
      await post(port, JSON.stringify(sessionEvent()))
      const second = await post(port, JSON.stringify(sessionEvent({ platform: 'linux/x64' })))

      const agg = collector.store.aggregator
      expect(second.status).toBe(204)
      expect(agg.server.duplicates).toBe(1)
      // ...and the second payload is still aggregated. This is the deliberate
      // direction: `record` counts duplicates rather than dropping them, because
      // a dropped re-delivery is indistinguishable from an event that never
      // arrived. The consequence is that dimensions run high by however many
      // duplicates arrived, which is why `duplicates` is printed beside them.
      expect(Object.keys(agg.session.byPlatform).sort()).toEqual(['darwin/arm64', 'linux/x64'])
    })

    it('still deduplicates after a restart — the at-least-once case', async () => {
      const dir = newDir()
      const id = 'restart-dedup-id'

      const first = await startCollector(dir)
      expect((await post(first.port, JSON.stringify(sessionEvent({}, { id })))).status).toBe(204)
      await first.collector.shutdown()

      // A fresh process, same data directory: the tracked ids came back with
      // the aggregate, so a client that re-sends its queue after a crash is
      // recognised rather than double-counted.
      const second = await startCollector(dir)
      expect(second.collector.store.aggregator.server.accepted).toBe(1)
      expect((await post(second.port, JSON.stringify(sessionEvent({}, { id })))).status).toBe(204)
      expect(second.collector.store.aggregator.server.duplicates).toBe(1)
      await second.collector.shutdown()
    })
  })

  describe('rejection is narrow and never blocks the queue behind it', () => {
    it('rejects only a malformed envelope, and a poison message does not block the next', async () => {
      const cases: [string, string][] = [
        ['not json at all', 'not-json'],
        ['', 'not-json'],
        ['[1,2]', 'not-object'],
        ['"a string"', 'not-object'],
        ['{"kind":"session"}', 'missing-id'],
        ['{"id":"x"}', 'missing-kind'],
      ]

      for (const [body, reason] of cases) {
        const result = await post(port, body)
        expect(result.status, body).toBe(400)
        expect(collector.store.aggregator.server.rejected[reason], body).toBeGreaterThan(0)
      }

      // Nothing that was refused reached the aggregate.
      const agg = collector.store.aggregator
      expect(agg.server.accepted).toBe(0)
      expect(agg.byKind).toEqual({})
      // Each reason is counted under its own name, so an operator can tell a
      // client sending garbage from one sending a shape we do not recognise.
      expect(agg.server.rejected).toEqual({
        'not-json': 2,
        'not-object': 2,
        'missing-id': 1,
        'missing-kind': 1,
      })
      // Four of the six parsed as JSON and were then refused. That gap between
      // `received` and `accepted` is the whole point of counting the two
      // separately: "parsed but rejected" is what says a client exists that
      // this collector does not understand.
      expect(agg.server.received).toBe(4)

      // And the next honest event is still delivered.
      expect((await post(port, JSON.stringify(sessionEvent()))).status).toBe(204)
      expect(agg.server.accepted).toBe(1)
      expect(agg.server.received).toBe(5)
    })
  })

  describe('status codes the client cannot survive', () => {
    it('never answers 429, never redirects, and never sends Retry-After', async () => {
      const bodies = [
        rawRequest(port, { body: JSON.stringify(sessionEvent({}, { id: 'matrix-1' })) }),
        rawRequest(port, { body: '{' }),
        rawRequest(port, { method: 'GET' }),
        rawRequest(port, { method: 'HEAD' }),
        rawRequest(port, { method: 'PUT', body: 'x' }),
        rawRequest(port, { path: '/v1/event', body: 'x' }),
        rawRequest(port, { path: '/' }),
        rawRequest(port, {
          path: `${PATH}?probe=1`,
          body: JSON.stringify(sessionEvent({}, { id: 'query-string-id' })),
        }),
        rawRequest(port, {
          path: PATH,
          headers: { host: 'mirror.example.com' },
          body: JSON.stringify(sessionEvent({}, { id: 'matrix-host' })),
        }),
      ]
      const results = await Promise.all(bodies)

      for (const result of results) {
        expect([204, 400, 404, 405, 413, 500, 503]).toContain(result.status)
        // 429 is retryable *and* a 4xx: the client retries twice and then acks
        // and deletes. It is the one code that is worse than useless here.
        expect(result.status).not.toBe(429)
        // A 3xx would be followed transparently, re-sending the body wherever
        // the redirect pointed.
        expect(result.status < 300 || result.status >= 400).toBe(true)
        // No response may hint how long to wait: the client trusts the value
        // without a bound and parks its event loop on it.
        expect(result.headers['retry-after']).toBeUndefined()
        expect(result.headers['location']).toBeUndefined()
      }

      // The query string is stripped before routing, so that one was accepted:
      // a client that appends one is not silently dropped.
      expect(results[7]?.status).toBe(204)
      // ...and a foreign Host is answered, not refused. `hostMismatch` is
      // asserted in its own test, where the canonical case is the control.
      expect(results[8]?.status).toBe(204)
    })

    it('sheds with 503 when the bucket is empty, and counts it', async () => {
      const ip = '203.0.113.99'
      const now = Date.now()
      for (let i = 0; i < 500; i++) collector.limiter.take(ip, now)

      const result = await post(port, JSON.stringify(sessionEvent()), { 'x-real-ip': ip })

      // 503 keeps the event queued on the client; 429 (and every other 4xx)
      // would be acked and deleted.
      expect(result.status).toBe(503)
      expect(result.retryAfter).toBeNull()
      expect(collector.store.aggregator.server.rateLimited).toBe(1)
      expect(collector.store.aggregator.server.accepted).toBe(0)
    })

    it('admits a full queue-sized burst without shedding', async () => {
      const ip = '203.0.113.100'
      const events = Array.from({ length: 100 }, (_, i) =>
        JSON.stringify(sessionEvent({}, { id: `burst-${i}` })),
      )

      const statuses: number[] = []
      for (let i = 0; i < events.length; i += 20) {
        const batch = await Promise.all(
          events.slice(i, i + 20).map((body) => post(port, body, { 'x-real-ip': ip })),
        )
        statuses.push(...batch.map((r) => r.status))
      }

      expect(statuses).toHaveLength(100)
      expect(new Set(statuses)).toEqual(new Set([204]))
      expect(collector.store.aggregator.server.rateLimited).toBe(0)
      expect(collector.store.aggregator.server.accepted).toBe(100)
    })

    it('keys the bucket on X-Real-IP and ignores a client-supplied X-Forwarded-For', async () => {
      const drained = '203.0.113.101'
      const now = Date.now()
      for (let i = 0; i < 500; i++) collector.limiter.take(drained, now)

      // `rawRequest`, not `post`: a shed response is sent without reading the
      // request body, so Node closes that socket, and a pooled client that picks
      // it next sees a reset instead of the answer.
      const attempt = (headers: Record<string, string>) =>
        rawRequest(port, { headers, body: JSON.stringify(sessionEvent()) })

      // A drained address sheds...
      expect((await attempt({ 'x-real-ip': drained })).status).toBe(503)
      // ...a different one is untouched, so one sender cannot deny another...
      expect((await attempt({ 'x-real-ip': '203.0.113.102' })).status).toBe(204)
      // ...and forging X-Forwarded-For does not buy a fresh bucket. The vhost
      // assigns rather than appends `X-Forwarded-For`, and this code never
      // reads it, so the header has no effect at all.
      expect((await attempt({ 'x-real-ip': drained, 'x-forwarded-for': '1.2.3.4' })).status).toBe(
        503,
      )
      expect((await attempt({ 'x-real-ip': drained, 'x-forwarded-for': '5.6.7.8' })).status).toBe(
        503,
      )
    })

    it('counts a non-canonical Host and still answers 204', async () => {
      // The canonical case first, as a control: without it the count below is
      // satisfied by the transport's own `Host: 127.0.0.1:<port>`.
      const canonical = await rawRequest(port, {
        headers: { host: 'log.onemipham.com' },
        body: JSON.stringify(sessionEvent({}, { id: 'host-ok' })),
      })
      expect(canonical.status).toBe(204)
      expect(collector.store.aggregator.server.hostMismatch).toBe(0)

      const foreign = await rawRequest(port, {
        headers: { host: '192.144.235.27' },
        body: JSON.stringify(sessionEvent({}, { id: 'host-foreign' })),
      })

      // 421 here would be a 4xx, i.e. a silent delete, triggered by nothing
      // worse than a health checker using an IP literal. nginx's `server_name`
      // is what actually enforces the hostname; this is observation only.
      expect(foreign.status).toBe(204)
      expect(foreign.headers['retry-after']).toBeUndefined()
      expect(collector.store.aggregator.server.hostMismatch).toBe(1)
    })

    it('refuses an oversized body with 413 on the declared length alone', async () => {
      // The body is never sent. The client declares more than the limit, writes
      // two bytes, and waits — which is the only way to observe that the limit
      // is enforced *before* the body is buffered. (A conforming client that
      // actually pushes 65 KiB just gets its socket closed mid-write; and in
      // production nginx answers this first, since `client_max_body_size` and
      // `MAX_BODY_BYTES` are the same 64 KiB.)
      const result = await rawRequest(port, {
        body: '{"',
        end: false,
        headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
      })

      expect(result.status).toBe(413)
      expect(collector.store.aggregator.server.bodyTooLarge).toBe(1)
      expect(collector.store.aggregator.server.accepted).toBe(0)
      // 413 is a 4xx, so the client deletes it — which is the point: the event
      // can never be accepted at this size, and keeping it queued forever would
      // block everything behind it. The next honest event still lands.
      expect((await post(port, JSON.stringify(sessionEvent()))).status).toBe(204)
    })

    it('answers 500, never a 4xx, when the aggregate cannot be written', async () => {
      const dir = newDir()
      const own = await startCollector(dir)
      const aggregateDir = join(dir, 'aggregate')

      // A regular file where the directory must be, so every write fails with
      // ENOTDIR — and it fails as this user, which a permission bit would not.
      rmSync(aggregateDir, { recursive: true, force: true })
      writeFileSync(aggregateDir, 'not a directory')

      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
      try {
        const result = await post(own.port, JSON.stringify(sessionEvent()))
        // The one status that makes the client keep the event and retry. A 4xx
        // here would ack data that was never written.
        expect(result.status).toBe(500)
        expect(result.retryAfter).toBeNull()
        // The event is not lost to the aggregate — it is still in memory, and
        // the next attempt to write will include it.
        expect(own.collector.store.aggregator.server.accepted).toBe(1)
      } finally {
        stderr.mockRestore()
        // Put the directory back so the shutdown flush is not another error.
        rmSync(aggregateDir, { force: true })
        mkdirSync(aggregateDir)
      }
      await own.collector.shutdown()
    })
  })

  describe('lifecycle', () => {
    it('flushes on shutdown, so an accepted event survives a restart', async () => {
      const dir = newDir()
      const own = await startCollector(dir)

      expect((await post(own.port, JSON.stringify(sessionEvent()))).status).toBe(204)
      await own.collector.shutdown()

      const day = own.collector.store.day
      const raw = readFileSync(own.collector.store.pathForDay(day), 'utf-8')
      expect(JSON.parse(decrypt(raw, KEY)).server.accepted).toBe(1)
    })

    it('refuses to start a second instance against the same data directory', () => {
      // Two collectors writing one day would clobber each other silently.
      expect(() => createCollector(configFor(dataDir), KEY, ALLOWLIST)).toThrow(LockHeldError)
    })

    it('releases the lock on shutdown, so a restart is possible', async () => {
      const dir = newDir()
      const own = await startCollector(dir)
      await own.collector.shutdown()

      const again = await startCollector(dir)
      await again.collector.shutdown()
    })
  })
})
