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
    // Serialize test-file execution. Several files mutate process-global state
    // (vi.stubGlobal('fetch'), vi.spyOn(Bun.*), the McpClient singleton) and run
    // heavy shared-resource ops (git worktrees in crsi-sandbox, subprocess spawns
    // in mcp/protocol + task-runner + e2e). Concurrent execution of all 145 files
    // makes these race non-deterministically; serial is deterministic (1712 passed).
    fileParallelism: false,
    mockReset: true,
    setupFiles: ['./vitest.setup.ts'],
  },
})
