import React from 'react'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { render } from 'ink'
import * as readline from 'node:readline'
import { App } from './ui/app'
import {
  loadConfig,
  loadInferenceHookConfig,
  loadCredentialMaskingConfig,
  loadCrossSessionConfig,
} from './config/loader'
import {
  registerActiveSession,
  heartbeatSession,
  unregisterSession,
  createSessionInfo,
} from './agent/cross-session/discovery'
import { bootstrapProviders } from './providers/bootstrap'
import { InstructionsLoader } from './core/instructions'
import { loadSessionMemories, getMemoryManager } from './core/memory/memory-loader'
import { ContextManager } from './core/context'
import { QueryEngine } from './core/engine'
import { ExperienceRuleEngine } from './core/rule-engine.js'
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
import { getWorkspaceTrust } from './core/workspace-trust'
import { ARTIFACTS_DIR, ARTIFACT_PORT, MIPHAM_DIR } from './shared/constants'
import { AgentViewManager } from './agent-view/agent-view-manager'
import { AgentViewDashboard } from './agent-view/dashboard'
import { createT } from './i18n-core/t'
import { detectLocale } from './i18n-core/detect'
import { I18nProvider } from './i18n-context'
import enUS from './i18n-core/locales/en-US.json' with { type: 'json' }
import zhCN from './i18n-core/locales/zh-CN.json' with { type: 'json' }
import type { TranslationMap } from './i18n-core/types'

interface RunOptions {
  model?: string
  provider?: string
  lang?: string
  permission?: string
  resume?: string
  version?: string
}

/**
 * Check workspace trust before starting the session.
 * If the cwd is not trusted, prompt the user via stdin.
 * Exits the process if the user declines.
 */
async function checkWorkspaceTrust(): Promise<void> {
  const cwd = process.cwd()
  const trust = getWorkspaceTrust()

  if (trust.isTrusted(cwd)) return

  // Non-interactive mode (piped stdin, headless) — skip prompt, proceed
  if (!process.stdin.isTTY) return

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr, // use stderr to avoid interfering with stdout rendering
  })

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(prompt, (answer) => {
        resolve(answer.trim().toLowerCase())
      })
    })

  process.stderr.write('\n')
  process.stderr.write('╔══════════════════════════════════════════════╗\n')
  process.stderr.write('║  ⚠️  Workspace Trust                          ║\n')
  process.stderr.write('╠══════════════════════════════════════════════╣\n')
  process.stderr.write('║                                              ║\n')
  process.stderr.write(`║  Directory not trusted:                      ║\n`)
  process.stderr.write(`║  ${cwd.slice(0, 42).padEnd(42)}║\n`)
  process.stderr.write('║                                              ║\n')
  process.stderr.write('║  Trust this workspace?                       ║\n')
  process.stderr.write('║  [Y] Trust and continue                      ║\n')
  process.stderr.write('║  [N] Exit                                    ║\n')
  process.stderr.write('║                                              ║\n')
  process.stderr.write('╚══════════════════════════════════════════════╝\n')
  process.stderr.write('\n')

  try {
    const answer = await question('Trust this workspace? [Y/N]: ')
    if (answer === 'y' || answer === 'yes') {
      trust.trust(cwd)
      process.stderr.write(`✓ Workspace trusted: ${cwd}\n\n`)
    } else {
      process.stderr.write('✗ Workspace not trusted. Exiting.\n')
      rl.close()
      process.exit(1)
    }
  } finally {
    rl.close()
  }
}

