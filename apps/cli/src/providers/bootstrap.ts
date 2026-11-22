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

  // Resolve a tier alias (`haiku` / `sonnet` / `opus`) to the concrete model id
  // **before** anything reads the active model.
  //
  // `findModel` already resolves these against the active provider, but it was
  // only consulted when sizing the context window: the registry kept the raw
  // string, so `--model haiku` sent the literal id "haiku" to the provider and
  // matched no row in the model picker. Doing it here gives the CLI, the daemon
  // and the bin entry the same answer from one place.
  const resolved = registry.findModel(defaultModel)
  if (resolved && resolved.id !== defaultModel) {
    registry.switchProvider(defaultProvider, resolved.id)
  }

  return registry
}
