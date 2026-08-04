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
