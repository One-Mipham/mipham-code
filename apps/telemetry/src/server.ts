import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { loadAllowlist } from './allowlist.js'
import { assertKeyPresentWhenHistoryExists, loadConfig, type Config } from './config.js'
import { keyFingerprint, loadKey } from './crypto.js'
import { RateLimiter } from './ratelimit.js'
import { handleEvent, route, send } from './request.js'
import { AggregateStore, InstanceLock } from './store.js'

/**
 * Process composition and lifecycle.
 *
 * The ordering here is the whole point of the file: the lock is taken before
 * anything is read, the key is resolved before the store exists, and the
 * shutdown path flushes before it releases the lock. Each of those is a place
 * where the obvious order silently loses data.
 */

export interface CollectorHandle {
  readonly server: Server
  readonly store: AggregateStore
  readonly config: Config
  readonly limiter: RateLimiter
  shutdown(): Promise<void>
}

/**
 * Resolve the rate-limit key.
 *
 * `X-Real-IP` only, set by our nginx to `$remote_addr`. `X-Forwarded-For` is
 * never consulted: every vhost in this organisation appends rather than
 * assigns, so a client-supplied header wins the leftmost slot and every request
 * lands in a fresh bucket. A limiter that grants unlimited requests is worse
 * than no limiter, because it reads as protection. A missing header falls back
 * to one shared bucket, which over-limits rather than under-limits.
 */
function clientKey(request: IncomingMessage): string {
  const realIp = request.headers['x-real-ip']
  const value = Array.isArray(realIp) ? realIp[0] : realIp
  return value && value.length > 0 ? value : '__unknown__'
}

export function createCollector(
  config: Config,
  key: Buffer,
  allowlist = loadAllowlist(),
): CollectorHandle {
  const lock = new InstanceLock(config.dataDir)
  lock.acquire()

  const store = new AggregateStore({ dataDir: config.dataDir, key })
  const limiter = new RateLimiter()

  /**
   * Best-effort flush, for the paths that cannot report a failure to anyone.
   *
   * The timer and the shutdown path have no client waiting on them, so a failed
   * write is logged and the aggregate stays in memory for the next attempt.
   */
  const flushQuietly = (): void => {
    try {
      store.flush()
    } catch (error) {
      process.stderr.write(`telemetry: flush failed: ${String(error)}\n`)
    }
  }

  const flushTimer = setInterval(flushQuietly, config.flushIntervalMs)
  // The interval must not be what keeps the process alive; the listening socket
  // is. Without this a failed `listen` leaves a timer holding the loop open and
  // the service looks hung rather than failing to start.
  flushTimer.unref()

  /**
   * Flush on the request path, letting a failure propagate.
   *
   * This one *can* report, and the difference is the whole point: `handleEvent`
   * calls this before it sends the 204, so a throw becomes a 500, and a 500 is
   * the one status that makes the client keep the event in its queue. Swallowing
   * it here would ack data that was never written and that nothing will retry —
   * turning a full disk into silent loss instead of a loud, self-healing error.
   */
  const onAccepted = (): void => {
    store.noteDirty()
    if (store.dirty >= config.flushEvery) store.flush()
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        const path = (request.url ?? '').split('?')[0] ?? ''
        const early = route(path, request.method)
        if (early !== undefined) {
          send(response, early)
          return
        }

        if (!limiter.take(clientKey(request))) {
          // 503, never 429, and no `Retry-After` — see `request.ts`. Counted so
          // the report can show that shedding happened at all.
          store.aggregator.noteRateLimited()
          send(response, { status: 503 })
          return
        }

        await handleEvent(request, response, {
          aggregator: store.aggregator,
          allowlist,
          canonicalHost: config.canonicalHost,
          onAccepted,
        })
      } catch (error) {
        // Reaching here means the failure happened after the body was read but
        // before a response. 500 keeps the event queued on the client, which is
        // the correct outcome for anything unexpected.
        process.stderr.write(`telemetry: request failed: ${String(error)}\n`)
        if (!response.headersSent) send(response, { status: 500 })
      }
    })()
  })

  return {
    server,
    store,
    config,
    limiter,
    async shutdown(): Promise<void> {
      clearInterval(flushTimer)
      // `close` stops accepting but waits for connections that already exist,
      // and a kept-alive connection with nothing on it counts. Without this the
      // shutdown blocks until the peer's keep-alive times out, which is exactly
      // the case systemd's TimeoutStopSec SIGKILLs — losing the flush this path
      // exists to perform. In-flight requests are unaffected; only idle ones go.
      server.closeIdleConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      // Flush AFTER the server stops accepting, so nothing can be added to the
      // aggregate while it is being serialised.
      flushQuietly()
      lock.release()
    },
  }
}

export async function main(): Promise<void> {
  const config = loadConfig()
  // Order matters: this check produces the more alarming message when data
  // exists, and `loadKey` below would otherwise replace it with the generic
  // "key not found". Both refuse; only one tells you that you have history.
  assertKeyPresentWhenHistoryExists(config)

  // Throws with instructions when absent. Never generate one here: a service
  // that invents a key on start looks perfectly healthy while writing files
  // that nothing can ever read.
  const key = loadKey(config.keyPath)

  const collector = createCollector(config, key)

  process.stdout.write(
    `telemetry: listening on ${config.host}:${config.port} ` +
      `day=${collector.store.day} key=${keyFingerprint(key)} ` +
      `data=${config.dataDir}\n`,
  )

  await new Promise<void>((resolve, reject) => {
    collector.server.once('error', reject)
    collector.server.listen(config.port, config.host, () => resolve())
  })

  let stopping = false
  const stop = (signal: string): void => {
    if (stopping) return
    stopping = true
    process.stdout.write(`telemetry: ${signal} — flushing and exiting\n`)
    void collector.shutdown().then(() => process.exit(0))
    // A shutdown that cannot complete must not leave the unit hanging until
    // systemd's TimeoutStopSec SIGKILLs it — which would lose the very flush
    // this path exists to perform.
    setTimeout(() => process.exit(0), 8_000).unref()
  }

  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
}

// Only start when executed directly (`node dist/server.js`), so importing this
// module in a test does not bind a port or take the instance lock.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`telemetry: failed to start: ${String(error)}\n`)
    process.exit(1)
  })
}
