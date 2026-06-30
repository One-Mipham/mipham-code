import { join } from 'node:path'
import { render } from 'ink'
import { App } from './ui/app'
import { loadConfig } from './config/loader'
import { bootstrapProviders } from './providers/bootstrap'
import { InstructionsLoader } from './core/instructions'
import { ContextManager } from './core/context'
import { QueryEngine } from './core/engine'
import { SessionStore } from './core/session-store'
import { SkillsLoader } from './skills/loader'
import { createToolRegistry } from './tools'
import { McpClient } from './mcp/client'
import { HookEngine } from './core/hooks'
import { ArtifactServer } from './artifacts/server'
import { ARTIFACTS_DIR, ARTIFACT_PORT, MIPHAM_DIR } from './shared/constants'

interface RunOptions {
  model?: string
  provider?: string
  lang?: string
  permission?: string
  resume?: string
}

export async function runApp(options: RunOptions): Promise<void> {
  // Set terminal window title
  process.stdout.write('\x1b]0;Mipham Code\x07')

  // Load configuration
  const config = loadConfig()

  // Connect MCP servers (fire-and-forget — do not block startup)
  const mcpServers = config.skills?.mcpServers ?? []
  if (mcpServers.length > 0) {
    const mcp = McpClient.getInstance()
    for (const server of mcpServers) {
      mcp.connect(server).catch((err) => {
        process.stderr.write(`[mcp] Failed to connect "${server.name}": ${String(err)}\n`)
      })
    }
  }

  // Bootstrap providers
  const defaultProvider = options.provider || config.defaultProvider
  const defaultModel = options.model || config.defaultModel
  const registry = bootstrapProviders(config.providers, defaultProvider, defaultModel)

  // Load instructions
  const instructions = new InstructionsLoader()
  instructions.loadAll(process.cwd())

  // Load skills
  const skillsLoader = new SkillsLoader()
  skillsLoader.loadBuiltin(process.cwd())
  if (config.skills?.paths) {
    skillsLoader.loadExternal(config.skills.paths)
  }

  // Initialize context — restore saved session if available
  const context = new ContextManager({ maxTokens: 200_000, compactionThreshold: 0.9 })

  if (options.resume) {
    const saved = SessionStore.load(options.resume)
    if (saved) {
      for (const msg of saved.messages) {
        context.addMessage(msg)
      }
      context.setSystemPrompt(instructions.buildSystemPrompt())
    }
  }

  if (context.getMessageCount() === 0) {
    context.setSystemPrompt(instructions.buildSystemPrompt())
  }

  // Create tool registry with all 16 tools
  const tools = createToolRegistry()

  // Initialize hook engine — register skill-defined hooks
  const hookEngine = new HookEngine()
  for (const skill of skillsLoader.list()) {
    if (skill.hooks) {
      for (const hook of skill.hooks) {
        hookEngine.register(hook)
      }
    }
  }

  // Start artifact server (lazy — first artifact creation triggers listening)
  const artifactsDir = join(process.cwd(), MIPHAM_DIR, ARTIFACTS_DIR)
  const artifactServer = new ArtifactServer(artifactsDir, ARTIFACT_PORT)

  // Create query engine
  const engine = new QueryEngine(registry, context, tools)
  engine.setHookEngine(hookEngine)
  engine.setArtifactServer(artifactServer)
  engine.setupContextSummarizer()

  // Auto-save session on exit
  const saveAndExit = () => {
    artifactServer.stop()
    if (context.getMessageCount() > 0) {
      SessionStore.autoSave(context.getMessages(), {
        provider: defaultProvider,
        model: defaultModel,
      })
    }
    process.exit(0)
  }

  process.on('SIGINT', saveAndExit)
  process.on('SIGTERM', saveAndExit)

  const { waitUntilExit } = render(
    <App
      engine={engine}
      config={config}
      initialProvider={defaultProvider}
      initialModel={defaultModel}
      lang={options.lang}
      skillsLoader={skillsLoader}
    />,
  )
  await waitUntilExit()
  saveAndExit()
}
