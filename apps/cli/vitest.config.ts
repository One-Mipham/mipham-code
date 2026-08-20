import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      // Redirect 'bun' imports to our Node.js-compatible mock
      bun: resolve(__dirname, 'test/__mocks__/bun.ts'),
      // Redirect 'bun:sqlite' to a shim wrapping node:sqlite DatabaseSync
      'bun:sqlite': resolve(__dirname, 'test/__mocks__/bun-sqlite.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // clearMocks (NOT mockReset): mockReset resets every mock's implementation
    // to undefined before each test — including the shared globalThis.Bun mock
    // (spawn/sleep/serve) defined in vitest.setup.ts. Under parallel execution
    // that reset leaks across test files in reused fork processes, causing rare
    // non-deterministic failures. clearMocks only clears call history and keeps
    // implementations, so files run in parallel safely (20+ consecutive green).
    clearMocks: true,
    setupFiles: ['./vitest.setup.ts'],
  },
})
