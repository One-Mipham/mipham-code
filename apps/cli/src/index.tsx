import React from 'react'
import { join, basename } from 'node:path'
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
  loadSettingsJson,
} from './config/loader'
import {
  registerActiveSession,
  heartbeatSession,
  unregisterSession,
  createSessionInfo,
  ensureUniqueSessionName,
  discoverSessions,
} from './agent/cross-session/discovery'
import { bootstrapProviders } from './providers/bootstrap'
import { InstructionsLoader } from './core/instructions'
import { loadSessionMemories, getMemoryManager } from './core/memory/memory-loader'
import { ContextManager } from './core/context'
import { PrefixCacheTracker } from './core/context-token'
import { QueryEngine } from './core/engine'
import { generateSessionName } from './core/session-name'
import { ExperienceRuleEngine } from './core/rule-engine.js'
import { SessionLog } from './core/session-log'
import { SessionStore } from './core/session-store'
import type { PermissionLevel, MiphamConfig, McpServerConfig } from './shared/types'
import { SkillsLoader } from './skills/loader'
import { PluginManager } from './plugin/plugin-manager'
import { loadPlugins } from './plugin/plugin-loader'
import { createToolRegistry } from './tools'
import { Context } from './vajra'
import { mountSkills, SKILLS_KEY } from './skills/seam'
import { mountLlm, LLM_KEY } from './providers/llm'
import { mountConstitution, createConstitution } from './core/constitution-seam'
import { ConstitutionLoader } from './core/constitution-loader'
import { McpClient } from './mcp/client'
import { registerMcpServerTools, syncMcpToolsOnChange } from './mcp/registry'
import { formatMcpConnectFailures, type McpConnectFailure } from './mcp/connect-failures'
import { AgentRegistry } from './agent/agent-registry'
import { HookEngine } from './core/hooks'
import { loadHookConfigs } from './core/hooks-config'
import { ArtifactServer } from './artifacts/server'
import { getMetrics } from './core/metrics'
import { getWorkspaceTrust } from './core/workspace-trust'
import { ARTIFACTS_DIR, ARTIFACT_PORT, MIPHAM_DIR } from './shared/constants'
import { AgentViewManager } from './agent-view/agent-view-manager'
import { AgentViewDashboard } from './agent-view/dashboard'
import { createT } from './i18n-core/t'
import { detectLocale } from './i18n-core/detect'
import { I18nProvider } from './i18n-context'
import { ConfigWizard } from './ui/config-wizard'
import enUS from './i18n-core/locales/en-US.json' with { type: 'json' }
import zhCN from './i18n-core/locales/zh-CN.json' with { type: 'json' }
import type { TranslationMap } from './i18n-core/types'

// Locale bundles — defined at module level so the remote-attach branch can
// reference them before the full bootstrap path runs.
const localeBundles: Record<string, TranslationMap> = {
  'en-US': enUS as TranslationMap,
  'zh-CN': zhCN as TranslationMap,
}