export async function runApp(options: RunOptions): Promise<void> {
  // Metrics: count CLI invocation
  getMetrics().cliInvocations.inc()

  // ── Workspace Trust Check ──
  await checkWorkspaceTrust()

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

  // Detect locale and create translation function
  const locale = detectLocale({ lang: options.lang })
  const localeBundles: Record<string, TranslationMap> = {
    'en-US': enUS as TranslationMap,
    'zh-CN': zhCN as TranslationMap,
  }
  const t = createT(localeBundles[locale] || enUS, enUS)

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

  // Phase 9 feature flags (all default true — opt-out via config)
  const features = config.features || {}
  const adaptiveThresholds = features.context?.adaptiveThresholds !== false
  // gated via TokenCounter — set to false to fall back to chars/4 heuristic
  const _useRealTokenizer = features.context?.useRealTokenizer !== false

  const context = new ContextManager({
    maxTokens: contextMaxTokens,
    compactionThreshold: 0.9,
    contextWindow: adaptiveThresholds ? modelContextWindow : undefined,
  })

  // Adaptive memory budget: scale with model's context window
  getMemoryManager().setContextWindow(modelContextWindow)

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

    // First-run setup detection: inject mipham-code-setup guidance when
    // no project or user config exists. This mirrors Claude Code's first-run
    // onboarding flow — the AI proactively offers to help configure the tool.
    const hasProjectConfig = existsSync(join(process.cwd(), '.mipham', 'config.yml'))
    const hasUserConfig = existsSync(join(homedir(), '.mipham', 'config.yml'))
    const hasMiphamMd = existsSync(join(process.cwd(), 'MIPHAM.md'))
    if (!hasProjectConfig && !hasUserConfig) {
      const setupReminder = [
        '── First-Run Setup ──',
        '',
        `This appears to be a first run: no .mipham/config.yml found in project or ~/.mipham/.`,
        '',
        'Invoke the mipham-code-setup skill to guide the user through setup:',
        '- Installation verification',
        '- API key configuration',
        '- Project initialization (.mipham/ + MIPHAM.md + config.yml)',
        '- Provider & model selection',
        '- Skills & permissions setup',
        '- Workspace trust',
        '- Shell & IDE integration',
        '',
        'The user may also run /setup for the guided 6-step wizard.',
        'Be proactive: offer to help configure Mipham Code before diving into',
        'their task. A properly configured environment makes everything smoother.',
      ].join('\n')
      prompt = `${prompt}\n\n<system-reminder name="first-run-setup">\n${setupReminder}\n</system-reminder>`
    } else if (!hasMiphamMd) {
      // Partial setup: has config but no MIPHAM.md
      const partialReminder = [
        '── Missing MIPHAM.md ──',
        '',
        'No MIPHAM.md found in project root. This file tells the AI about',
        'project-specific preferences (language, code style, test framework).',
        '',
        'Suggest creating one: /setup 1 or "help me create a MIPHAM.md"',
        '',
        'A basic MIPHAM.md includes:',
        '- Project name and description',
        '- Primary language (zh-CN / en)',
        '- Tech stack',
        '- Code style preferences',
        '- Test framework',
      ].join('\n')
      prompt = `${prompt}\n\n<system-reminder name="missing-mipham-md">\n${partialReminder}\n</system-reminder>`
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
  const ruleEngine = new ExperienceRuleEngine()
  const engine = new QueryEngine(registry, context, tools, undefined, ruleEngine)
  engine.setHookEngine(hookEngine)
  engine.setArtifactServer(artifactServer)
  engine.setAgentViewManager(agentViewManager)
  engine.setSkillsLoader(skillsLoader)

  // Wire inference hooks (DLP) configuration
  const inferenceHookConfig = loadInferenceHookConfig()
  engine.setInferenceHookConfig(inferenceHookConfig)

  // Initialize credential masking pipeline (strategies: Full, Extract, JWT)
  const { initializePipeline } = await import('./core/credential-masker/index')
  initializePipeline()

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

  // ── Cross-session messaging: register session, heartbeat, shutdown ──
  engine.setSessionId(sessionName)
  const sessionInfo = createSessionInfo(
    sessionName,
    sessionName,
    process.cwd(),
    defaultProvider,
    defaultModel,
  )
  registerActiveSession(sessionInfo)

  // 30-second heartbeat to keep the session file mtime fresh
  const heartbeatInterval = setInterval(() => {
    heartbeatSession(sessionName)
  }, 30_000)

  // Allow heartbeat to not keep the process alive
  if (heartbeatInterval.unref) {
    heartbeatInterval.unref()
  }

  // Load cross-session config and wire into the engine's inbound policy
  const crossSessionConfig = loadCrossSessionConfig(process.cwd())
  engine.setCrossSessionConfig(crossSessionConfig)

  // Auto-save session on exit
  let saved = false
  const saveAndExit = () => {
    saved = true
    clearInterval(heartbeatInterval)
    unregisterSession(sessionName)
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
    clearInterval(heartbeatInterval)
    unregisterSession(sessionName)
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
    React.createElement(I18nProvider, {
      locale,
      t,
      children: React.createElement(App, {
        engine,
        config,
        initialProvider: defaultProvider,
        initialModel: defaultModel,
        lang: options.lang,
        skillsLoader,
        pluginManager,
        version: options.version,
        sessionId: sessionName,
      }),
    }),
  )
  await waitUntilExit()
  saveAndExit()
}
