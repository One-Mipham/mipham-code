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
      // 阈值门槛。基准取 **CI 条件**（无 API key ⇒ test/e2e/full-pipeline.test.ts
      // 整个 describe 跳过，8 个测试不跑）的实测值，再回退一档留出余量：
      //   语句 55.87 / 分支 46.81 / 函数 61.82 / 行 56.14（2026-09-15 实测）
      // 必须取 CI 值而非本地值：本地有 API key 时 E2E 真跑，各项比 CI 高约 0.3 个点
      // （行 56.46 vs 56.14），按本地设会在 CI 误红。
      // 门槛是棘轮：只能往上抬，不得为了让它变绿而下调。
      thresholds: {
        lines: 54,
        statements: 54,
        functions: 59,
        branches: 44,
      },
    },
  },
})
