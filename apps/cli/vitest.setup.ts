/**
 * Global test setup for Node.js vitest environment.
 *
 * Provides a mock for the Bun global — required by source code that
 * uses Bun.spawn() and similar Bun APIs.  Since vitest runs in Node,
 * these globals don't exist unless we provide them.
 *
 * Individual tests are expected to spy on / replace specific methods
 * (e.g. vi.spyOn(Bun, 'spawn')) to simulate different behaviours.
 */
import { vi } from 'vitest'
import { timingSafeEqual } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'

// ── Isolate node:os homedir ──────────────────────────────────────────────
//
// Any test that exercises the engine / skills runtime / auto-memory engine
// writes to homedir()/.mipham/memory (turn reflections, Memory tool, memory
// loader). Mock homedir globally to a temp dir so tests never touch — or
// delete — the developer's live ~/.mipham/. Individual tests can still
// override with their own vi.mock('node:os').
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-home`,
  }
})

// ── Minimal Bun global mock ─────────────────────────────────────────────────

if (typeof globalThis.Bun === 'undefined') {
  const mockBun: Record<string, unknown> = {
    // Bun.spawn() — overridden per-test via vi.spyOn
    spawn: vi.fn(() => {
      throw new Error(
        'Bun.spawn() is not mocked — use mockSpawn() or vi.spyOn(Bun, "spawn") in your test',
      )
    }),

    // Bun.sleep() — async sleep (used by some tools)
    sleep: vi.fn((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),

    // Bun.version — runtime version string
    version: '1.2.0-mock',

    // Bun.env — process env (Node fallback)
    get env() {
      return process.env as Record<string, string>
    },

    // Bun.file() — return a minimal file-like object
    file: vi.fn((path: string) => ({
      path,
      exists: () => Promise.resolve(true),
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({}),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      stream: () => new ReadableStream(),
    })),

    // Bun.password — constant-time comparison using Node.js crypto.timingSafeEqual
    password: {
      constantTimeCompare: (a: Buffer, b: Buffer): boolean => {
        if (a.length !== b.length) return false
        return timingSafeEqual(a, b)
      },
    },

    // Bun.write() — no-op
    write: vi.fn(() => Promise.resolve(0)),
  }

  Object.defineProperty(globalThis, 'Bun', {
    value: mockBun,
    writable: true,
    configurable: true,
  })
}

// Ensure Bun.spawn exists even if Bun was partially defined
if (!(globalThis.Bun as any).spawn) {
  ;(globalThis.Bun as any).spawn = vi.fn(() => {
    throw new Error(
      'Bun.spawn() is not mocked — use mockSpawn() or vi.spyOn(Bun, "spawn") in your test',
    )
  })
}

// ── Bun.serve mock ───────────────────────────────────────────────────────
//
// Bun.serve() creates a native Bun HTTP server.  In the vitest (Node.js)
// environment we wrap Node's built-in http.createServer() to provide the
// same interface.  The mock:
//   1. Creates a real Node.js HTTP server on the requested port
//   2. Converts each incoming request to a WHATWG Request object
//   3. Passes the Request to the user's fetch() handler
//   4. Writes the returned Response back to the client
//   5. Supports .stop(), .upgrade() (always returns false — no WS in tests)
if (!(globalThis.Bun as Record<string, unknown>).serve) {
  ;(globalThis.Bun as Record<string, unknown>).serve = vi.fn(
    (config: {
      port: number
      hostname: string
      fetch: (req: Request, server: Record<string, unknown>) => Response | Promise<Response> | void
      websocket?: Record<string, unknown>
    }) => {
      // Build the mock server object that is both returned from Bun.serve
      // and passed as the second argument to the fetch handler.
      const mockServer: Record<string, unknown> = {
        port: config.port,
        hostname: config.hostname,
        development: false,
        pendingRequests: 0,
        pendingWebSockets: 0,
        _http: null as ReturnType<typeof createHttpServer> | null,

        stop() {
          if (mockServer._http) {
            mockServer._http.close()
          }
        },
        ref() {
          mockServer._http?.ref()
        },
        unref() {
          mockServer._http?.unref()
        },
        reload() {
          /* no-op in mock */
        },
        upgrade() {
          // WebSocket upgrades are not supported in the test mock.
          return false
        },
        requestIP(_req: Request): { address: string; family: string; port: number } | null {
          // In test environment, return localhost — sufficient for rate limiter tests
          return { address: '127.0.0.1', family: 'IPv4', port: 0 }
        },
      }

      const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
        const url = `http://${config.hostname}:${config.port}${req.url}`

        // Convert Node.js headers to WHATWG Headers.
        const reqHeaders = new Headers()
        for (const [key, value] of Object.entries(req.headers)) {
          if (value !== undefined && value !== null) {
            if (Array.isArray(value)) {
              for (const v of value) reqHeaders.append(key, String(v))
            } else {
              reqHeaders.set(key, String(value))
            }
          }
        }

        // Read body chunks from the incoming message stream.
        const chunks: Buffer[] = []
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer))
        }
        const body = Buffer.concat(chunks)

        const request = new Request(url, {
          method: req.method || 'GET',
          headers: reqHeaders,
          body: body.length > 0 ? new Uint8Array(body) : undefined,
        })

        try {
          const response = await config.fetch(request, mockServer)

          if (!response) {
            // void return — treated as 204 No Content (or WS upgrade stub)
            res.writeHead(204)
            res.end()
            return
          }

          // Write status and response headers.
          const resHeaders: Record<string, string> = {}
          response.headers.forEach((value, key) => {
            resHeaders[key] = value
          })
          res.writeHead(response.status, resHeaders)

          // Stream the response body.
          if (response.body) {
            const reader = response.body.getReader()
            // eslint-disable-next-line no-constant-condition
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              res.write(value)
            }
          }
          res.end()
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
          }
          res.end(JSON.stringify({ ok: false, error: 'Internal server error' }))
        }
      })

      mockServer._http = httpServer
      httpServer.listen(config.port, config.hostname)

      return mockServer
    },
  )
}