interface RunOptions {
  model?: string
  provider?: string
  lang?: string
  permission?: string
  resume?: string
  version?: string
  /** When set, launch TUI in remote mode connected to a daemon session. */
  remoteSession?: { sessionId: string; port: number; token: string }
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

// ── SetupGate: first-run wizard → App bridge ──

interface SetupGateProps {
  needsSetup: boolean
  engine: QueryEngine
  config: MiphamConfig
  defaultProvider: string
  defaultModel: string
  lang?: string
  skillsLoader?: SkillsLoader
  pluginManager?: PluginManager
  version?: string
  sessionId: string
  agentViewManager?: AgentViewManager
  locale: string
  t: (key: string) => string
}

function SetupGate(props: SetupGateProps) {
  const [showWizard, setShowWizard] = React.useState(props.needsSetup)
  const [wizardProvider, setWizardProvider] = React.useState<string | null>(null)
  const [wizardModel, setWizardModel] = React.useState<string | null>(null)

  // When wizard completes: write config, switch provider, proceed to App
  const handleWizardComplete = React.useCallback(
    (wizardConfig: { providerId: string; modelId: string; apiKey: string }) => {
      // Switch the engine to the newly configured provider
      try {
        props.engine.switchProvider(wizardConfig.providerId, wizardConfig.modelId)
      } catch {
        // If switch fails (e.g. provider not yet in registry), just use as-is
      }
      setWizardProvider(wizardConfig.providerId)
      setWizardModel(wizardConfig.modelId)
      setShowWizard(false)
    },
    [props.engine],
  )

  const handleWizardSkip = React.useCallback(() => {
    setShowWizard(false)
  }, [])

  if (showWizard) {
    return React.createElement(ConfigWizard, {
      onComplete: handleWizardComplete,
      onSkip: handleWizardSkip,
    })
  }

  return React.createElement(App, {
    engine: props.engine,
    config: props.config,
    initialProvider: wizardProvider || props.defaultProvider,
    initialModel: wizardModel || props.defaultModel,
    lang: props.lang,
    skillsLoader: props.skillsLoader,
    pluginManager: props.pluginManager,
    version: props.version,
    sessionId: props.sessionId,
    agentViewManager: props.agentViewManager,
  })
}

/**
 * Connect all MCP servers in parallel and register their tools into the shared
 * registry. Runs lazily in the background so a slow or dead server (e.g. a 15s
 * connect timeout) never blocks first paint. Failures are non-fatal.
 */
async function connectMcpServers(
  mcpServers: McpServerConfig[],
  tools: ReturnType<typeof createToolRegistry>,
): Promise<McpConnectFailure[]> {
  if (mcpServers.length === 0) return []
  const mcp = McpClient.getInstance()
  // Wire runtime tool-list changes before connect so mid-connect updates land.
  syncMcpToolsOnChange(mcp, tools)
  const results = await Promise.allSettled(
    mcpServers.map(async (server) => {
      await mcp.connect(server)
      const count = registerMcpServerTools(server.name, tools)
      if (count > 0) {
        process.stderr.write(`[mcp] "${server.name}": registered ${count} tools\n`)
      }
    }),
  )
  const failures: McpConnectFailure[] = []
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!
    if (result.status === 'rejected') {
      const name = mcpServers[i]!.name
      const reason = String(result.reason)
      failures.push({ name, reason })
      process.stderr.write(`[mcp] Failed to connect "${name}": ${reason}\n`)
    }
  }
  return failures
}

