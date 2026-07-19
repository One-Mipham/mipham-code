import type { ProviderConfig } from '../shared/index.ts'
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

    // Warn if apiKey is empty (will cause API errors at runtime)
    if (!config.apiKey || config.apiKey.trim() === '') {
      process.stderr.write(
        `⚠ Provider "${config.name}" (${config.id}): apiKey not set. ` +
          `Set it in ~/.mipham/config.yml or via environment variable.\n`,
      )
    }

    const protocol = config.protocol?.toLowerCase()
    switch (protocol) {
      case 'openai-compatible':
      case 'openai-compat': // common user typo
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
