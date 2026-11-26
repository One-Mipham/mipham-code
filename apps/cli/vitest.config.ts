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
      // 阈值门槛（棘轮）。读数取 2026-11-26 全量实测，再回退 5 个点：
      //   全局　语句 77.41 / 分支 69.53 / 函数 80.38 / 行 78.30 → 72 / 64 / 75 / 73
      //   core　语句 90.76 / 分支 83.20 / 函数 94.21 / 行 91.95 → 85 / 78 / 89 / 86
      // 取「实测 −5」而不是贴着实测：同一棵树的读数会随运行时抖动（本仓已有
      // advisory 漂移与 artifact 回环 flake 的先例），门槛必须留出噪声余量。
      // 门槛是棘轮：只能往上抬，不得为了让它变绿而下调。
      thresholds: {
        statements: 72,
        branches: 64,
        functions: 75,
        lines: 73,
        // core 单独一档：核心引擎的覆盖率不该被外围 UI/i18n 拉平。
        'src/core/**/*.ts': {
          statements: 85,
          branches: 78,
          functions: 89,
          lines: 86,
          // 每个 core 文件自己的下限。均值会被大量高覆盖的小模块抬高 ——
          // 设门槛时 core 里就有 3 个 0% 文件藏在 90% 的均值后面（现已补测）。
          // 当前最低文件 36.4%，30 留 6 点余量。
          perFile: { lines: 30 },
        },
      },
    },
  },
})
