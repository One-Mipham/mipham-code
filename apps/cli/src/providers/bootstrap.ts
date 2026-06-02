import type { ProviderConfig } from '@mipham/shared'
import { ProviderRegistry } from './registry'
import { OpenAICompatProvider } from './openai-compat'
import { AnthropicProvider } from './anthropic'

export function bootstrapProviders(
  configs: ProviderConfig[],
  defaultProvider: string,
  defaultModel: string,
): ProviderRegistry {
  const registry = new ProviderRegistry(configs, defaultProvider, defaultModel)

  for (const config of configs) {
    if (config.status === 'upcoming') continue

    switch (config.protocol) {
      case 'openai-compatible':
        registry.register(config.id, new OpenAICompatProvider(config))
        break
      case 'anthropic':
        registry.register(config.id, new AnthropicProvider(config))
        break
      // custom protocol providers must be registered manually via registry.register()
    }
  }

  return registry
}