export async function runApp(options: RunOptions): Promise<void> {
  // Metrics: count CLI invocation + active session
  getMetrics().cliInvocations.inc()
  getMetrics().activeSessions.inc()

  // ── Workspace Trust Check ──
  await checkWorkspaceTrust()

  // ── Remote attach mode ──────────────────────────────────────────────────
  // When the TUI is launched via `mipham attach`, skip the entire local
  // engine bootstrap and connect to the daemon via WebSocket instead.
  if (options.remoteSession) {
    const { RemoteEngine } = await import('./daemon/remote-engine')
    const engine = new RemoteEngine(options.remoteSession)

    // Detect locale and create translation function (same as local path)
    const locale = detectLocale({ lang: options.lang })
    const t = createT(localeBundles[locale] || enUS, enUS)

    // Set terminal window title
    process.stdout.write('\x1b]0;Mipham Code\x07')

    const { waitUntilExit } = render(
      React.createElement(I18nProvider, {
        locale,
        t,
        children: React.createElement(App, {
          engine,
          config: {} as MiphamConfig,
          initialProvider: 'remote',
          initialModel: 'remote',
          version: options.version,
          sessionId: options.remoteSession.sessionId,
        }),
      }),
    )
    await waitUntilExit()

    // Close the WebSocket connection on the way out
    engine.close()
    return
  }

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
  const t = createT(localeBundles[locale] || enUS, enUS)

  // Bootstrap providers
  const defaultProvider = options.provider || config.defaultProvider
  const defaultModel = options.model || config.defaultModel
  const registry = bootstrapProviders(config.providers, defaultProvider, defaultModel)

  // Load instructions
  const instructions = new InstructionsLoader()
  instructions.loadAll(process.cwd())

  // 空目录提示：愣建文件夹时温和提醒走 mipham init，而非默默开始（寒暄克制——一句即可）
  const { isEmptyProject } = await import('./core/project-scaffold')
  if (isEmptyProject(process.cwd())) {
    console.log(
      '\n💡 空目录。运行 `mipham init` 生成基础文档，或 `mipham init --full` 生成完整规范（八章 CLAUDE.md + 7 个 .md + .github 模板），或直接开始对话。\n',
    )
  }

  // Load skills
  const skillsLoader = new SkillsLoader()
  skillsLoader.loadBuiltinFromPackage()
  skillsLoader.loadUserSkills()
  if (config.skills?.paths) {
    skillsLoader.loadExternal(config.skills.paths)
  }

  // Initialize plugin manager
  const pluginManager = new PluginManager()

  // Generate session name for tracking (used by /cd to persist cwd)
  const sessionName = generateSessionName(options.resume)

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

  const context = new ContextManager({
    maxTokens: contextMaxTokens,
    compactionThreshold: 0.9,
    contextWindow: adaptiveThresholds ? modelContextWindow : undefined,
  })
  const sessionLog = new SessionLog(sessionName)
  sessionLog.append({
    type: 'session/start',
    at: Date.now(),
    sessionId: sessionName,
    provider: defaultProvider,
    model: defaultModel,
    cwd: process.cwd(),
  })
  context.setLog(sessionLog)
  // Cache-aware microcompaction: track the provider's prompt-cache prefix.
  context.setCacheTracker(new PrefixCacheTracker())

  // Adaptive memory budget: scale with model's context window
  getMemoryManager().setContextWindow(modelContextWindow)

  if (options.resume) {
    const log = SessionStore.loadLog(options.resume)
    const events = log.events()
    if (events.length > 0) {
      const start = events.find((e) => e.type === 'session/start') as
        { type: 'session/start'; cwd?: string } | undefined
      if (start?.cwd && existsSync(start.cwd)) {
        try {
          process.chdir(start.cwd)
        } catch {
          // cwd 可能已不存在
        }
      }
      context.restoreLog(log)
      context.setSystemPrompt(instructions.buildSystemPrompt(config.permission as string))
    }
  }

  if (context.getMessageCount() === 0) {
    const basePrompt = instructions.buildSystemPrompt(config.permission as string)
    const memoryReminder = loadSessionMemories(basePrompt)
    const skillsReminder = skillsLoader.buildSystemReminder()

    // Inject previous session summary for AI continuity
    let prompt = basePrompt
    if (skillsReminder) {
      prompt = `${prompt}\n\n${skillsReminder}`
    }
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

  // Initialize credential masking pipeline (strategies: Full, Extract, JWT)
  const { initializePipeline } = await import('./core/credential-masker/index')
  initializePipeline()

  // Load credential masking config and inject it into the tool seam
  const credentialMaskingConfig = loadCredentialMaskingConfig()
  const vajraContext = new Context()
  vajraContext.provide('credentials', credentialMaskingConfig)

  // 对齐缝：宪法先就位，后续每个 Service 挂载（含工具）都在挂载前过对齐门。
  mountConstitution(vajraContext, createConstitution(new ConstitutionLoader()))

  // Create tool registry with all built-in tools (mounted as Vajra services)
  const tools = createToolRegistry(vajraContext)

  // 绞杀收官：skills + llm 也挂载到同一 Vajra Context（tools 已接）
  mountSkills(vajraContext, skillsLoader)
  mountLlm(vajraContext, registry)

  // Connect MCP servers lazily in the background: the UI renders immediately,
  // and each server's tools register into the shared registry as it connects.
  // A dead server (e.g. a 15s connect timeout) no longer blocks startup.
  const mcpConnectPromise = connectMcpServers(config.skills?.mcpServers ?? [], tools)

  // Initialize hook engine — register skill-defined hooks
  const hookEngine = new HookEngine()
  for (const skill of skillsLoader.list()) {
    if (skill.hooks) {
      for (const hook of skill.hooks) {
        hookEngine.register(hook)
      }
    }
  }

  // Register settings.json hooks (Claude Code convention — additive across levels)
  const settingsJson = loadSettingsJson(process.cwd())
  for (const def of loadHookConfigs(settingsJson.hooks)) {
    hookEngine.register(def)
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
  engine.setSkills(vajraContext.get(SKILLS_KEY)!)
  engine.setLlm(vajraContext.get(LLM_KEY)!)

  // Wire inference hooks (DLP) configuration
  const inferenceHookConfig = loadInferenceHookConfig()
  engine.setInferenceHookConfig(inferenceHookConfig)

  // Sync engine permission with config (fix: UI shows "auto" but engine defaulted to bypass-legacy)
  if (config.permission) {
    engine.getPermission().setDefaultLevel(config.permission as PermissionLevel)
  }

  // Apply org-level permission restrictions (P0: bypassPermissions policy gap)
  if (config.permissionRestrictions) {
    engine.getPermission().setRestrictions(config.permissionRestrictions)
  }

  // Apply user-defined permission rules (allow/deny) — wire the rule system into runtime
  if (config.permissionRules) {
    for (const rule of config.permissionRules.allow ?? []) engine.getPermission().allow(rule)
    for (const rule of config.permissionRules.deny ?? []) engine.getPermission().deny(rule)
  }

  // Apply settings.json permissions (allow/deny) — Claude Code convention
  for (const rule of settingsJson.permissions.allow) engine.getPermission().allow(rule)
  for (const rule of settingsJson.permissions.deny) engine.getPermission().deny(rule)

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

  // Surface MCP connect failures to the model once they settle, so it knows
  // those servers' tools are unavailable (rather than silently concluding the
  // tools don't exist). Injected asynchronously — never blocks first paint.
  void mcpConnectPromise.then((failures) => {
    const notice = formatMcpConnectFailures(failures)
    if (notice) engine.getContext().addMessage({ role: 'user', content: notice })
  })
  // Human-readable, cross-session-addressable name. Defaults to the cwd basename
  // so `@mipham-code` can address this session; uniqueness is enforced against
  // other live sessions (suffix -2, -3, …). The id stays a stable `session-<ts>`.
  const defaultName = basename(process.cwd()) || 'session'

  // Load cross-session config first so the registered SessionInfo carries this
  // session's inbound policy — senders discover it and report "refused" instead
  // of a silent drop when policy is 'deny'.
  const crossSessionConfig = loadCrossSessionConfig(process.cwd())
  engine.setCrossSessionConfig(crossSessionConfig)

  const sessionInfo = createSessionInfo(
    sessionName,
    ensureUniqueSessionName(defaultName, discoverSessions()),
    process.cwd(),
    defaultProvider,
    defaultModel,
    crossSessionConfig.crossSessionInbound,
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

  // P2-1: Trigger SessionStart hooks after full initialization
  hookEngine.executeSessionStart(sessionName).catch(() => {
    // Hook failures never block session startup
  })

  // Auto-save session on exit
  let saved = false
  const saveAndExit = () => {
    saved = true
    clearInterval(heartbeatInterval)
    unregisterSession(sessionName)
    // P2-1: Trigger SessionEnd hooks before cleanup (best-effort)
    hookEngine.executeSessionEnd(sessionName).catch(() => {})
    artifactServer.stop()
    if (context.getMessageCount() > 0) {
      const log = context.getLog()
      if (log) {
        SessionStore.saveLog(sessionName, log, {
          provider: defaultProvider,
          model: defaultModel,
          cwd: process.cwd(),
        })
      } else {
        SessionStore.save(sessionName, context.getMessages(), {
          provider: defaultProvider,
          model: defaultModel,
          cwd: process.cwd(),
        })
      }
    }
    // Finalize the session — write session summary + flush CRSI effectiveness
    // (evaluate rules and apply auto-degrade/disable). Best-effort: the
    // self-improvement closeout must never block session exit.
    try {
      engine.getAutoMemory().finalizeSession()
    } catch {
      // ignore — CRSI closeout is non-critical
    }
    getMetrics().activeSessions.dec()
    process.exit(0)
  }

  process.on('SIGINT', saveAndExit)
  process.on('SIGTERM', saveAndExit)

  // Safety net: auto-save on exit for paths that bypass saveAndExit
  process.on('exit', () => {
    clearInterval(heartbeatInterval)
    unregisterSession(sessionName)
    // Finalize the session on non-interactive exit paths
    // (daemon worker / crash / kill) that bypass saveAndExit. saveAndExit
    // already finalizes; guard on !saved to avoid double-evaluating.
    if (!saved) {
      try {
        engine.getAutoMemory().finalizeSession()
      } catch {
        // ignore — CRSI closeout is non-critical
      }
    }
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

  // ── First-run detection: show interactive ConfigWizard if no config exists ──
  const hasUserConfig = existsSync(join(homedir(), '.mipham', 'config.yml'))
  const hasProjectConfig = existsSync(join(process.cwd(), '.mipham', 'config.yml'))
  const needsSetup = !hasUserConfig && !hasProjectConfig

  const { waitUntilExit } = render(
    React.createElement(I18nProvider, {
      locale,
      t,
      children: React.createElement(SetupGate, {
        needsSetup,
        engine,
        config,
        defaultProvider,
        defaultModel,
        lang: options.lang,
        skillsLoader,
        pluginManager,
        version: options.version,
        sessionId: sessionName,
        agentViewManager,
        locale,
        t,
      }),
    }),
  )
  await waitUntilExit()
  saveAndExit()
}
