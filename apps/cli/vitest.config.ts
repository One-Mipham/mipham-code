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
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      reporter: ['text-summary', 'json-summary'],
      // 阈值门槛。基准取 2026-09-15 的 CI 条件实测值，再回退一档留出余量：
      //   语句 55.87 / 分支 46.81 / 函数 61.82 / 行 56.14
      // 当时 CI 无 API key ⇒ test/e2e/full-pipeline.test.ts 整个 describe 跳过（8 条不跑），
      // 比本地有 key 时低约 0.3 个点。现在 E2E 无 key 走 replayChunks 脚本流，
      // 两端都会执行同一批用例，这条差异不复存在；门槛保持不变（棘轮只能往上抬，
      // 新的抬升应取一次真实 CI 运行读数，而不是按这次改动推算）。
      thresholds: {
        lines: 54,
        statements: 54,
        functions: 59,
        branches: 44,
      },
    },
  },
})
