import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // clearMocks, never mockReset — see apps/cli/vitest.config.ts for why the
    // reset variant leaks across files under parallel execution.
    clearMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'json-summary'],
      // 阈值门槛。基准是 **2026-09-15 本地实测值**，再回退一档留出余量：
      //   语句 92.10 / 分支 87.52 / 函数 87.93 / 行 93.35
      // 与 apps/cli 的差别：那边的基准必须取 **CI 条件**值（无 API key ⇒ E2E 整段跳过，
      // 比本地低约 0.3 点），这边没有任何条件跳过，三连跑读数逐位相同，故直接用本地值。
      // 回退一档的理由只剩一条：下一批代码落地时「先有代码、后有测试」的中间态不该
      // 立刻红。门槛是棘轮：只能往上抬，不得为了让它变绿而下调。
      thresholds: {
        lines: 91,
        statements: 90,
        functions: 86,
        branches: 85,
      },
    },
  },
})
