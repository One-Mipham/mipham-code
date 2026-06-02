import { describe, it, expect } from 'vitest'
import type { ProviderConfig } from '@mipham/shared'
import { bootstrapProviders } from '../../src/providers/bootstrap'
import { OpenAICompatProvider } from '../../src/providers/openai-compat'
import { AnthropicProvider } from '../../src/providers/anthropic'

// ── Helpers ──

function makeOpenAICompatConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'test-openai',
    name: 'Test OpenAI',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.test.com/v1',
    apiKey: 'sk-test',
    models: [
      {
        id: 'm1',
        name: 'Model 1',
        providerId: 'test-openai',
        contextWindow: 128_000,
        maxOutput: 32_000,
        vision: false,
        status: 'active',
      },
    ],
    ...overrides,
  }
}

function makeAnthropicConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'test-anthropic',
    name: 'Test Anthropic',
    protocol: 'anthropic',
    apiKey: 'sk-ant-test',
    models: [
      {
        id: 'claude-sonnet',
        name: 'Claude Sonnet',
        providerId: 'test-anthropic',
        contextWindow: 1_000_000,
        maxOutput: 128_000,
        vision: true,
        status: 'active',
      },
    ],
    ...overrides,
  }
}

// ── Tests ──

describe('bootstrapProviders', () => {
  it('should return a ProviderRegistry', () => {
    const configs = [makeOpenAICompatConfig()]
    const registry = bootstrapProviders(configs, 'test-openai', 'm1')

    expect(registry.listIds()).toContain('test-openai')
    expect(registry.getActiveModel()).toBe('m1')
  })

  it('should register openai-compatible providers as OpenAICompatProvider', () => {
    const configs = [makeOpenAICompatConfig()]
    const registry = bootstrapProviders(configs, 'test-openai', 'm1')

    const instance = registry.get('test-openai')
    expect(instance).toBeInstanceOf(OpenAICompatProvider)
    expect(instance!.config.id).toBe('test-openai')
  })

  it('should register anthropic providers as AnthropicProvider', () => {
    const configs = [makeAnthropicConfig()]
    const registry = bootstrapProviders(configs, 'test-anthropic', 'claude-sonnet')

    const instance = registry.get('test-anthropic')
    expect(instance).toBeInstanceOf(AnthropicProvider)
    expect(instance!.config.id).toBe('test-anthropic')
  })

  it('should register multiple providers of different protocols', () => {
    const configs = [
      makeOpenAICompatConfig(),
      makeAnthropicConfig(),
    ]
    const registry = bootstrapProviders(configs, 'test-openai', 'm1')

    expect(registry.get('test-openai')).toBeInstanceOf(OpenAICompatProvider)
    expect(registry.get('test-anthropic')).toBeInstanceOf(AnthropicProvider)
    expect(registry.listIds()).toHaveLength(2)
  })

  it('should skip upcoming providers', () => {
    const configs = [
      makeOpenAICompatConfig(),
      makeAnthropicConfig({ id: 'future-provider', status: 'upcoming' }),
    ]
    const registry = bootstrapProviders(configs, 'test-openai', 'm1')

    expect(registry.get('future-provider')).toBeUndefined()
    expect(registry.listIds()).toHaveLength(1)
  })

  it('should skip custom protocol providers (no registered instance)', () => {
    const customConfig: ProviderConfig = {
      id: 'custom-provider',
      name: 'Custom',
      protocol: 'custom',
      apiKey: 'key',
      models: [
        {
          id: 'cm1',
          name: 'Custom Model',
          providerId: 'custom-provider',
          contextWindow: 64_000,
          maxOutput: 16_000,
          vision: false,
          status: 'active',
        },
      ],
    }

    const configs = [customConfig]
    const registry = bootstrapProviders(configs, 'custom-provider', 'cm1')

    // Custom protocol is silently skipped — no instance registered
    expect(registry.get('custom-provider')).toBeUndefined()
    expect(registry.listIds()).toHaveLength(0)
  })

  it('should use the defaultProvider as active', () => {
    const configs = [
      makeOpenAICompatConfig({ id: 'p1' }),
      makeAnthropicConfig({ id: 'p2' }),
    ]
    const registry = bootstrapProviders(configs, 'p2', 'claude-sonnet')

    // p2 should be active
    expect(registry.getActive()).toBe(registry.get('p2'))
    expect(registry.getActiveModel()).toBe('claude-sonnet')
  })

  it('should register only active-status configs, not upcoming', () => {
    const configs = [
      makeOpenAICompatConfig({ id: 'active-p', status: 'active' }),
      makeAnthropicConfig({ id: 'upcoming-p', status: 'upcoming' }),
    ]
    const registry = bootstrapProviders(configs, 'active-p', 'm1')

    expect(registry.get('active-p')).not.toBeUndefined()
    expect(registry.get('upcoming-p')).toBeUndefined()
  })

  it('should register configs without explicit status (default is not upcoming)', () => {
    const configs = [makeOpenAICompatConfig()]
    // status is undefined → not 'upcoming' → should be registered
    const registry = bootstrapProviders(configs, 'test-openai', 'm1')

    expect(registry.get('test-openai')).not.toBeUndefined()
  })

  it('should handle empty configs array', () => {
    const registry = bootstrapProviders([], 'any', 'any')

    expect(registry.listIds()).toHaveLength(0)
    expect(() => registry.getActive()).toThrow('not registered')
  })

  it('should set active model from bootstrap params', () => {
    const configs = [makeOpenAICompatConfig({ id: 'openai' })]
    const registry = bootstrapProviders(configs, 'openai', 'gpt-5')

    expect(registry.getActiveModel()).toBe('gpt-5')
  })

  it('should bootstrap provider with env-var API key config', () => {
    // Even with env var pattern, the provider should be registered
    const config = makeOpenAICompatConfig({ apiKey: '${TEST_KEY}' })
    const registry = bootstrapProviders([config], 'test-openai', 'm1')

    const instance = registry.get('test-openai')
    expect(instance).toBeInstanceOf(OpenAICompatProvider)
    expect(instance!.config.apiKey).toBe('${TEST_KEY}')
  })
})
