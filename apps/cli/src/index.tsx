import { render } from 'ink'
import { App } from './ui/app'
import { loadConfig } from './config/loader'
import { bootstrapProviders } from './providers/bootstrap'
import { InstructionsLoader } from './core/instructions'
import { ContextManager } from './core/context'
import { QueryEngine } from './core/engine'
import type { ToolDefinition } from './shared/index.ts'

interface RunOptions {
  model?: string
  provider?: string
  lang?: string
  permission?: string
}

export async function runApp(options: RunOptions): Promise<void> {
  // Set terminal window title
  process.stdout.write('\x1b]0;Mipham Code\x07')

  // Load configuration
  const config = loadConfig()

  // Bootstrap providers
  const defaultProvider = options.provider || config.defaultProvider
  const defaultModel = options.model || config.defaultModel
  const registry = bootstrapProviders(config.providers, defaultProvider, defaultModel)

  // Load instructions
  const instructions = new InstructionsLoader()
  instructions.loadAll(process.cwd())

  // Initialize context
  const context = new ContextManager({ maxTokens: 200_000, compactionThreshold: 0.9 })
  context.setSystemPrompt(instructions.buildSystemPrompt())

  // Create query engine (tools added in M2)
  const engine = new QueryEngine(registry, context, new Map<string, ToolDefinition>())

  const { waitUntilExit } = render(
    <App engine={engine} config={config} initialProvider={defaultProvider} initialModel={defaultModel} lang={options.lang} />,
  )
  await waitUntilExit()
}
