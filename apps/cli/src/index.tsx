import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { render } from 'ink'
import { App } from './ui/app'
import { loadConfig, loadInferenceHookConfig, loadCredentialMaskingConfig } from './config/loader'
import { bootstrapProviders } from './providers/bootstrap'
import { InstructionsLoader } from './core/instructions'
import { loadSessionMemories, getMemoryManager } from './core/memory/memory-loader'
import { ContextManager } from './core/context'
import { QueryEngine } from './core/engine'
import { SessionStore } from './core/session-store'
import type { PermissionLevel } from './shared/types'
import { SkillsLoader } from './skills/loader'
import { PluginManager } from './plugin/plugin-manager'
import { loadPlugins } from './plugin/plugin-loader'
import { createToolRegistry } from './tools'
import { McpClient } from './mcp/client'
import { registerMcpServerTools } from './mcp/registry'
import { AgentRegistry } from './agent/agent-registry'
import { HookEngine } from './core/hooks'
import { ArtifactServer } from './artifacts/server'
import { getMetrics } from './core/metrics'
import { ARTIFACTS_DIR, ARTIFACT_PORT, MIPHAM_DIR } from './shared/constants'
import { AgentViewManager } from './agent-view/agent-view-manager'
import { AgentViewDashboard } from './agent-view/dashboard'

interface RunOptions {
  model?: string
  provider?: string
  lang?: string
  permission?: string
  resume?: string
  version?: string
}

