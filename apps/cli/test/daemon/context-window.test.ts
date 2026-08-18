// apps/cli/test/daemon/context-window.test.ts
import { describe, it, expect } from 'vitest'
import { ProviderRegistry } from '../../src/providers/registry'
import { resolveContextWindow } from '../../src/daemon/server'

function makeRegistry(models: Array<{ id: string; contextWindow: number }> = []) {
  const registry = new ProviderRegistry([], 'test', 'test-model')
  registry.register('test', {
    config: {
      id: 'test',
      name: 'Test',
      protocol: 'openai-compatible',
      apiKey: 'k',
      models: models.map((m) => ({
        id: m.id,
        name: m.id,
        providerId: 'test',
        contextWindow: m.contextWindow,
        maxOutput: 1000,
        vision: false,
        status: 'active',
      })),
    },
    chat: async function* () {
      yield { type: 'stop' as const }
    },
    listModels: async () => [],
    healthCheck: async () => true,
  })
  return registry
}

describe('resolveContextWindow', () => {
  it('returns the model context window when the model is known', () => {
    const registry = makeRegistry([{ id: 'model-1m', contextWindow: 1_000_000 }])
    expect(resolveContextWindow(registry, 'model-1m')).toBe(1_000_000)
  })

  it('returns a 256K model window as-is (no false 1M assumption)', () => {
    const registry = makeRegistry([{ id: 'model-256k', contextWindow: 256_000 }])
    expect(resolveContextWindow(registry, 'model-256k')).toBe(256_000)
  })

  it('falls back to 200K when the model is unknown', () => {
    const registry = makeRegistry()
    expect(resolveContextWindow(registry, 'unknown')).toBe(200_000)
  })
})
