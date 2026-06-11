import { describe, it, expect, vi } from 'vitest'
import type { ProviderConfig, StreamChunk } from '@mipham/shared'
import { ProviderRegistry } from '../../src/providers/registry'
import type { ProviderInstance, ChatRequest } from '../../src/providers/registry'

// ── Test fixtures ──

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'test-provider',
    name: 'Test Provider',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.test.com/v1',
    apiKey: '${TEST_API_KEY}',
    models: [
      {
        id: 'test-model-1',
        name: 'Test Model 1',
        providerId: 'test-provider',
        contextWindow: 128_000,
        maxOutput: 32_000,
        vision: false,
        status: 'active',
      },
      {
        id: 'test-model-2',
        name: 'Test Model 2',
        providerId: 'test-provider',
        contextWindow: 200_000,
        maxOutput: 64_000,
        vision: true,
        status: 'active',
      },
      {
        id: 'test-model-deprecated',
        name: 'Deprecated Model',
        providerId: 'test-provider',
        contextWindow: 32_000,
        maxOutput: 8_000,
        vision: false,
        status: 'deprecated',
      },
    ],
    ...overrides,
  }
}

async function* makeMockChat(chunks: StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const chunk of chunks) {
    yield chunk
  }
}

function makeMockProvider(config: ProviderConfig): ProviderInstance {
  return {
    config,
    chat: vi
      .fn()
      .mockImplementation((_req: ChatRequest) =>
        makeMockChat([{ type: 'text', content: 'Hello!' }, { type: 'stop' }]),
      ),
    listModels: vi.fn().mockResolvedValue(config.models.filter((m) => m.status === 'active')),
    healthCheck: vi.fn().mockResolvedValue(true),
  }
}

// ── Tests ──

describe('ProviderRegistry', () => {
  describe('construction', () => {
    it('should store active provider ID and model ID', () => {
      const config = makeConfig()
      const registry = new ProviderRegistry([config], config.id, 'test-model-1')

      expect(registry.getActiveModel()).toBe('test-model-1')
    })

    it('should start with no registered providers', () => {
      const config = makeConfig()
      const registry = new ProviderRegistry([config], config.id, 'test-model-1')

      expect(() => registry.getActive()).toThrow('not registered')
    })
  })

  describe('register', () => {
    it('should register a provider instance and allow retrieval', () => {
      const config = makeConfig()
      const registry = new ProviderRegistry([config], config.id, 'test-model-1')
      const provider = makeMockProvider(config)

      registry.register(config.id, provider)
      expect(registry.get(config.id)).toBe(provider)
    })

    it('should make registered provider available as active', () => {
      const config = makeConfig()
      const registry = new ProviderRegistry([config], config.id, 'test-model-1')
      const provider = makeMockProvider(config)

      registry.register(config.id, provider)
      expect(registry.getActive()).toBe(provider)
    })

    it('should return undefined for unregistered provider', () => {
      const config = makeConfig()
      const registry = new ProviderRegistry([config], config.id, 'test-model-1')

      expect(registry.get('nonexistent')).toBeUndefined()
    })
  })

  describe('switchProvider', () => {
    it('should switch active provider and model', () => {
      const config1 = makeConfig({ id: 'provider-1', name: 'Provider 1' })
      const config2 = makeConfig({ id: 'provider-2', name: 'Provider 2' })
      const registry = new ProviderRegistry([config1, config2], 'provider-1', 'model-1')

      const p1 = makeMockProvider(config1)
      const p2 = makeMockProvider(config2)
      registry.register('provider-1', p1)
      registry.register('provider-2', p2)

      registry.switchProvider('provider-2', 'model-2')
      expect(registry.getActive()).toBe(p2)
      expect(registry.getActiveModel()).toBe('model-2')
    })

    it('should throw when switching to unregistered provider', () => {
      const config = makeConfig()
      const registry = new ProviderRegistry([config], config.id, 'test-model-1')
      const p = makeMockProvider(config)
      registry.register(config.id, p)

      expect(() => registry.switchProvider('missing')).toThrow('not registered')
    })

    it('should keep current model when no modelId provided', () => {
      const config1 = makeConfig({ id: 'p1' })
      const config2 = makeConfig({ id: 'p2' })
      const registry = new ProviderRegistry([config1, config2], 'p1', 'model-1')
      registry.register('p1', makeMockProvider(config1))
      registry.register('p2', makeMockProvider(config2))

      registry.switchProvider('p2')
      expect(registry.getActiveModel()).toBe('model-1')
    })

    it('should list available providers in error message', () => {
      const config = makeConfig()
      const registry = new ProviderRegistry([config], config.id, 'test-model-1')
      registry.register(config.id, makeMockProvider(config))

      expect(() => registry.switchProvider('missing')).toThrow(/Available:/)
      expect(() => registry.switchProvider('missing')).toThrow(config.id)
    })
  })

  describe('listIds', () => {
    it('should return all registered provider IDs', () => {
      const c1 = makeConfig({ id: 'a' })
      const c2 = makeConfig({ id: 'b' })
      const registry = new ProviderRegistry([c1, c2], 'a', 'm1')
      registry.register('a', makeMockProvider(c1))
      registry.register('b', makeMockProvider(c2))

      const ids = registry.listIds()
      expect(ids).toContain('a')
      expect(ids).toContain('b')
      expect(ids).toHaveLength(2)
    })
  })

  describe('listModels', () => {
    it('should return only active models from active provider', () => {
      const config = makeConfig()
      const registry = new ProviderRegistry([config], config.id, 'test-model-1')
      registry.register(config.id, makeMockProvider(config))

      const models = registry.listModels()
      expect(models).toHaveLength(2)
      expect(models.every((m) => m.status === 'active')).toBe(true)
    })

    it('should exclude deprecated models', () => {
      const config = makeConfig()
      const registry = new ProviderRegistry([config], config.id, 'test-model-1')
      registry.register(config.id, makeMockProvider(config))

      const models = registry.listModels()
      const deprecated = models.find((m) => m.status === 'deprecated')
      expect(deprecated).toBeUndefined()
    })
  })

  describe('chat', () => {
    it('should delegate chat to active provider', async () => {
      const config = makeConfig()
      const registry = new ProviderRegistry([config], config.id, 'test-model-1')
      const provider = makeMockProvider(config)
      registry.register(config.id, provider)

      const chunks: StreamChunk[] = []
      for await (const chunk of registry.chat({
        model: 'test-model-1',
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        chunks.push(chunk)
      }

      expect(provider.chat).toHaveBeenCalled()
      expect(chunks).toHaveLength(2)
      expect(chunks[0]).toEqual({ type: 'text', content: 'Hello!' })
      expect(chunks[1]).toEqual({ type: 'stop' })
    })

    it('should use activeModelId when model not specified in request', async () => {
      const config = makeConfig()
      const registry = new ProviderRegistry([config], config.id, 'test-model-1')
      const provider = makeMockProvider(config)
      registry.register(config.id, provider)

      for await (const _ of registry.chat({
        model: '',
        messages: [],
      })) {
        // consume
      }

      expect(provider.chat).toHaveBeenCalledWith(expect.objectContaining({ model: 'test-model-1' }))
    })
  })
})