export async function runApp(options: RunOptions): Promise<void> {
  // Metrics: count CLI invocation
  getMetrics().cliInvocations.inc()

  // Handle `mipham agents` subcommand — launch standalone dashboard
  const args = process.argv.slice(2)
  if (args[0] === 'agents') {
    const agentViewManager = new AgentViewManager()
    const { waitUntilExit } = render(
      <AgentViewDashboard
        manager={agentViewManager}
        onAttach={() => {}}
        onExit={() => process.exit(0)}
      />,
    )
    await waitUntilExit()
    process.exit(0)
  }

  // Create AgentViewManager for the full app (shared across the session)
  const agentViewManager = new AgentViewManager()
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

  // Load skills
  const skillsLoader = new SkillsLoader()
  skillsLoader.loadBuiltin(process.cwd())
  skillsLoader.loadUserSkills()
  if (config.skills?.paths) {
    skillsLoader.loadExternal(config.skills.paths)
  }

  // Inject skills system-reminder into system prompt for AI auto-triggering
  const skillsReminder = skillsLoader.buildSystemReminder()
  if (skillsReminder) {
    instructions.setSkillsReminder(skillsReminder)
  }

  // Initialize plugin manager
  const pluginManager = new PluginManager()

  // Generate session name for tracking (used by /cd to persist cwd)
  const sessionName =
    options.resume || `session-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`

  // Initialize context — restore saved session if available
  // Read the active model's context window for dynamic max-token sizing.
  // MIPHAM_DISABLE_1M_CONTEXT=1 caps the effective window at 200K even for
  // models that support larger contexts (e.g. 1M).
  // When the model is unknown (not in any provider's model list), assume a
  // conservative 128K context window. Set MIPHAM_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1
  // to restore the old behavior (default 200K fallback for unknown models).
  const activeModel = registry.findModel(defaultModel)
  let modelContextWindow: number
  if (activeModel) {
    modelContextWindow = activeModel.contextWindow
  } else if (process.env.MIPHAM_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT === '1') {
    modelContextWindow = 200_000 // old behavior: default fallback
  } else {
    modelContextWindow = 128_000 // conservative assumption for unknown models
    console.error(
      `[mipham] ⚠ Unknown model "${defaultModel}": assuming 128K context window. ` +
        `Set MIPHAM_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1 to disable.`,
    )
  }

  const DISABLE_1M = process.env.MIPHAM_DISABLE_1M_CONTEXT === '1'
  const contextMaxTokens = DISABLE_1M && modelContextWindow > 200_000 ? 200_000 : modelContextWindow

  if (DISABLE_1M && modelContextWindow <= 200_000) {
    console.error(
      '[mipham] ⚠ MIPHAM_DISABLE_1M_CONTEXT is set but auto-compaction is not holding the session to 200K — model context window is already ≤ 200K',
    )
  }

  const context = new ContextManager({ maxTokens: contextMaxTokens, compactionThreshold: 0.9 })

  if (options.resume) {
    const saved = SessionStore.load(options.resume)
    if (saved) {
      // Restore working directory if saved
      if (saved.metadata.cwd && existsSync(saved.metadata.cwd)) {
        try {
          process.chdir(saved.metadata.cwd)
        } catch {
          // cwd may no longer exist; silently continue
        }
      }
      for (const msg of saved.messages) {
        context.addMessage(msg)
      }
      context.setSystemPrompt(instructions.buildSystemPrompt())
    }
  }

  if (context.getMessageCount() === 0) {
    const basePrompt = instructions.buildSystemPrompt()
    const memoryReminder = loadSessionMemories(basePrompt)

    // Inject previous session summary for AI continuity
    let prompt = basePrompt
    if (memoryReminder) {
      prompt = `${prompt}\n\n${memoryReminder}`
    }
    const latestSession = SessionStore.getLatest()
    if (latestSession?.summary) {
      prompt = `${prompt}\n\n<system-context name="previous-session">\n# Previous Session Summary\n${latestSession.summary}\n</system-context>`
    }

    // Key expiry reminder (Task 7)
    const { KeyManager } = await import('./config/keys-manager')
    const keyManager = new KeyManager()
    const keyReminder = keyManager.getExpiryReminder()
    if (keyReminder) {
      prompt = `${prompt}\n\n<system-reminder name="key-expiry">\n${keyReminder}\n</system-reminder>`
    }

    context.setSystemPrompt(prompt)
  }

  // Create tool registry with all built-in tools
  const tools = createToolRegistry()

  // Connect MCP servers and register their tools into the tool registry.
  // Uses Promise.allSettled for parallel connection — failures are non-fatal.
  const mcpServers = config.skills?.mcpServers ?? []
  if (mcpServers.length > 0) {
    const mcp = McpClient.getInstance()
    const results = await Promise.allSettled(
      mcpServers.map(async (server) => {
        await mcp.connect(server)
        const count = registerMcpServerTools(server.name, tools)
        if (count > 0) {
          process.stderr.write(`[mcp] "${server.name}": registered ${count} tools\n`)
        }
      }),
    )
    // Log failures (non-fatal — app starts without that server's tools)
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!
      if (result.status === 'rejected') {
        process.stderr.write(
          `[mcp] Failed to connect "${mcpServers[i]!.name}": ${String(result.reason)}\n`,
        )
      }
    }
  }

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
  engine.setAgentViewManager(agentViewManager)
  engine.setSkillsLoader(skillsLoader)

  // Wire inference hooks (DLP) configuration
  const inferenceHookConfig = loadInferenceHookConfig()
  engine.setInferenceHookConfig(inferenceHookConfig)

  // Wire credential masking configuration into tools
  const credentialMaskingConfig = loadCredentialMaskingConfig()
  const { setCredentialMaskingConfigForRead } = await import('./tools/file/read')
  const { setCredentialMaskingConfigForBash } = await import('./tools/exec/bash')
  setCredentialMaskingConfigForRead(credentialMaskingConfig)
  setCredentialMaskingConfigForBash(credentialMaskingConfig)

  // Sync engine permission with config (fix: UI shows "auto" but engine defaulted to bypass-legacy)
  if (config.permission) {
    engine.getPermission().setDefaultLevel(config.permission as PermissionLevel)
  }

  // Apply org-level permission restrictions (P0: bypassPermissions policy gap)
  if (config.permissionRestrictions) {
    engine.getPermission().setRestrictions(config.permissionRestrictions)
  }

  // Initialize agent registry and load plugin agents/skills/MCP/hooks
  const agentRegistry = new AgentRegistry()
  agentRegistry.loadUserAgents()
  agentRegistry.loadProjectAgents(process.cwd())
  engine.setAgentRegistry(agentRegistry)

  loadPlugins(
    pluginManager,
    agentRegistry,
    skillsLoader,
    hookEngine,
    McpClient.getInstance(),
    tools,
  )

  engine.setupContextSummarizer()

  // Auto-save session on exit
  let saved = false
  const saveAndExit = () => {
    saved = true
    artifactServer.stop()
    if (context.getMessageCount() > 0) {
      SessionStore.save(sessionName, context.getMessages(), {
        provider: defaultProvider,
        model: defaultModel,
        cwd: process.cwd(),
      })
    }
    process.exit(0)
  }

  process.on('SIGINT', saveAndExit)
  process.on('SIGTERM', saveAndExit)

  // Safety net: auto-save on exit for paths that bypass saveAndExit
  process.on('exit', () => {
    if (!saved && context.getMessageCount() > 0) {
      SessionStore.autoSave(context.getMessages(), {
        provider: defaultProvider,
        model: defaultModel,
        cwd: process.cwd(),
      })
      // Distill learnings from the last 5 user messages into memory
      const allMessages = context.getMessages()
      const userMessages = allMessages
        .filter((m) => m.role === 'user')
        .slice(-5)
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join('\n- ')
      if (userMessages) {
        const summary = `Session highlights:\n- ${userMessages}`
        getMemoryManager().distillFromSession(summary, sessionName)
      }
    }
  })

  const { waitUntilExit } = render(
    <App
      engine={engine}
      config={config}
      initialProvider={defaultProvider}
      initialModel={defaultModel}
      lang={options.lang}
      skillsLoader={skillsLoader}
      pluginManager={pluginManager}
      version={options.version}
      sessionId={sessionName}
    />,
  )
  await waitUntilExit()
  saveAndExit()
}
