import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      // Redirect 'bun' imports to our Node.js-compatible mock
      bun: resolve(__dirname, 'test/__mocks__/bun.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    mockReset: true,
  },
})
