/**
 * Mipham Code — Slash Command Registry
 *
 * All commands mirror Claude Code's UX so users need zero re-learning.
 * Commands marked [stub] are recognized but indicate WIP status.
 */
import type { QueryEngine } from '../core/engine'
import type { MiphamConfig } from '../shared/index.ts'
import type { SkillsLoader } from '../skills/loader'
import type { PluginManager } from '../plugin/plugin-manager'
import type { Message } from '../shared/types.js'
import type { UpdateStatus } from '../shared/update'
import { McpClient } from '../mcp/client'
import { buildCapabilityReport } from '../core/capability-inventory'
import { InstructionsLoader } from '../core/instructions'
import { findDerivableSections, DERIVABLE_HINTS } from '../core/claude-md-audit'
import { fixDoctor, fixConfig, fixCache, selectRepoClaudeFiles } from '../core/fix'
import { fixCodeTarget } from '../core/fix-code'
import { runCrsiModification, approvePending, rejectPending, hasPending } from '../core/crsi-modify'
import {
  produceCrsiProposal,
  produceRuleProposal,
  produceProseProposal,
  produceCrossoverProposal,
  selectCrsiSignal,
  collectSkillFiles,
  proseProposalId,
  hasProposedProse,
  appendProseProposal,
  clearProseProposals,
  LESSONS_FILE,
  MANAGED_RULES_FILE,
} from '../core/crsi-producer'
import { prefilterProposal } from '../core/proposal-guard'
import { runEval, appendEvalScore } from '../core/eval-harness'
import { listRewardFns } from '../core/reward-fn'
import {
  runTaskPerformance,
  measureSkillDeltaRepeated,
  stripCodeFences,
} from '../core/task-performance'
import { randomUUID } from 'node:crypto'
import {
  buildImprovementReport,
  appendImprovement,
  readImprovements,
  improvementRate,
  setPendingVerdict,
  getPendingVerdict,
  shouldBlockApproval,
} from '../core/improvement-track'
import { NPM_UPDATE_COMMAND, PACKAGE_VERSION, COAUTHOR_TRAILER } from '../shared/index.ts'
import { getPreference } from '../config/preferences'
import { loadCrossSessionConfig, tryRestoreFromBackup } from '../config/loader'
import { getMemoryManager } from '../core/memory/memory-loader'
import { stripIndent } from './strip-indent.js'
import { createT } from '../i18n-core/t'
import type { TranslationMap } from '../i18n-core/types'
import enUS from '../i18n-core/locales/en-US.json' with { type: 'json' }
import zhCN from '../i18n-core/locales/zh-CN.json' with { type: 'json' }

// Default t() fallback for plain-function contexts (tests, bootstrap).
// When called from the React tree, ctx.t is populated from useI18n().
const defaultT = createT(enUS as unknown as TranslationMap, zhCN as unknown as TranslationMap)

/** Resolve the best available t() function: prefer ctx.t (locale-aware from React),
 *  fall back to module-level defaultT (en-US). */
function resolveT(ctx: CommandContext): (key: string, params?: Record<string, string>) => string {
  return ctx.t && typeof ctx.t === 'function' ? ctx.t : defaultT
}
import {
  initCmd,
  setupCmd,
  recommendCmd,
  permissionsCmd,
  addDirCmd,
  securityCmd,
  promptAuditCmd,
  trustCmd,
} from '../commands/project.js'
import { themeCmd, releaseNotesCmd, ideCmd, terminalSetupCmd } from '../commands/environment.js'
import { commitCmd, pushCmd, prCmd, issueCmd } from '../commands/git.js'
import { suggestDirectories } from '../commands/cd-suggest.js'
import { keysCmd } from '../commands/keys'
import { workflowViewCmd, workflowWatchCmd } from '../commands/workflow-view.js'
import { listActiveAutoloops, formatLoopRows } from '../commands/autoloop-journal.js'
import { execSync } from 'node:child_process'
import { OLLAMA_PRESET_MODELS } from '../shared/constants'
import { renameActiveSession } from '../agent/cross-session/discovery'

export interface CommandContext {
  engine: QueryEngine
  config: MiphamConfig
  providerId: string
  modelId: string
  version: string
  sessionId: string
  // Callbacks for commands that mutate App state
  setSessionTitle: (title: string) => void
  setFastMode: (on: boolean) => void
  setEffort: (level: string) => void
  setFocusMode: (on: boolean) => void
  setGoal: (text: string) => void
  setUltracodeMode: (on: boolean) => void
  setUpdateStatus: (s: UpdateStatus) => void
  skillsLoader?: SkillsLoader
  pluginManager?: PluginManager
  /** i18n translate function — populated from React tree via useI18n().
   *  Falls back to module-level defaultT (en-US) in tests / bootstrap. */
  t: (key: string, params?: Record<string, string>) => string
}

export interface CommandResult {
  /** System message to display */
  content: string
  /** If true, exit the app */
  exit?: boolean
  /** If provided, update provider after command */
  nextProvider?: string
  /** If provided, update model after command */
  nextModel?: string
  /** If true, clear all messages (handled by caller) */
  clearMessages?: boolean
  /** Content to copy to clipboard (handled by caller) */
  copyContent?: string
  /** If set, route this message to the AI engine — bridges slash commands → skill/agent invocation.
   *  The app layer replaces the user input with this string and falls through to AI processing. */
  forwardToAI?: string
  /** If set, restored messages to load into the session (used by /resume last). */
  forwardedMessages?: Message[]
  /** If true, resume into current non-empty session — app should warn before loading */
  resumeWarning?: boolean
  /** API Key 补录请求：切换前需用户输入 Key */
  needsApiKey?: {
    providerId: string
    modelId: string
    providerName: string
  }
}

export type CommandHandler = (
  ctx: CommandContext,
  args: string[],
) => CommandResult | Promise<CommandResult>

// ═══════════════════════════════════════════════════════════════
// Session & Identity
// ═══════════════════════════════════════════════════════════════

const helpCmd: CommandHandler = (ctx) => {
  const skillCount = ctx.skillsLoader?.list().length ?? 14
  const toolsCount = ctx.engine.getTools().size
  const cmdCount = getCommandNames().length

  return {
    content: stripIndent`
      Mipham Code v${PACKAGE_VERSION} — Commands

      ── Session ──────────────────────────
      /help          Show this help
      /commands      List all ${cmdCount} commands
      /version       Show version info
      /clear         Clear conversation
      /compact       Compact context window
      /context       Show context stats
      /status        Session and system status
      /cost          Token usage estimate
      /usage         Detailed usage dashboard
      /rename <name> Rename current session
      /goal <text> [--decompose] [--verify-script <path>] [--verify-skill <name>]   Set session goal with verification
      /recap         Summarize session so far
      /summary       Generate session summary
      /stats         Session usage statistics
      /files         List files in CWD
      /cd <path>     Change working directory
      /export        Export conversation to file
      /doctor        System diagnostics
      /resume        List saved sessions
      /resume last   Restore most recent session
      /resume delete <name>   Delete a saved session
      /branch <name> Fork conversation

      ── History ─────────────────────────
      /rewind        Undo last AI turn
      /undo          Same as /rewind
      /copy [N]      Copy last response to clipboard
      /focus         Toggle focus view (last exchange only)

      ── Model & Provider ────────────────
      /pick          Open model picker (or Ctrl+P)
      /model         Show current model
      /models        List all available models
      /provider      Show current provider
      /providers     List configured providers
      /switch <p> <m> Switch provider and model
      /config        View configuration
      /fast [on|off] Toggle fast mode
      /effort <lvl>  Set reasoning effort (low|medium|high|xhigh|max)
      /theme [dark|light|auto] Set terminal theme
      /ollama-refresh Refresh Ollama model list at runtime

      ── Tools & Skills ──────────────────
      /tools         List available tools (${toolsCount} total)
      /skills        List loaded skills (${skillCount} built-in)
      /reload-skills Reload all skills
      /browse-skills Browse community skill marketplace
      /install-skill Install a skill by name or URL
      /remove-skill  Remove an installed skill
      /commands      List all slash commands
      /mcp           MCP server status
      /plugins       List installed plugins
      /browse-plugins Browse community plugins
      /install-plugin Install plugin from npm or path
      /remove-plugin  Remove an installed plugin
      /plugin-enable  Enable a disabled plugin
      /plugin-disable  Disable an enabled plugin

      ── Workflow ────────────────────────
      /plan          Enter plan mode (read-only)
      /no-plan       Exit plan mode
      /tdd [goal]    Test-Driven Development workflow
      /todos [list|create] Task management
      /tasks         Background tasks
      /review        Code review workflow
      /pr-comments   PR review summary
      /diff          Show git diff
      /workflows     List workflow scripts
      /loop <int> <p>  Run prompt on interval
      /loop auto <p>   Autonomous self-paced loop
      /loop stop        Stop active autonomous loop
      /loop init        Scaffold .mipham/ vault structure
      /loop status      Show autonomous loop progress
      /batch          Apply changes across files
      /hooks          Manage lifecycle hook scripts
      /schedule      View scheduled tasks

      ── Git & GitHub ─────────────────────
      /commit        Review staged changes + commit
      /push          Push current branch
      /pr            Create a pull request
      /issue         File a GitHub issue

      ── Code Quality ─────────────────────
      /simplify      Review for reuse, quality, simplification
      /lint          Run project linter

      ── Project ─────────────────────────
      /init          Initialize .mipham config
      /setup         Guided project setup wizard
      /recommend     Analyze project + recommend setup
      /permissions   Show permission settings
      /add-dir <dir> Add workspace directory
      /security      Security review checklist
      /audit         Same as /security

      ── Environment ─────────────────────
      /upgrade       Show upgrade instructions
      /release-notes View version changelog
      /ide           IDE integration guide
      /terminal-setup Shell & terminal config
      /memory        Manage AI memories

      ── Account ─────────────────────────
      /login         Show API key status
      /logout        Clear credentials guide
      /keys          List API key rotation status
      /keys rotate   Rotate an API key
      /keys audit    Check for expired keys
      /feedback      Send feedback

      ── Agents ──────────────────────────
      /agents        Agent view dashboard
      /bg <prompt>   Run a background agent task

      Type /exit or Esc to quit.
    `,
  }
}

const versionCmd: CommandHandler = (ctx) => {
  const skillCounts = ctx.skillsLoader?.countByType()
  const skillsLine = skillCounts
    ? `Skills:   ${skillCounts.total} built-in (${skillCounts.standard} standard + ${skillCounts.mipham} mipham)`
    : `Skills:   (loader unavailable)`
  const toolsCount = ctx.engine.getTools().size

  return {
    content: stripIndent`
      Mipham Code v${ctx.version}

      Runtime:  Bun ${typeof Bun !== 'undefined' ? Bun.version : '(Node.js)'}
      Platform: ${process.platform} ${process.arch}
      Node:     ${process.version}
      CWD:      ${process.cwd()}

      Provider: ${ctx.providerId} / ${ctx.modelId}
      Tools:    ${toolsCount} built-in
      ${skillsLine}
      License:  Apache 2.0
    `,
  }
}

const clearCmd: CommandHandler = (ctx) => {
  ctx.engine.getContext().clear()
  const t = resolveT(ctx)
  return { content: t('commands.clear.confirmed'), clearMessages: true }
}

const exitCmd: CommandHandler = () => ({ content: '', exit: true })

// ═══════════════════════════════════════════════════════════════
// Context & Status
// ═══════════════════════════════════════════════════════════════

const compactCmd: CommandHandler = async (ctx) => {
  const t = resolveT(ctx)
  const context = ctx.engine.getContext()
  const msgsBefore = context.getMessageCount()
  const tokensBefore = context.getEstimatedTokens()

  // Show start progress
  process.stderr.write(
    `🔄 Compacting: ${msgsBefore} messages, ${tokensBefore.toLocaleString()} tokens...\n`,
  )

  const startTime = Date.now()
  const result = await context.compact('user requested compaction')
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  const msgsAfter = context.getMessageCount()
  const saved = result.before > 0 ? ((1 - result.after / result.before) * 100).toFixed(0) : '0'

  return {
    content: [
      t('commands.compact.confirmed'),
      `Messages: ${msgsBefore} → ${msgsAfter} | Tokens: ${result.before.toLocaleString()} → ${result.after.toLocaleString()} (${saved}% saved)`,
      `Duration: ${elapsed}s`,
      msgsBefore > msgsAfter
        ? `💡 Tip: Use /compact early to prevent automatic compaction delays.`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

const contextCmd: CommandHandler = (ctx) => {
  const t = resolveT(ctx)
  const c = ctx.engine.getContext()
  const tokens = c.getEstimatedTokens()
  const msgs = c.getMessages()
  const systemPromptLen = c.getSystemPrompt().length
  return {
    content: stripIndent`
      ${t('commands.context.title')}
      ${t('commands.context.messages')}       ${msgs.length}
      ${t('commands.context.estimated_tokens')} ${tokens.toLocaleString()} / 200,000
      ${t('commands.context.usage_pct')}           ${((tokens / 200_000) * 100).toFixed(1)}%
      ${t('commands.context.system_prompt')}   ${systemPromptLen.toLocaleString()} chars (~${Math.ceil(systemPromptLen / 4).toLocaleString()} tokens)
      ${t('commands.context.compaction')}      at 90% (${(200_000 * 0.9).toLocaleString()} tokens)
    `,
  }
}

const statusCmd: CommandHandler = async (ctx) => {
  const t = resolveT(ctx)
  const c = ctx.engine.getContext()
  const tools = ctx.engine.getTools()
  const runtime = typeof Bun !== 'undefined' ? 'Bun' : 'Node.js'
  const runtimeVer = typeof Bun !== 'undefined' ? Bun.version : process.version
  const health = ctx.engine.getRegistry()
    ? await ctx.engine.getRegistry().healthMap()
    : new Map<string, boolean>()
  const providerHealth = ctx.config.providers
    .filter((p) => p.status !== 'upcoming')
    .map((p) => `${p.id} ${health.get(p.id) ? '🟢' : '🔴'}`)
    .join('  ')

  return {
    content: stripIndent`
      ${t('commands.status.session_title')}
      ${t('commands.status.provider')}   ${ctx.providerId}
      ${t('commands.status.model')}      ${ctx.modelId}
      ${t('commands.status.messages')}   ${c.getMessages().length}
      ${t('commands.status.tokens')}     ~${c.getEstimatedTokens().toLocaleString()} / 200,000
      ${t('commands.status.tools')}      ${tools.size} ${t('commands.status.loaded')}
      ${t('commands.status.permission')} ${ctx.config.permission}

      ${t('commands.status.system_title')}
      ${t('commands.status.platform')}   ${process.platform} ${process.arch}
      ${t('commands.status.runtime')}    ${runtime} ${runtimeVer}
      ${t('commands.status.cwd')}        ${process.cwd()}

      Providers
      ${providerHealth}
    `,
  }
}

const costCmd: CommandHandler = (ctx) => {
  const t = resolveT(ctx)
  const tokens = ctx.engine.getContext().getEstimatedTokens()
  const cacheStatus = ctx.engine.getContext().getCacheStatus()
  const cachedTokens = cacheStatus.cachedTokens
  const hitRatio = tokens > 0 ? Math.min(1, cachedTokens / tokens) : 0
  const uncachedTokens = Math.max(0, tokens - cachedTokens)
  return {
    content: stripIndent`
      ${t('commands.context_tokens.title')}
      ${t('commands.context_tokens.context_tokens')} ~${tokens.toLocaleString()} / 200,000
      ${t('commands.context_tokens.usage')} ${((tokens / 200_000) * 100).toFixed(1)}%
      ${t('commands.context_tokens.prompt_cache', {
        cached: cachedTokens.toLocaleString(),
        ratio: (hitRatio * 100).toFixed(1),
        uncached: uncachedTokens.toLocaleString(),
      })}

      ${t('commands.context_tokens.footer')}
    `,
  }
}

// ═══════════════════════════════════════════════════════════════
// Model & Provider
// ═══════════════════════════════════════════════════════════════

const modelCmd: CommandHandler = (ctx) => {
  const t = resolveT(ctx)
  return { content: t('commands.model.current', { model: ctx.modelId, provider: ctx.providerId }) }
}

const modelsCmd: CommandHandler = (ctx) => {
  const t = resolveT(ctx)
  const lines = ctx.config.providers
    .filter((p) => p.status !== 'upcoming')
    .flatMap((p) =>
      p.models
        .filter((m) => m.status === 'active')
        .map(
          (m) =>
            `  ${p.id.padEnd(12)} ${m.id.padEnd(30)} ${m.contextWindow.toLocaleString()} ctx  ${m.vision ? '🖼' : '📝'}`,
        ),
    )

  return {
    content: `${t('commands.models.title', { count: String(lines.length) })}\n\n${t('commands.models.header')}\n${'-'.repeat(80)}\n${lines.join('\n')}\n\n${t('commands.models.hint')}`,
  }
}

const ollamaRefreshCmd: CommandHandler = (ctx) => {
  const t = resolveT(ctx)
  const ollamaProvider = ctx.config.providers.find((p) => p.id === 'ollama')
  if (!ollamaProvider) {
    return { content: t('commands.ollama_refresh.not_configured') }
  }

  const before = ollamaProvider.models.length
  try {
    const seen = new Set<string>()
    const refreshed: Array<{ id: string }> = []

    // 1. Scan locally downloaded models via `ollama list`
    try {
      const out = execSync('ollama list', { timeout: 5000, encoding: 'utf-8' })
      const lines = out.split('\n').slice(1).filter(Boolean)
      for (const line of lines) {
        const name = line.split(/\s+/)[0]!
        if (!seen.has(name)) {
          seen.add(name)
          refreshed.push({ id: name })
        }
      }
    } catch {
      // ollama list failed (not installed / not running) — continue with presets
    }

    // 2. Merge preset models (deduplicated)
    for (const preset of OLLAMA_PRESET_MODELS) {
      if (!seen.has(preset.id)) {
        seen.add(preset.id)
        refreshed.push({ id: preset.id })
      }
    }

    // 3. Update the in-memory provider model list
    ollamaProvider.models = refreshed.map((m) => ({
      id: m.id,
      name: m.id,
      providerId: 'ollama',
      contextWindow: 128_000,
      maxOutput: 32_000,
      vision: false,
      status: 'active' as const,
    }))

    const after = refreshed.length
    const added = after - before
    return {
      content: t('commands.ollama_refresh.done', {
        total: String(after),
        added: added > 0 ? `+${added}` : String(added),
      }),
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: t('commands.ollama_refresh.error', { error: msg }) }
  }
}

const providerCmd: CommandHandler = (ctx) => {
  const t = resolveT(ctx)
  return {
    content: t('commands.provider.current', { provider: ctx.providerId, model: ctx.modelId }),
  }
}

const providersCmd: CommandHandler = async (ctx) => {
  const t = resolveT(ctx)
  const health = ctx.engine.getRegistry()
    ? await ctx.engine.getRegistry().healthMap()
    : new Map<string, boolean>()

  const lines = ctx.config.providers.map((p) => {
    if (p.status === 'upcoming') {
      return `  ${p.id.padEnd(14)} ${p.name.padEnd(20)} ${p.protocol.padEnd(18)} ${p.models.length} models  ⏳ [upcoming]`
    }
    const ok = health.get(p.id) ?? false
    return `  ${p.id.padEnd(14)} ${p.name.padEnd(20)} ${p.protocol.padEnd(18)} ${p.models.length} models  ${ok ? '🟢 reachable' : '🔴 unreachable'}`
  })
  return {
    content: `${t('commands.providers.title')}\n\n${lines.join('\n')}\n\n${t('commands.providers.current', { provider: ctx.providerId, model: ctx.modelId })}`,
  }
}

/** Detect whether an API key is missing (empty, placeholder, or env-var reference that resolves to empty). */
function isApiKeyMissing(apiKey: string): boolean {
  if (!apiKey || apiKey.trim() === '') return true
  if (apiKey === 'ollama-local') return false // Ollama local — no key needed
  if (/^\$\{[A-Z_]+\}$/.test(apiKey.trim())) return true // ${VAR} placeholder
  return false
}

const switchCmd: CommandHandler = (ctx, args) => {
  const t = resolveT(ctx)
  const [newProvider, newModel] = args
  if (!newProvider || !newModel) {
    return { content: t('commands.switch.usage') }
  }

  const provider = ctx.config.providers.find((p) => p.id === newProvider)
  if (!provider) {
    return { content: t('commands.switch.unknown_provider', { provider: newProvider }) }
  }

  // Check API Key before switching
  if (isApiKeyMissing(provider.apiKey)) {
    return {
      content: t('commands.switch.needs_api_key', { provider: provider.name }),
      needsApiKey: { providerId: newProvider, modelId: newModel, providerName: provider.name },
    }
  }

  ctx.engine.switchProvider(newProvider, newModel)
  return {
    content: t('commands.switch.confirmed', { provider: newProvider, model: newModel }),
    nextProvider: newProvider,
    nextModel: newModel,
  }
}

const configCmd: CommandHandler = (ctx) => {
  const t = resolveT(ctx)
  const c = ctx.config
  const xs = loadCrossSessionConfig(process.cwd())
  const lines = [
    `version:          ${c.version}`,
    `defaultProvider:  ${c.defaultProvider}`,
    `defaultModel:     ${c.defaultModel}`,
    `permission:       ${c.permission}`,
    `showThinking:     ${c.showThinking ?? 'off'}`,
    `showSchedulingNotices: ${c.showSchedulingNotices ?? false}`,
    `showCommandPicker: ${c.showCommandPicker ?? false}`,
    `providers:        ${c.providers.length} configured`,
    '',
    `crossSessionInbound: ${xs.crossSessionInbound}`,
    `dialogExpiry:        ${xs.dialogExpiry}s`,
  ]
  return {
    content: `${t('commands.config.title')}\n${lines.join('\n')}\n\n${t('commands.config.edit')}`,
  }
}

// ═══════════════════════════════════════════════════════════════
// Tools & Skills
// ═══════════════════════════════════════════════════════════════

const toolsCmd: CommandHandler = (ctx) => {
  const t = resolveT(ctx)
  const tools = ctx.engine.getTools()
  const categories: Record<string, string[]> = {
    file: [],
    exec: [],
    agent: [],
    network: [],
    system: [],
  }
  for (const [name, tool] of tools) {
    categories[tool.category]?.push(
      `  ${name.padEnd(14)} ${tool.permission.padEnd(8)} ${tool.description}`,
    )
  }
  const sections = Object.entries(categories)
    .filter(([, v]) => v!.length > 0)
    .map(([cat, items]) => `── ${cat.toUpperCase()} ──\n${items!.join('\n')}`)

  return {
    content: `${t('commands.tools.title', { count: String(tools.size) })}\n\n${sections.join('\n\n')}`,
  }
}

const skillsCmd: CommandHandler = (ctx) => {
  const t = resolveT(ctx)
  if (!ctx.skillsLoader) {
    return { content: t('commands.skills.unavailable') }
  }
  const counts = ctx.skillsLoader.countByType()
  const standard = ctx.skillsLoader.listByType('standard')
  const mipham = ctx.skillsLoader.listByType('mipham')

  const lines: string[] = [
    `── Standard Skills (${counts.standard}) ──`,
    ...standard.map((s) => `  ${s.name.padEnd(28)} ${s.description}`),
    '',
    `── Mipham Exclusive (${counts.mipham}) ──`,
    ...mipham.map((s) => `  ${s.name.padEnd(20)} ${s.description}`),
    '',
    t('commands.skills.loaded', { count: String(counts.total) }),
  ]
  return { content: lines.join('\n') }
}

// ═══════════════════════════════════════════════════════════════
// CRSI (Conversational Rule Self-Improvement)
// ═══════════════════════════════════════════════════════════════

const crsiRulesCmd: CommandHandler = (ctx) => {
  const engine = ctx.engine.getRuleEngine()
  if (!engine) {
    return { content: 'CRSI rule engine is not available.' }
  }
  const rules = engine.getActiveRules()
  if (rules.length === 0) {
    return { content: 'No active CRSI rules.' }
  }
  const lines: string[] = ['## Active CRSI Rules', '']
  for (const r of rules) {
    const status = r.enabled ? '✅' : '⛔'
    lines.push(`- \`${r.id}\` [${r.category}] ${r.toolName} — ${r.source} ${status}`)
  }
  lines.push('', `Total: ${rules.length} active rules`)
  lines.push('', 'Use `/crsi disable <rule-id>` to disable a rule.')
  return { content: lines.join('\n') }
}

const crsiDisableCmd: CommandHandler = (ctx, args) => {
  const engine = ctx.engine.getRuleEngine()
  if (!engine) {
    return { content: 'CRSI rule engine is not available.' }
  }
  const ruleId = args[0]?.trim()
  if (!ruleId) {
    return { content: 'Usage: /crsi disable <rule-id>' }
  }
  engine.setRuleEnabled(ruleId, false)
  return {
    content: `Rule \`${ruleId}\` has been disabled. Use \`/crsi restore ${ruleId}\` to re-enable.`,
  }
}

const crsiAnalyzeCmd: CommandHandler = async (ctx) => {
  const analyzer = ctx.engine.getPatternAnalyzer()
  const engine = ctx.engine.getRuleEngine()
  if (!engine) {
    return { content: 'CRSI system is not available.' }
  }

  const patterns = analyzer.analyzeAllAgents()
  if (patterns.length === 0) {
    return { content: 'No failure patterns found across agents.' }
  }

  let registered = 0
  for (const pattern of patterns) {
    const toolRule = analyzer.toToolRule(pattern)
    engine.register(toolRule)
    registered++
  }

  const lines: string[] = [
    '## CRSI Analysis Complete',
    '',
    `Found ${patterns.length} patterns, ${registered} rules registered.`,
    '',
  ]
  for (const p of patterns) {
    lines.push(
      `- [${p.category}] \`${p.agentName}\` — ${p.frequency} failures (${p.confidence} confidence)`,
    )
  }
  return { content: lines.join('\n') }
}

const crsiRestoreCmd: CommandHandler = (ctx, args) => {
  const engine = ctx.engine.getRuleEngine()
  if (!engine) {
    return { content: 'CRSI rule engine is not available.' }
  }
  const ruleId = args.join(' ').trim()
  if (!ruleId) {
    return { content: 'Usage: /crsi restore <rule-id>' }
  }
  engine.setRuleEnabled(ruleId, true)
  return { content: `Rule \`${ruleId}\` has been re-enabled.` }
}

/** Render a tiny ASCII sparkline from a series of 0-1 values (success rates). */
function crsiSparkline(values: number[]): string {
  if (values.length === 0) return '—'
  const chars = '▁▂▃▄▅▆▇█'
  return values.map((v) => chars[Math.min(Math.max(Math.round(v * 7), 0), 7)] ?? '▁').join('')
}

const crsiStatsCmd: CommandHandler = async (ctx) => {
  const engine = ctx.engine.getRuleEngine()
  const tracker = ctx.engine.getEffectivenessTracker()
  if (!engine) {
    return { content: 'CRSI rule engine is not available.' }
  }

  const rules = engine.getActiveRules()
  const lines: string[] = ['## CRSI Statistics', '']
  lines.push(`Total active rules: ${rules.length}`)
  lines.push(`Builtin: ${rules.filter((r) => r.source === 'builtin').length}`)
  lines.push(`Auto-generated: ${rules.filter((r) => r.source === 'pattern-analyzer').length}`)
  lines.push(`Manual: ${rules.filter((r) => r.source === 'manual').length}`)

  const effs = tracker?.allRules ?? []
  if (effs.length > 0) {
    let totalInterceptions = 0
    let totalSuccesses = 0
    for (const eff of effs) {
      totalInterceptions += eff.appliedCount
      totalSuccesses += eff.successAfterCount
    }
    lines.push('')
    lines.push(`Total interceptions: ${totalInterceptions}`)
    lines.push(
      `Success rate after rules: ${totalInterceptions > 0 ? Math.round((totalSuccesses / totalInterceptions) * 100) : 0}%`,
    )

    lines.push('')
    lines.push('### Rule effectiveness')
    lines.push('| Rule | Status | Applied | Success | Trend |')
    lines.push('|------|--------|---------|---------|-------|')
    const statusIcon: Record<string, string> = { active: '🟢', degrading: '🟡', disabled: '⚫' }
    for (const eff of effs) {
      const icon = statusIcon[eff.status] ?? '⚪'
      const rate =
        eff.appliedCount > 0 ? Math.round((eff.successAfterCount / eff.appliedCount) * 100) : 0
      const trend = crsiSparkline(eff.evaluationHistory.map((h) => 1 - h.failureRate))
      lines.push(
        `| ${eff.ruleId} | ${icon} ${eff.status} | ${eff.appliedCount} | ${rate}% | ${trend} |`,
      )
    }

    const disabled = effs.filter((e) => e.status === 'disabled')
    if (disabled.length > 0) {
      lines.push('')
      lines.push('### Disabled rules (retired)')
      for (const d of disabled) {
        lines.push(`- ${d.ruleId} (failure rate ${Math.round(d.postRuleFailureRate * 100)}%)`)
      }
    }
  }

  return { content: lines.join('\n') }
}

const crsiInventoryCmd: CommandHandler = async (ctx) => {
  return { content: buildCapabilityReport(ctx.engine) }
}

const crsiModifyCmd: CommandHandler = async (ctx, args) => {
  if (args[0] === '--approve') {
    if (shouldBlockApproval(getPendingVerdict() ?? 'inconclusive')) {
      return { content: '❌ 任务表现倒退，禁止固化。请 /crsi modify --reject 丢弃，或改进后再试。' }
    }
    const r = approvePending()
    setPendingVerdict(null)
    return { content: r.success ? `✅ ${r.message}` : `⚠️ ${r.message}` }
  }
  if (args[0] === '--reject') {
    const r = rejectPending()
    setPendingVerdict(null)
    return { content: r.success ? `✅ ${r.message}` : `⚠️ ${r.message}` }
  }
  if (args.length < 3) {
    return {
      content:
        'Usage: /crsi modify <description> <filePath> <newContent>\n' +
        '- description 单 token（不含空格）\n' +
        '- newContent 用 \\n 表示换行\n' +
        '测试通过后：/crsi modify --approve 合并，/crsi modify --reject 丢弃',
    }
  }
  if (hasPending()) {
    return { content: '⚠️ 已有待批准的修改。先 /crsi modify --approve 或 --reject。' }
  }

  const description = args[0]!
  const filePath = args[1]!
  const newContent = args.slice(2).join(' ').replace(/\\n/g, '\n')

  let originalContent = ''
  try {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    originalContent = readFileSync(join(process.cwd(), filePath), 'utf-8')
  } catch {
    // 文件不存在 → 宽松模式（originalContent 为空）
  }

  const result = await runCrsiModification({
    description,
    filePath,
    newContent,
    originalContent,
    blastRadius: [filePath],
  })
  if (!result.applied || result.phase === 'failed') {
    return {
      content: `❌ 修改未通过（phase: ${result.phase}）。\n${result.error ?? ''}`,
    }
  }

  // 测量在 runCrsiModification 成功后进行（避免 failed proposal 白跑 6 次 LLM 调用）。
  const llm = ctx.engine.getLlm() ?? ctx.engine.getRegistry()
  let improvementLine = ''
  try {
    const sample = await measureSkillDeltaRepeated(llm, { filePath, originalContent, newContent })
    if (sample) {
      const report = buildImprovementReport(sample, [filePath])
      setPendingVerdict(report.verdict)
      appendImprovement({ ...report, id: randomUUID(), timestamp: new Date().toISOString() })
      const rate = improvementRate(readImprovements())
      const label =
        report.verdict === 'improved'
          ? 'improved ✅'
          : report.verdict === 'regressed'
            ? 'regressed ⚠️'
            : 'inconclusive'
      const sign = report.deltaMean >= 0 ? '+' : ''
      improvementLine =
        `\n📊 改进判定: ${label} (delta ${sign}${report.deltaMean.toFixed(1)}, 噪声 ${report.noise.toFixed(1)}, 阈值 ${report.minEffect.toFixed(1)})` +
        `\n   改进率: ${rate.improved}/${rate.total} (${(rate.rate * 100).toFixed(0)}%, Wilson 95% [${(rate.lo * 100).toFixed(0)}%, ${(rate.hi * 100).toFixed(0)}%])` +
        (report.verdict === 'regressed' ? '\n   ⚠️ 任务表现倒退：--approve 将被拒绝。' : '')
    }
  } catch {
    // 测量失败（LLM 不可用等）不阻断 modify 流程——改进信号是可选的。
  }

  return {
    content:
      `✅ 测试通过。审阅下方 diff：\n\n${result.diff}\n` +
      improvementLine +
      '\n/crsi modify --approve  合并\n/crsi modify --reject   丢弃',
  }
}

const crsiProposeCmd: CommandHandler = async (ctx, args) => {
  if (hasPending()) {
    return { content: '⚠️ 已有待批准的修改。先 /crsi modify --approve 或 --reject。' }
  }

  const insights = ctx.engine.getAutoMemory?.()?.accumulatedInsights ?? []
  let metaRules: Parameters<typeof produceCrsiProposal>[1] = []
  try {
    metaRules = ctx.engine.getMetaRuleEngine?.()?.analyze().metaRules ?? []
  } catch {
    metaRules = []
  }

  // 目标文件按仓库根解析（沙箱的 filePath 是仓库根相对）。
  let root = process.cwd()
  try {
    root = execSync('git rev-parse --show-toplevel', {
      timeout: 5000,
      encoding: 'utf-8',
    }).trim()
  } catch {
    // 非 git 目录 → 回退 cwd
  }

  // ── 散文提议路径：/crsi propose --prose 用 LLM 生成改 skill 散文提议 ──
  if (args[0] === '--prose') {
    const skillFiles = collectSkillFiles(root)
    if (skillFiles.length === 0) {
      return { content: '没有可改的 skill 文件。' }
    }

    const signal = selectCrsiSignal(insights, metaRules)
    if (!signal) {
      return { content: '没有足够的失败信号来生成散文提议。' }
    }

    const id = proseProposalId(signal)
    if (hasProposedProse(id)) {
      return { content: '该失败信号已生成过散文提议（幂等去重，跳过）。' }
    }

    const llm = ctx.engine.getLlm() ?? ctx.engine.getRegistry()
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const proposal = await produceProseProposal(signal, llm, skillFiles, (p) =>
      readFileSync(join(root, p), 'utf-8'),
    )
    if (!proposal) {
      return { content: '散文提议生成失败（LLM 未返回有效结果）。' }
    }

    const verdict = prefilterProposal({
      id,
      filePath: proposal.filePath,
      kind: 'skill',
      newContent: proposal.newContent,
    })
    if (!verdict.pass) {
      return { content: `❌ 提议未通过预筛：${verdict.reasons.join('; ')}` }
    }

    const result = await runCrsiModification({
      description: proposal.description,
      filePath: proposal.filePath,
      newContent: proposal.newContent,
      originalContent: proposal.originalContent,
      blastRadius: [proposal.filePath],
    })
    if (!result.applied || result.phase === 'failed') {
      return { content: `❌ 生成失败（phase: ${result.phase}）。\n${result.error ?? ''}` }
    }

    appendProseProposal({ id, filePath: proposal.filePath, timestamp: new Date().toISOString() })

    return {
      content:
        `✅ 已生成散文提议并跑过测试。审阅 diff：\n\n${result.diff}\n\n` +
        '/crsi modify --approve 合并 | /crsi modify --reject 丢弃',
    }
  }

  // ── 毕业路径：/crsi propose --rule 固化受管理规则（行为） ──
  if (args[0] === '--rule') {
    const signal = selectCrsiSignal(insights, metaRules)
    if (!signal) {
      return { content: '没有足够的失败信号（autoApplicable insight 或高置信元规则）来固化规则。' }
    }

    let current = ''
    try {
      const { readFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      current = readFileSync(join(root, MANAGED_RULES_FILE), 'utf-8')
    } catch {
      current = ''
    }

    const proposal = produceRuleProposal(signal, current)
    if (!proposal) {
      return {
        content: '没有可固化的规则（category 需为 timeout/tool-params，且同名规则不存在）。',
      }
    }

    const result = await runCrsiModification(proposal)
    if (!result.applied || result.phase === 'failed') {
      return { content: `❌ 固化失败（phase: ${result.phase}）。\n${result.error ?? ''}` }
    }

    return {
      content:
        `✅ 已生成受管理规则并跑过测试。审阅 diff：\n\n${result.diff}\n\n` +
        '/crsi modify --approve 合并 | /crsi modify --reject 丢弃',
    }
  }

  // ── Crossover 路径：/crsi propose --crossover 合并两条重叠教训 ──
  if (args[0] === '--crossover') {
    const llm = ctx.engine.getLlm() ?? ctx.engine.getRegistry()
    let current = ''
    try {
      const { readFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      current = readFileSync(join(root, LESSONS_FILE), 'utf-8')
    } catch {
      current = ''
    }
    if (!current) {
      return { content: '教训文件为空，无可合并。' }
    }

    const proposal = await produceCrossoverProposal(llm, current, new Date().toISOString())
    if (!proposal) {
      return { content: '没有找到可合并的重叠教训对。' }
    }

    const result = await runCrsiModification(proposal)
    if (!result.applied || result.phase === 'failed') {
      return { content: `❌ 合并失败（phase: ${result.phase}）。\n${result.error ?? ''}` }
    }

    return {
      content:
        `✅ 已生成合并教训并跑过测试。审阅 diff：\n\n${result.diff}\n\n` +
        '/crsi modify --approve 合并 | /crsi modify --reject 丢弃',
    }
  }

  // ── 教训路径（默认）：/crsi propose 追加教训 ──
  let current = ''
  try {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    current = readFileSync(join(root, LESSONS_FILE), 'utf-8')
  } catch {
    current = ''
  }

  const proposal = produceCrsiProposal(insights, metaRules, current, new Date().toISOString())

  if (!proposal) {
    return { content: '没有足够的失败信号（autoApplicable insight 或高置信元规则）来生成教训。' }
  }

  const result = await runCrsiModification(proposal)
  if (!result.applied || result.phase === 'failed') {
    return { content: `❌ 生成失败（phase: ${result.phase}）。\n${result.error ?? ''}` }
  }

  return {
    content:
      `✅ 已生成教训并跑过测试。审阅 diff：\n\n${result.diff}\n\n` +
      '/crsi modify --approve 合并 | /crsi modify --reject 丢弃',
  }
}

const crsiEvalCmd: CommandHandler = async (ctx, args) => {
  const rewardIdx = args.indexOf('--reward')
  const rewardName = rewardIdx >= 0 ? args[rewardIdx + 1] : undefined

  if (rewardName) {
    const llm = ctx.engine.getLlm() ?? ctx.engine.getRegistry()
    const fns = listRewardFns(llm)
    const fn = fns.find((f) => f.name === rewardName)
    if (!fn) {
      return {
        content: `❌ 未知 reward: ${rewardName}。可用: ${fns.map((f) => f.name).join(', ')}`,
      }
    }
    const report = await fn.evaluate()
    appendEvalScore(fn.name, report)
    return {
      content: `得分 **${report.score}/100** (${report.passed}/${report.total})\n失败: ${report.failures.join(', ') || '无'}`,
    }
  }

  const report = runEval()
  appendEvalScore('mechanism-sentinel', report)

  const lines: string[] = ['## 🧪 CRSI Eval Harness', '']
  lines.push(`得分: **${report.score}/100** (${report.passed}/${report.total})`, '')
  lines.push('| 任务 | 结果 |')
  lines.push('|------|------|')
  for (const r of report.results) {
    lines.push(
      `| ${r.description} | ${r.passed ? '✅' : '❌'}${r.detail ? ` — ${r.detail}` : ''} |`,
    )
  }
  if (report.failures.length > 0) {
    lines.push('', `❌ 失败任务: ${report.failures.join(', ')}`)
  }

  // 奖励函数注册表（reward function = policy→feedback 抽象可见）
  // 传 llm 列出完整注册表（task-performance 需 llm 才能跑，但构造它零 LLM 调用）。
  const llm = ctx.engine.getLlm() ?? ctx.engine.getRegistry()
  const fns = listRewardFns(llm)
  lines.push('', '## 🎁 奖励函数注册表', '')
  for (const f of fns) {
    lines.push(`- **${f.name}** — ${f.description}`)
  }
  lines.push('', '`/crsi eval --reward <name>` 跑指定奖励函数')

  return { content: lines.join('\n') }
}

const crsiBenchCmd: CommandHandler = async (ctx, args) => {
  const llm = ctx.engine.getLlm() ?? ctx.engine.getRegistry()

  const skillIdx = args.indexOf('--skill')
  const skillName = skillIdx >= 0 ? args[skillIdx + 1] : undefined
  let skill: { name: string; text: string } | undefined
  if (skillName) {
    const body = ctx.skillsLoader?.get(skillName)?.body
    if (!body) {
      return { content: `❌ 未找到 skill: ${skillName}` }
    }
    skill = { name: skillName, text: body }
  }

  const report = await runTaskPerformance(llm, skill ? { skill } : undefined)

  const lines: string[] = [
    '## 🎯 CRSI 任务表现基准' + (skill ? `（skill: ${skill.name}）` : ''),
    '',
  ]
  lines.push(`得分: **${report.score}/100** (${report.passed}/${report.total})`, '')
  lines.push('| 任务 | 结果 |')
  lines.push('|------|------|')
  for (const r of report.results) {
    lines.push(
      `| ${r.description.slice(0, 60)} | ${r.passed ? '✅' : '❌'}${r.detail ? ` — ${r.detail.slice(0, 80)}` : ''} |`,
    )
  }
  if (report.failures.length > 0) {
    lines.push('', `❌ 失败任务: ${report.failures.join(', ')}`)
  }
  return { content: lines.join('\n') }
}

const crsiProseClearCmd: CommandHandler = () => {
  const count = clearProseProposals()
  if (count === 0) {
    return { content: '散文提议 ledger 为空（无可清除记录）。' }
  }
  return { content: `已清空散文提议 ledger（移除 ${count} 条记录）。` }
}

const crsiHealthCmd: CommandHandler = async (ctx) => {
  const engine = ctx.engine.getRuleEngine()
  const tracker = ctx.engine.getEffectivenessTracker()
  const db = ctx.engine.getErrorSignatureDB?.()
  const patternAnalyzer = ctx.engine.getPatternAnalyzer?.()

  const lines: string[] = ['## 🏥 CRSI 系统健康仪表盘', '']

  // ── CRSI Section ──
  lines.push('### 🧠 CRSI 学习子系统', '')
  if (engine) {
    const rules = engine.getActiveRules()
    const builtin = rules.filter((r) => r.source === 'builtin').length
    const auto = rules.filter((r) => r.source === 'pattern-analyzer').length
    const manual = rules.filter((r) => r.source === 'manual').length

    lines.push(`| 指标 | 值 |`)
    lines.push(`|------|----|`)
    lines.push(`| 活跃规则 | ${rules.length} (内置 ${builtin} · 自动 ${auto} · 手动 ${manual}) |`)

    if (tracker) {
      let interceptions = 0
      let successes = 0
      for (const r of rules) {
        const eff = tracker.getEffectiveness(r.id)
        if (eff) {
          interceptions += eff.appliedCount
          successes += eff.successAfterCount
        }
      }
      const crsiRate = interceptions > 0 ? Math.round((successes / interceptions) * 100) : 100
      lines.push(`| 总拦截次数 | ${interceptions} |`)
      lines.push(`| 拦截成功率 | ${crsiRate}% |`)
    }

    // Pattern analysis depth
    if (patternAnalyzer) {
      const patterns = patternAnalyzer.analyzeAllAgents()
      lines.push(`| 已检测模式 | ${patterns.length} |`)
    }

    lines.push('')
    lines.push('CRSI 命令: `/crsi rules` `/crsi stats` `/crsi analyze`')
  } else {
    lines.push('CRSI 规则引擎未初始化')
  }

  // ── SIS Section ──
  lines.push('', '### 🛡️ SIS 自免疫子系统', '')
  if (db) {
    const stats = db.getStats()

    lines.push(`| 指标 | 值 |`)
    lines.push(`|------|----|`)
    lines.push(
      `| 免疫记忆 | ${stats.total} 条 (🟢${stats.active} · 🟡${stats.degraded} · ⚫${stats.retired}) |`,
    )
    lines.push(`| 平均成功率 | ${Math.round(stats.avgSuccessRate * 100)}% |`)
    lines.push(`| 总拦截 | ${stats.totalInterceptions} 次 |`)

    lines.push('')
    lines.push('SIS 命令: `/sis errors` `/sis stats` `/sis clear <id>`')
  } else {
    lines.push('SIS 自免疫系统未初始化')
  }

  // ── Overall Health Score ──
  lines.push('', '### 📊 综合健康评分', '')
  const crsiScore = engine ? 50 : 0
  const sisScore = db ? (db.getStats().avgSuccessRate >= 0.8 ? 50 : 25) : 0
  const totalScore = crsiScore + sisScore

  const grade =
    totalScore >= 80
      ? '🟢 A — 优秀'
      : totalScore >= 50
        ? '🟡 B — 良好'
        : totalScore >= 25
          ? '🟠 C — 需关注'
          : '🔴 D — 待初始化'

  lines.push(`| 子系统 | 状态 | 得分 |`)
  lines.push(`|--------|------|------|`)
  lines.push(`| CRSI 学习 | ${engine ? '✅ 在线' : '❌ 离线'} | ${crsiScore}/50 |`)
  lines.push(`| SIS 免疫 | ${db ? '✅ 在线' : '❌ 离线'} | ${sisScore}/50 |`)
  lines.push(`| **综合** | **${grade}** | **${totalScore}/100** |`)

  return { content: lines.join('\n') }
}

const crsiMetaCmd: CommandHandler = async (ctx) => {
  const metaEngine = ctx.engine.getMetaRuleEngine?.()
  if (!metaEngine) {
    return { content: 'MetaRuleEngine 未初始化。请先运行 `/crsi health` 初始化 CRSI 系统。' }
  }

  const result = metaEngine.analyze()
  const lines: string[] = ['## 🔮 CRSI 元规则分析 (RSI Level 3)', '']

  // ── System Health ──
  lines.push('### 📊 系统健康评分', '')
  const h = result.systemHealth
  lines.push(`| 组件 | 得分 |`)
  lines.push(`|------|------|`)
  lines.push(`| 错误签名 | ${h.components.errorSignatures}/100 |`)
  lines.push(`| 预防拦截 | ${h.components.preflightPrevention}/100 |`)
  lines.push(`| 自动修复 | ${h.components.autoCorrection}/100 |`)
  lines.push(`| 免疫记忆 | ${h.components.immuneMemory}/100 |`)
  lines.push(`| 规则有效性 | ${h.components.ruleEffectiveness}/100 |`)
  lines.push(`| **综合** | **${h.score}/100** |`)
  lines.push('')
  lines.push(h.assessment)
  lines.push('')

  // ── Recommendations ──
  lines.push('### 💡 优化建议', '')
  for (const rec of h.recommendations) {
    lines.push(`- ${rec}`)
  }
  lines.push('')

  // ── Meta-Rules ──
  if (result.metaRules.length > 0) {
    lines.push(`### 🧬 发现 ${result.metaRules.length} 条元规则`, '')

    for (const mr of result.metaRules) {
      const confIcon = mr.confidence === 'high' ? '🔴' : mr.confidence === 'medium' ? '🟡' : '🟢'
      const autoLabel = mr.autoApplicable ? ' [可自动应用]' : ''
      lines.push(`#### ${confIcon} ${mr.title}${autoLabel}`)
      lines.push('')
      lines.push(mr.description)
      lines.push('')
      lines.push(`> **建议**: ${mr.recommendation}`)
      lines.push('')
      lines.push(
        `置信度: ${mr.confidence} | 样本量: ${mr.evidence.sampleSize} | 生成时间: ${mr.generatedAt}`,
      )
      lines.push('')
    }
  } else {
    lines.push('### 🧬 元规则', '')
    lines.push(
      '暂无元规则生成。当系统积累足够的错误签名和规则数据后，元规则引擎将自动发现跨规则模式。',
    )
    lines.push('')
  }

  // ── Auto-applicable summary ──
  const autoApplicable = metaEngine.getAutoApplicable(result.metaRules)
  if (autoApplicable.length > 0) {
    lines.push('### ⚡ 可自动应用', '')
    lines.push(`${autoApplicable.length} 条元规则可安全自动应用：`)
    for (const mr of autoApplicable) {
      lines.push(`- \`${mr.id}\`: ${mr.recommendation}`)
    }
    lines.push('')
    lines.push('使用 `/crsi meta --apply` 自动应用高置信度元规则。')
  }

  return { content: lines.join('\n') }
}

// ═══════════════════════════════════════════════════════════════
// SIS (Self-Immune System)
// ═══════════════════════════════════════════════════════════════

const sisErrorsCmd: CommandHandler = (ctx) => {
  const db = ctx.engine.getErrorSignatureDB?.()
  if (!db) {
    return { content: 'SIS 自免疫系统未初始化。' }
  }
  const sigs = db.getActive()
  if (sigs.length === 0) {
    return { content: '🛡️ SIS 免疫记忆为空 — 尚未记录任何错误签名。' }
  }
  const lines: string[] = ['## 🛡️ SIS 免疫记忆', '']
  for (const sig of sigs) {
    const statusIcon = sig.status === 'active' ? '🟢' : '🟡'
    lines.push(`- ${statusIcon} \`${sig.id}\` [${sig.category}] ${sig.toolName}`)
    lines.push(`  模式: \`${sig.pattern.slice(0, 80)}${sig.pattern.length > 80 ? '...' : ''}\``)
    lines.push(
      `  修复: ${sig.fixStrategy} → ${sig.fixAction.slice(0, 60)} | 发生 ${sig.occurrences} 次 | 成功率 ${Math.round(sig.successRate * 100)}%`,
    )
    lines.push('')
  }
  lines.push(`共 ${sigs.length} 条活跃免疫记忆`)
  lines.push('', '使用 `/sis stats` 查看汇总统计，`/sis clear <id>` 清除指定签名')
  return { content: lines.join('\n') }
}

const sisStatsCmd: CommandHandler = (ctx) => {
  const db = ctx.engine.getErrorSignatureDB?.()
  if (!db) {
    return { content: 'SIS 自免疫系统未初始化。' }
  }
  const stats = db.getStats()
  const lines: string[] = ['## 🛡️ SIS 自免疫统计', '']
  lines.push(`总签名数: ${stats.total}`)
  lines.push(
    `🟢 活跃: ${stats.active}  |  🟡 降级: ${stats.degraded}  |  ⚫ 已退役: ${stats.retired}`,
  )
  lines.push(`平均成功率: ${Math.round(stats.avgSuccessRate * 100)}%`)
  lines.push(`总拦截次数: ${stats.totalInterceptions}`)

  const active = db.getActive()
  if (active.length > 0) {
    lines.push('')
    lines.push('### 签名明细（按拦截次数排序）')
    lines.push('| 签名 | 状态 | 拦截 | 成功率 |')
    lines.push('|------|------|------|--------|')
    for (const s of active) {
      const icon = s.status === 'active' ? '🟢' : '🟡'
      lines.push(
        `| ${s.id} | ${icon} ${s.status} | ${s.occurrences} | ${Math.round(s.successRate * 100)}% |`,
      )
    }
  }

  return { content: lines.join('\n') }
}

const sisClearCmd: CommandHandler = (ctx, args) => {
  const db = ctx.engine.getErrorSignatureDB?.()
  if (!db) {
    return { content: 'SIS 自免疫系统未初始化。' }
  }
  const sigId = args[0]?.trim()
  if (!sigId) {
    return { content: 'Usage: /sis clear <signature-id>\n\n使用 `/sis errors` 查看所有签名 ID。' }
  }
  const sig = db.get(sigId)
  if (!sig) {
    return { content: `签名 \`${sigId}\` 未找到。` }
  }
  db.retire(sigId)
  return { content: `已退役签名 \`${sigId}\` (${sig.pattern.slice(0, 50)}...)` }
}

const sisCleanupCmd: CommandHandler = async (ctx) => {
  const db = ctx.engine.getErrorSignatureDB?.()
  if (!db) {
    return { content: 'SIS 自免疫系统未初始化。' }
  }
  // Use dynamic import for ESM compatibility
  const { ImmuneMemoryGC } = await import('../../src/core/immune-memory-gc.js')
  const gc = new ImmuneMemoryGC(db)
  const report = gc.collect()
  const lines: string[] = ['## 🧹 SIS 免疫记忆清理完成', '']
  lines.push(`清理前: ${report.before} 条签名`)
  lines.push(`清理后: ${report.after} 条签名`)
  lines.push('')
  if (report.retiredRemoved > 0) lines.push(`🗑️  移除过期退役: ${report.retiredRemoved} 条`)
  if (report.zeroSuccessRetired > 0) lines.push(`⚠️  退役零成功率: ${report.zeroSuccessRetired} 条`)
  if (report.duplicatesMerged > 0) lines.push(`🔗 合并重复签名: ${report.duplicatesMerged} 条`)
  if (
    report.retiredRemoved === 0 &&
    report.zeroSuccessRetired === 0 &&
    report.duplicatesMerged === 0
  ) {
    lines.push('✅ 免疫记忆干净，无需清理')
  }
  return { content: lines.join('\n') }
}

// ═══════════════════════════════════════════════════════════════
// CRSI Critique — Self-Critique Hook (RLAIF)
// ═══════════════════════════════════════════════════════════════

const crsiCritiqueCmd: CommandHandler = (ctx, args) => {
  const t = resolveT(ctx)
  const engine = ctx.engine
  const sc = engine.getSelfCritique?.()
  if (!sc) {
    return { content: t('commands.crsi_critique.not_init') }
  }

  const sub = args[0]?.toLowerCase()
  const config = sc.getConfig()

  if (sub === 'on' || sub === 'enable') {
    sc.setEnabled(true)
    return {
      content: [
        t('commands.crsi_critique.on_title'),
        '',
        t('commands.crsi_critique.model', { model: config.model || 'auto (fastest available)' }),
        t('commands.crsi_critique.threshold', { pct: (config.threshold * 100).toFixed(0) }),
        t('commands.crsi_critique.target_tools', { tools: config.targetTools.join(', ') }),
        '',
        t('commands.crsi_critique.on_desc1'),
        t('commands.crsi_critique.on_desc2'),
        '',
        t('commands.crsi_critique.on_hint'),
      ].join('\n'),
    }
  }

  if (sub === 'off' || sub === 'disable') {
    sc.setEnabled(false)
    return { content: t('commands.crsi_critique.off_title') }
  }

  // status (default)
  const lines: string[] = [
    t('commands.crsi_critique.status_title'),
    '',
    t('commands.crsi_critique.state', {
      state: config.enabled ? '🟢 Enabled' : '⚫ Disabled',
    }),
    t('commands.crsi_critique.model', { model: config.model || 'auto (fastest available)' }),
    t('commands.crsi_critique.threshold_detail', { pct: (config.threshold * 100).toFixed(0) }),
    t('commands.crsi_critique.target_tools', {
      tools: config.targetTools.length > 0 ? config.targetTools.join(', ') : 'all',
    }),
    t('commands.crsi_critique.timeout', { ms: String(config.timeoutMs) }),
    '',
    '──',
    t('commands.crsi_critique.status_on_hint'),
    t('commands.crsi_critique.status_off_hint'),
    '',
    t('commands.crsi_critique.inspired'),
  ]

  return { content: lines.join('\n') }
}

// ═══════════════════════════════════════════════════════════════
// CRSI Interpret — Tool-Call Behavior Dashboard
// ═══════════════════════════════════════════════════════════════

const crsiInterpretCmd: CommandHandler = (ctx, args) => {
  const t = resolveT(ctx)
  const engine = ctx.engine
  const toolFilter = args[0]?.toLowerCase()

  const lines: string[] = [t('commands.crsi_interpret.title'), '']

  // ── Error Signature Analysis ──
  const db = engine.getErrorSignatureDB?.()
  if (db) {
    const sigs = toolFilter
      ? db.getActive().filter((s) => s.toolName.toLowerCase() === toolFilter)
      : db.getActive()

    if (sigs.length === 0) {
      lines.push(
        toolFilter
          ? t('commands.crsi_interpret.no_sigs_for_tool', { tool: toolFilter })
          : t('commands.crsi_interpret.no_sigs'),
      )
    } else {
      lines.push(
        t('commands.crsi_interpret.sigs_title', {
          tool: toolFilter ? ` — \`${toolFilter}\`` : '',
        }),
        '',
      )
      for (const sig of sigs.slice(0, 15)) {
        const bar =
          '█'.repeat(Math.round(sig.successRate * 10)) +
          '░'.repeat(10 - Math.round(sig.successRate * 10))
        lines.push(`- **${sig.toolName}**: \`${sig.pattern.slice(0, 60)}\``)
        lines.push(
          t('commands.crsi_interpret.sig_success', {
            bar,
            pct: String(Math.round(sig.successRate * 100)),
            occurrences: String(sig.occurrences),
            strategy: sig.fixStrategy,
          }),
        )
        lines.push(t('commands.crsi_interpret.sig_fix', { fix: sig.fixAction.slice(0, 80) }))
        lines.push('')
      }
      if (sigs.length > 15)
        lines.push(t('commands.crsi_interpret.sigs_more', { count: String(sigs.length - 15) }), '')
    }
  }

  // ── CRSI Reflection Summary ──
  const autoMemory = engine.getAutoMemory?.()
  if (autoMemory) {
    const count = autoMemory.sessionReflectionCount ?? 0
    if (count > 0) {
      lines.push(t('commands.crsi_interpret.reflection_title'), '')
      lines.push(t('commands.crsi_interpret.reflections', { count: String(count) }))
      lines.push('')
    }
  }

  // ── Usage Tracker by Tool ──
  const usage = engine.getUsageTracker?.()
  if (usage) {
    const summary = usage.getSummary()
    lines.push(t('commands.crsi_interpret.usage_title'), '')
    lines.push(
      t('commands.crsi_interpret.api_in', { count: summary.apiInputTokens.toLocaleString() }),
    )
    lines.push(
      t('commands.crsi_interpret.api_out', { count: summary.apiOutputTokens.toLocaleString() }),
    )
    lines.push(
      t('commands.crsi_interpret.est_tokens', { count: summary.estimatedTokens.toLocaleString() }),
    )
    lines.push('')
  }

  // ── System Health ──
  const meta = engine.getMetaRuleEngine?.()
  if (meta) {
    try {
      const analysis = meta.analyze()
      if (analysis.systemHealth) {
        const h = analysis.systemHealth
        const bar = '█'.repeat(Math.round(h.score / 10)) + '░'.repeat(10 - Math.round(h.score / 10))
        lines.push(t('commands.crsi_interpret.health_title'), '')
        lines.push(t('commands.crsi_interpret.overall', { bar, score: String(h.score) }))
        lines.push(t('commands.crsi_interpret.assessment', { assessment: h.assessment }))
        if (h.components) {
          lines.push('')
          for (const [comp, score] of Object.entries(h.components)) {
            const cbar =
              '▮'.repeat(Math.round((score as number) / 10)) +
              '▯'.repeat(10 - Math.round((score as number) / 10))
            lines.push(`  ${comp.padEnd(20)} ${cbar} ${score}/100`)
          }
        }
        lines.push('')
      }
    } catch {
      // Meta analysis unavailable
    }
  }

  // ── Constitution Health ──
  const constitution = engine.getConstitutionLoader?.()
  if (constitution) {
    const c = constitution.load()
    const blocks = c.principles.filter((p) => p.enforce === 'block').length
    const warns = c.principles.filter((p) => p.enforce === 'warn').length
    const autos = c.principles.filter((p) => p.enforce === 'auto').length
    lines.push(t('commands.crsi_interpret.constitution_title'), '')
    lines.push(
      t('commands.crsi_interpret.principles', {
        total: String(c.principles.length),
        block: String(blocks),
        warn: String(warns),
        auto: String(autos),
      }),
    )
    lines.push(t('commands.crsi_interpret.version', { version: c.version }))
    lines.push('')
  }

  if (lines.length <= 2) {
    lines.push(t('commands.crsi_interpret.empty'))
  }

  lines.push('──')
  lines.push(t('commands.crsi_interpret.filter_hint'))

  return { content: lines.join('\n') }
}

// ═══════════════════════════════════════════════════════════════
// CRSI Red-Team — Adversarial Self-Testing
// ═══════════════════════════════════════════════════════════════

const crsiRedTeamCmd: CommandHandler = async (ctx) => {
  const t = resolveT(ctx)
  const engine = ctx.engine

  const constitution = engine.getConstitutionLoader?.()
  const preflight = engine.getPreFlightChecker?.()

  if (!constitution || !preflight) {
    return { content: t('commands.crsi_red_team.not_init') }
  }

  const { RedTeam: RT } = await import('../../src/core/red-team.js')
  const redTeam = new RT()
  const report = redTeam.run(constitution, preflight)

  const lines: string[] = [
    t('commands.crsi_red_team.title'),
    '',
    t('commands.crsi_red_team.score', { score: String(report.score) }),
    '',
    t('commands.crsi_red_team.metric'),
    t('commands.crsi_red_team.metric_sep'),
    t('commands.crsi_red_team.total_attacks', { count: String(report.total) }),
    t('commands.crsi_red_team.blocked', { count: String(report.blocked) }),
    t('commands.crsi_red_team.passed_through', { count: String(report.passedThrough) }),
    t('commands.crsi_red_team.false_positives', { count: String(report.falsePositives) }),
    '',
  ]

  // Per-principle breakdown
  lines.push(t('commands.crsi_red_team.by_principle'), '')
  for (const [pid, stats] of Object.entries(report.byPrinciple)) {
    const pct = stats.total > 0 ? Math.round((stats.blocked / stats.total) * 100) : 100
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10))
    const icon = pct === 100 ? '✅' : pct >= 80 ? '⚠️' : '🔴'
    lines.push(`- ${icon} **${pid}**: ${bar} ${pct}% (${stats.blocked}/${stats.total})`)
  }
  lines.push('')

  // Detail: passed-through attacks
  const gaps = report.results.filter((r) => r.attack.shouldBlock && !r.blocked)
  if (gaps.length > 0) {
    lines.push(t('commands.crsi_red_team.gaps_title'), '')
    for (const g of gaps) {
      lines.push(`- **${g.attack.principleId}**: ${g.attack.description}`)
      lines.push(
        t('commands.crsi_red_team.gap_tool', {
          tool: g.attack.toolName,
          params: JSON.stringify(g.attack.params).slice(0, 80),
        }),
      )
    }
    lines.push('')
  }

  // Detail: caught attacks
  const caught = report.results.filter((r) => r.blocked)
  if (caught.length > 0) {
    lines.push(t('commands.crsi_red_team.blocked_title'), '')
    for (const c of caught) {
      lines.push(
        t('commands.crsi_red_team.caught_by', {
          principle: c.attack.principleId,
          desc: c.attack.description,
          caught: c.caughtBy ?? 'unknown',
        }),
      )
    }
    lines.push('')
  }

  if (report.score === 100) {
    lines.push(t('commands.crsi_red_team.all_blocked'))
  } else if (report.score >= 80) {
    lines.push(t('commands.crsi_red_team.good_coverage'))
  } else {
    lines.push(t('commands.crsi_red_team.critical'))
  }

  return { content: lines.join('\n') }
}

// ═══════════════════════════════════════════════════════════════
// Auto-Dream: Background Memory Consolidation
// ═══════════════════════════════════════════════════════════════

const dreamCmd: CommandHandler = async (ctx, args) => {
  const t = resolveT(ctx)
  const aggressive = args.includes('--aggressive') || args.includes('-a')
  const status = args.includes('--status') || args.includes('-s')

  const engine = ctx.engine.getDreamEngine?.()
  if (!engine) {
    return { content: t('commands.dream.not_init') }
  }

  if (status) {
    const history = engine.getDreamHistory()
    if (history.length === 0) {
      return { content: t('commands.dream.no_history') }
    }
    const lines: string[] = [t('commands.dream.history_title'), '']
    for (const entry of history.slice(0, 5)) {
      const ts = new Date(entry.timestamp).toLocaleString('zh-CN')
      const total = entry.actions.length
      const applied = entry.actions.filter((a) => a.autoApplied).length
      const flagged = entry.actions.filter((a) => !a.autoApplied).length
      lines.push(
        t('commands.dream.history_entry', {
          time: ts,
          total: String(total),
          applied: String(applied),
          flagged: String(flagged),
        }),
      )
    }
    return { content: lines.join('\n') }
  }

  const report = engine.dream({ aggressive })
  const lines: string[] = [
    t('commands.dream.done_title'),
    '',
    t('commands.dream.integrate', {
      before: String(report.beforeCount),
      after: String(report.afterCount),
    }),
    ...(report.phases.deduplicated > 0
      ? [t('commands.dream.dedup', { count: String(report.phases.deduplicated) })]
      : []),
    ...(report.phases.contradictionsFound > 0
      ? [t('commands.dream.contradiction', { count: String(report.phases.contradictionsFound) })]
      : []),
    ...(report.phases.merged > 0
      ? [t('commands.dream.merge', { count: String(report.phases.merged) })]
      : []),
    ...(report.phases.solidified > 0
      ? [t('commands.dream.solidify', { count: String(report.phases.solidified) })]
      : []),
    ...(report.phases.pruned > 0
      ? [t('commands.dream.prune', { count: String(report.phases.pruned) })]
      : []),
    '',
  ]

  const flagged = report.actions.filter((a) => !a.autoApplied)
  if (flagged.length > 0 && !aggressive) {
    lines.push(t('commands.dream.review_hint', { count: String(flagged.length) }))
    lines.push('')
    for (const action of flagged) {
      lines.push(`- [ ] **${action.type}**: ${action.description}`)
    }
  }

  if (report.actions.length === 0) {
    lines.push(t('commands.dream.clean'))
  }

  return { content: lines.join('\n') }
}

// ═══════════════════════════════════════════════════════════════
// Constitution
// ═══════════════════════════════════════════════════════════════

const constitutionCmd: CommandHandler = (ctx, args) => {
  const t = resolveT(ctx)
  const engine = ctx.engine
  const constitution = engine.getConstitutionLoader?.()
  if (!constitution) {
    return { content: t('commands.constitution.not_init') }
  }

  const subCmd = args[0]?.toLowerCase()

  // /constitution reload
  if (subCmd === 'reload') {
    const c = constitution.reload()
    return {
      content: [
        t('commands.constitution.reload_title'),
        '',
        t('commands.constitution.version', { version: c.version }),
        t('commands.constitution.principles', { count: String(c.principles.length) }),
        t('commands.constitution.path', { path: constitution.getPath() }),
        '',
        c.principles.map((p) => `- **${p.id}** [${p.enforce}]: ${p.text}`).join('\n'),
      ].join('\n'),
    }
  }

  // /constitution view (default)
  const c = constitution.load()
  const lines: string[] = [
    t('commands.constitution.view_title'),
    '',
    t('commands.constitution.view_summary', {
      version: c.version,
      count: String(c.principles.length),
      path: constitution.getPath(),
    }),
    '',
    '---',
    '',
  ]

  for (const p of c.principles) {
    const icon = p.enforce === 'block' ? '🚫' : p.enforce === 'warn' ? '⚠️' : '🔄'
    lines.push(`### ${icon} ${p.id} [${p.enforce}]`)
    lines.push('')
    lines.push(p.text)
    if (p.rationale) lines.push(`  *${p.rationale}*`)
    if (p.scope) lines.push(t('commands.constitution.scope', { scope: p.scope }))
    if (p.tools) lines.push(t('commands.constitution.tools', { tools: p.tools.join(', ') }))
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push(t('commands.constitution.reload_hint'))
  lines.push(t('commands.constitution.edit_hint'))
  lines.push(t('commands.constitution.reset_hint'))
  lines.push('')
  lines.push(t('commands.constitution.inspired'))

  return { content: lines.join('\n') }
}

// ═══════════════════════════════════════════════════════════════
// Bug Report
// ═══════════════════════════════════════════════════════════════

const bugReportCmd: CommandHandler = async (ctx) => {
  const t = resolveT(ctx)
  const engine = ctx.engine
  const lines: string[] = [
    t('commands.bug_report.title'),
    '',
    t('commands.bug_report.hint'),
    '',
    '---',
    '',
  ]

  // ── Version & Runtime ──
  lines.push(t('commands.bug_report.env_title'), '')
  lines.push(t('commands.bug_report.mipham', { version: ctx.version }))
  lines.push(t('commands.bug_report.session', { id: ctx.sessionId }))
  lines.push(t('commands.bug_report.node', { version: process.version }))
  lines.push(t('commands.bug_report.platform', { platform: process.platform, arch: process.arch }))
  lines.push(
    t('commands.bug_report.os', {
      os:
        process.platform === 'darwin'
          ? 'macOS'
          : process.platform === 'linux'
            ? 'Linux'
            : 'Windows',
    }),
  )
  lines.push(t('commands.bug_report.provider', { provider: ctx.providerId }))
  lines.push(t('commands.bug_report.model', { model: ctx.modelId }))
  lines.push('')

  // ── SIS errors ──
  try {
    const db = engine.getErrorSignatureDB?.()
    if (db) {
      const active = db.getActive()
      if (active.length > 0) {
        lines.push(t('commands.bug_report.sigs_title'), '')
        for (const sig of active.slice(0, 10)) {
          lines.push(
            t('commands.bug_report.sig_entry', {
              id: sig.id,
              pattern: sig.pattern,
              category: sig.category,
              occurrences: String(sig.occurrences),
              pct: (sig.successRate * 100).toFixed(0),
            }),
          )
        }
        lines.push('')
      }
    }
  } catch {
    // SIS unavailable
  }

  // ── Hook health ──
  try {
    const hookEngine = engine.getHookEngine?.()
    if (hookEngine) {
      const health = hookEngine.getHookHealth()
      const disabled = health.filter((h) => h.health.disabled)
      if (disabled.length > 0) {
        lines.push(t('commands.bug_report.disabled_hooks'), '')
        for (const entry of disabled) {
          lines.push(
            t('commands.bug_report.hook_entry', {
              key: entry.key,
              failures: String(entry.health.failures),
              time: new Date(entry.health.disabledAt).toISOString(),
            }),
          )
        }
        lines.push('')
      }
    }
  } catch {
    // Hook health unavailable
  }

  // ── Recent dream log ──
  try {
    const dreamEngine = engine.getDreamEngine?.()
    if (dreamEngine) {
      const history = dreamEngine.getDreamHistory()
      if (history.length > 0) {
        const last = history[0]!
        lines.push(t('commands.bug_report.last_dream'), '')
        lines.push(t('commands.bug_report.ran_at', { time: last.timestamp }))
        lines.push(
          t('commands.bug_report.actions', {
            total: String(last.actions.length),
            applied: String(
              last.actions.filter((a: { autoApplied: boolean }) => a.autoApplied).length,
            ),
          }),
        )
        lines.push('')
      }
    }
  } catch {
    // Dream engine unavailable
  }

  // ── Steps to reproduce (template) ──
  lines.push(t('commands.bug_report.steps_title'), '')
  lines.push('1. ')
  lines.push('2. ')
  lines.push('3. ')
  lines.push('')
  lines.push(t('commands.bug_report.expected'), '')
  lines.push('')
  lines.push(t('commands.bug_report.actual'), '')
  lines.push('')
  lines.push('---')
  lines.push(t('commands.bug_report.generated', { version: ctx.version }))

  return { content: lines.join('\n'), copyContent: lines.join('\n') }
}

// ═══════════════════════════════════════════════════════════════
// Feedback
// ═══════════════════════════════════════════════════════════════
// Changelog
// ═══════════════════════════════════════════════════════════════

const changelogCmd: CommandHandler = async (ctx) => {
  const t = resolveT(ctx)
  const lines: string[] = [t('commands.changelog.title'), '']

  try {
    const { execSync } = await import('node:child_process')
    const tags = execSync('git tag --sort=-creatordate', { encoding: 'utf-8', timeout: 5000 })
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(0, 15)

    if (tags.length === 0) {
      lines.push(t('commands.changelog.no_tags'))
      return { content: lines.join('\n') }
    }

    lines.push(t('commands.changelog.current', { version: ctx.version }), '')

    for (let i = 0; i < tags.length; i++) {
      const tag = tags[i]!
      const nextTag = tags[i + 1]
      try {
        const range = nextTag ? `${nextTag}..${tag}` : tag
        const log = execSync(
          `git log --oneline --no-merges ${range} --format="%s" 2>/dev/null | head -8`,
          { encoding: 'utf-8', timeout: 5000 },
        )
          .trim()
          .split('\n')
          .filter(Boolean)

        const isCurrent = tag === `v${ctx.version}`
        lines.push(`### ${tag}${isCurrent ? t('commands.changelog.current_marker') : ''}`, '')
        if (log.length > 0) {
          for (const entry of log) {
            lines.push(`- ${entry}`)
          }
        } else {
          lines.push(t('commands.changelog.release_only'))
        }
        lines.push('')
      } catch {
        lines.push(`### ${tag}`, '', t('commands.changelog.details_unavailable'), '')
      }
    }
  } catch {
    lines.push(t('commands.changelog.no_git'))
  }

  lines.push('---')
  lines.push(t('commands.changelog.full_history'))

  return { content: lines.join('\n') }
}

// ═══════════════════════════════════════════════════════════════
// Workflow
// ═══════════════════════════════════════════════════════════════

const planCmd: CommandHandler = (_ctx, args) => {
  const t = resolveT(_ctx)
  const description = args.join(' ') || undefined
  return {
    content: t('commands.plan.content'),
    forwardToAI: description
      ? `Use EnterPlanMode with description: "${description}". Then explore, design, and use ExitPlanMode when ready for approval.`
      : 'Use EnterPlanMode to enter plan mode. Explore the codebase, design an approach, then use ExitPlanMode to submit for approval.',
  }
}

const tddCmd: CommandHandler = (_ctx, args) => {
  const t = resolveT(_ctx)
  const target = args.join(' ') || 'the current task'
  return {
    content: stripIndent`
      ${t('commands.tdd.title')}
      ${t('commands.tdd.start', { target })}

      ${t('commands.tdd.cycle')}
        ${t('commands.tdd.red')}
        ${t('commands.tdd.green')}
        ${t('commands.tdd.refactor')}

      ${t('commands.tdd.guide')}
    `,
    forwardToAI: `Follow the Test-Driven Development workflow for ${target}:
1. RED — Write a failing test that defines the expected behavior. Use the project's test framework (Vitest/Jest/pytest). Show me the test code and confirm it fails.
2. GREEN — Write the minimum code needed to make the test pass. Run the test to verify it passes.
3. REFACTOR — Clean up both test and implementation code. Remove duplication, improve names, simplify. Keep tests green.
Repeat for each behavior. Do NOT write implementation before tests.`,
  }
}

const todosCmd: CommandHandler = (_ctx, args) => {
  const t = resolveT(_ctx)
  const sub = args[0]
  if (sub === 'create') {
    const title = args.slice(1).join(' ')
    if (!title.trim()) {
      return { content: t('commands.todos.usage_create') }
    }
    return {
      content: `${t('commands.todos.create_title')}\n\nCreating task: "${title.trim()}"\n\nPassing to AI for structured task creation with TaskCreate...`,
      forwardToAI: `Create a new task using TaskCreate with subject "${title.trim()}". Set a clear description and activeForm.`,
    }
  }

  if (sub === 'list' || !sub) {
    return {
      content: stripIndent`
        ${t('commands.todos.list_title')}
        ${t('commands.todos.list_fetching')}

        Shortcuts:
          ${t('commands.todos.item_list')}
          ${t('commands.todos.item_create')}
      `,
      forwardToAI:
        'Use TaskList to show all current tasks. Present them in a clear summary grouped by status (pending/in_progress/completed). If there are no tasks, suggest creating one.',
    }
  }

  return {
    content: stripIndent`
      ${t('commands.todos.default_title')}
      ${t('commands.todos.item_list')}
      ${t('commands.todos.item_create')}

      ${t('commands.todos.default_body')}
    `,
    forwardToAI: 'Use TaskList to show all current tasks, then present them clearly.',
  }
}

// ═══════════════════════════════════════════════════════════════
// Project
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// Phase 1 — New Session Commands
// ═══════════════════════════════════════════════════════════════

const renameCmd: CommandHandler = (ctx, args) => {
  const t = resolveT(ctx)
  const name = args.join(' ')
  if (!name.trim()) {
    return { content: t('commands.rename.usage') }
  }
  ctx.setSessionTitle(name.trim())
  // Persist to the cross-session registry so `@name` can address this session.
  // Returns the (possibly uniquified) final name — surface that to the user.
  const finalName = renameActiveSession(ctx.sessionId, name.trim())
  return { content: t('commands.rename.confirmed', { name: finalName ?? name.trim() }) }
}

const goalCmd: CommandHandler = (ctx, args) => {
  const t = resolveT(ctx)
  const input = args.join(' ')

  // ── Show goal status ──
  if (!input.trim()) {
    const state = ctx.engine.getGoalState?.() || { goal: undefined, decompose: false, subtasks: [] }
    if (!state.goal) {
      return { content: t('commands.goal.usage') }
    }
    const lines = [
      t('commands.goal.status_title'),
      '',
      t('commands.goal.status_goal', { goal: state.goal }),
    ]
    if (state.verifyScript)
      lines.push(t('commands.goal.status_verify_script', { script: state.verifyScript }))
    if (state.verifySkill)
      lines.push(t('commands.goal.status_verify_skill', { skill: state.verifySkill }))
    if (state.decompose)
      lines.push(t('commands.goal.status_decompose', { count: String(state.subtasks.length) }))
    lines.push('', t('commands.goal.status_clear_hint'))
    return { content: lines.join('\n') }
  }

  // ── Parse options ──
  let goal = input
  let decompose = false
  let verifyScript: string | undefined
  let verifySkill: string | undefined

  // Extract --decompose
  if (goal.includes(' --decompose')) {
    decompose = true
    goal = goal.replace(' --decompose', '')
  }

  // Extract --verify-script <path>
  const scriptMatch = goal.match(/ --verify-script\s+(\S+)/)
  if (scriptMatch) {
    verifyScript = scriptMatch[1]!
    goal = goal.replace(` --verify-script ${verifyScript}`, '')
  }

  // Extract --verify-skill <name>
  const skillMatch = goal.match(/ --verify-skill\s+(\S+)/)
  if (skillMatch) {
    verifySkill = skillMatch[1]!
    goal = goal.replace(` --verify-skill ${verifySkill}`, '')
  }

  goal = goal.trim()
  if (!goal) {
    return { content: t('commands.goal.empty_set') }
  }

  ctx.setGoal(goal)
  ctx.engine.setGoal(goal, { verifyScript, verifySkill, decompose })

  const lines = [t('commands.goal.set', { goal })]
  if (decompose) {
    lines.push(t('commands.goal.decompose_enabled'))
    // Decompose by creating initial subtasks
    const decomposeMsg = `Break down this goal into 3-5 subtasks: "${goal}". For each subtask, use TaskCreate with the subject and description. Mark each as blocked by the previous one to create a dependency chain.`
    return {
      content: lines.join('\n'),
      forwardToAI: decomposeMsg,
    }
  }
  if (verifyScript) lines.push(t('commands.goal.status_verify_script', { script: verifyScript }))
  if (verifySkill) lines.push(t('commands.goal.status_verify_skill', { skill: verifySkill }))
  lines.push('')
  lines.push(t('commands.goal.status_hint'))

  return { content: lines.join('\n') }
}

const recapCmd: CommandHandler = (ctx) => {
  const t = resolveT(ctx)
  const c = ctx.engine.getContext()
  const msgs = c.getMessages()
  if (msgs.length === 0) {
    return { content: t('commands.recap.no_conversation') }
  }
  const userMsgs = msgs.filter((m) => m.role === 'user').length
  const assistantMsgs = msgs.filter((m) => m.role === 'assistant').length
  const tokens = c.getEstimatedTokens()
  const checkpointCount = c.getCheckpoints().length

  const topics = msgs
    .filter((m) => m.role === 'user' && typeof m.content === 'string')
    .slice(0, 5)
    .map((m) => {
      const text = typeof m.content === 'string' ? m.content : ''
      return text.length > 80 ? text.slice(0, 80) + '...' : text
    })

  return {
    content: stripIndent`
      ${t('commands.recap.title')}
      ${t('commands.recap.messages')}  ${msgs.length} (${userMsgs} user, ${assistantMsgs} assistant)
      ${t('commands.recap.est_tokens')} ~${tokens.toLocaleString()}
      ${t('commands.recap.checkpoints')} ${checkpointCount}

      ${t('commands.recap.recent_topics')}
      ${topics.map((t, i) => `  ${i + 1}. ${t}`).join('\n')}

      ${t('commands.recap.footer')}
    `,
  }
}

const usageCmd: CommandHandler = (ctx) => {
  const t = resolveT(ctx)
  const c = ctx.engine.getContext()
  const estTokens = c.getEstimatedTokens()
  const msgs = c.getMessages()
  const maxTokens = 200_000
  const pct = ((estTokens / maxTokens) * 100).toFixed(1)

  const tracker = ctx.engine.getUsageTracker()
  const summary = tracker.getSummary()

  // Build per-tool breakdown
  const toolLines: string[] = []
  const sortedTools = Object.entries(summary.tools).sort(
    (a, b) => b[1].inputTokens + b[1].outputTokens - (a[1].inputTokens + a[1].outputTokens),
  )
  for (const [name, usage] of sortedTools) {
    const total = usage.inputTokens + usage.outputTokens
    const prefix = name.startsWith('mcp__') ? '🔌 ' : '  '
    toolLines.push(
      `${prefix}${name.padEnd(18)} ${total.toLocaleString().padStart(8)} tokens (${usage.calls} call${usage.calls !== 1 ? 's' : ''})`,
    )
  }

  const apiTotal = summary.apiInputTokens + summary.apiOutputTokens
  const apiLine =
    summary.apiInputTokens > 0 || summary.apiOutputTokens > 0
      ? t('commands.usage.api_tokens', {
          in: summary.apiInputTokens.toLocaleString(),
          out: summary.apiOutputTokens.toLocaleString(),
          total: apiTotal.toLocaleString(),
        })
      : t('commands.usage.no_api')

  const toolSection =
    toolLines.length > 0 ? `\n${t('commands.usage.tool_section')}\n${toolLines.join('\n')}` : ''

  const loops = listActiveAutoloops()
  const loopSection =
    loops.length > 0
      ? `\n${t('commands.usage.loops_header')}\n${formatLoopRows(loops).join('\n')}`
      : ''

  return {
    content: stripIndent`
      ${t('commands.usage.title')}
      ${apiLine}
      ${t('commands.usage.context_line', { est: estTokens.toLocaleString(), max: maxTokens.toLocaleString(), pct })}
      ${t('commands.usage.messages_line', { count: String(msgs.length) })}
      ${t('commands.usage.provider_line', { provider: ctx.providerId })}
      ${t('commands.usage.model_line', { model: ctx.modelId })}

      ${'█'.repeat(Math.ceil(Number(pct) / 5))}${'░'.repeat(20 - Math.ceil(Number(pct) / 5))} ${pct}%
      ${toolSection}${loopSection}

      ${t('commands.usage.hint')}
    `,
  }
}

const reloadSkillsCmd: CommandHandler = (ctx) => {
  const t = resolveT(ctx)
  if (!ctx.skillsLoader) {
    return { content: t('commands.reload_skills.unavailable') }
  }
  try {
    const config = ctx.config
    ctx.skillsLoader.loadBuiltin(process.cwd())
    if (config.skills?.paths) {
      ctx.skillsLoader.loadExternal(config.skills.paths)
    }
    const skills = ctx.skillsLoader.list()
    return {
      content: `${t('commands.reload_skills.confirmed', { count: String(skills.length) })}\n\n${skills.map((s) => `  ${s.name.padEnd(28)} ${s.type.padEnd(10)} ${s.description}`).join('\n')}`,
    }
  } catch (err) {
    return { content: t('commands.reload_skills.failed', { error: String(err) }) }
  }
}

// ═══════════════════════════════════════════════════════════════
// Skill Marketplace — Community skill registry + installation
// ═══════════════════════════════════════════════════════════════

const browseSkillsCmd: CommandHandler = async (ctx) => {
  const _t = resolveT(ctx)
  const { getAvailableSkills, listInstalledSkills } = await import('../skills/registry')
  const available = getAvailableSkills()
  const installed = new Set(
    listInstalledSkills().map((f: string) => f.replace(/\.(SKILL\.)?md$/i, '')),
  )

  const categories = new Map<string, string[]>()
  for (const s of available) {
    const list = categories.get(s.category) || []
    list.push(s.name)
    categories.set(s.category, list)
  }

  const lines: string[] = [
    '── Community Skills ──',
    '',
    `${available.length} skills available · ${installed.size} installed`,
    '',
  ]

  for (const [cat, names] of categories) {
    lines.push(`  ${cat}:`)
    for (const name of names) {
      const entry = available.find((s) => s.name === name)!
      const marker = entry.builtin ? '🏠' : installed.has(name) ? '✅' : '⬜'
      const status = entry.builtin ? ' (built-in)' : installed.has(name) ? ' (installed)' : ''
      lines.push(`    ${marker} /${name.padEnd(26)} ${entry.description}${status}`)
    }
    lines.push('')
  }

  lines.push('Install: /install-skill <name>')
  lines.push('Install from URL: /install-skill <github-url>')
  lines.push('Remove:  /remove-skill <name>')

  return { content: lines.join('\n') }
}

const installSkillCmd: CommandHandler = async (ctx, args) => {
  const { installSkill, installSkillFromUrl } = await import('../skills/registry')

  const target = args[0]
  if (!target) {
    return { content: 'Usage: /install-skill <skill-name> or /install-skill <url>' }
  }

  const marketplaceConfig = ctx.config.marketplace
  let result: { success: boolean; name: string; message: string }

  if (target.startsWith('http://') || target.startsWith('https://')) {
    result = await installSkillFromUrl(target, marketplaceConfig)
  } else {
    result = await installSkill(target, marketplaceConfig)
  }

  return {
    content: result.success ? `✅ ${result.message}` : `❌ ${result.message}`,
  }
}

const removeSkillCmd: CommandHandler = async (_ctx, args) => {
  const { removeSkill } = await import('../skills/registry')

  const name = args[0]
  if (!name) {
    return { content: 'Usage: /remove-skill <skill-name>' }
  }

  const result = removeSkill(name)
  return {
    content: result.success ? `✅ ${result.message}` : `❌ ${result.message}`,
  }
}

const marketplaceCmd: CommandHandler = async (_ctx, args) => {
  const {
    readMarketplaces,
    addMarketplace,
    removeMarketplace,
    isValidMarketplaceRef,
    MARKETPLACES_PATH,
  } = await import('../skills/marketplace')
  const { readFileSync, writeFileSync, existsSync, mkdirSync } = await import('node:fs')
  const { dirname } = await import('node:path')

  const readSources = () =>
    readMarketplaces((p) => (existsSync(p) ? readFileSync(p, 'utf-8') : null))

  const sub = args[0]
  const ref = args[1]

  if (!sub || sub === 'list') {
    const sources = readSources()
    const lines = ['── Marketplace Sources ──', '']
    for (const s of sources) lines.push(`  ${s.owner}/${s.repo}`)
    lines.push(
      '',
      'Add:    /marketplace add <owner>/<repo>',
      'Remove: /marketplace remove <owner>/<repo>',
    )
    return { content: lines.join('\n') }
  }

  if (sub === 'add' || sub === 'remove') {
    if (!ref) return { content: `Usage: /marketplace ${sub} <owner>/<repo>` }
    const [owner, repo] = ref.split('/')
    if (!owner || !repo || !isValidMarketplaceRef(owner, repo)) {
      return { content: `❌ Invalid marketplace ref "${ref}". Expected <owner>/<repo>.` }
    }
    const current = readSources()
    const result =
      sub === 'add' ? addMarketplace(current, owner, repo) : removeMarketplace(current, owner, repo)
    const changed = 'added' in result ? result.added : result.removed
    try {
      mkdirSync(dirname(MARKETPLACES_PATH), { recursive: true })
      writeFileSync(MARKETPLACES_PATH, JSON.stringify(result.sources, null, 2), 'utf-8')
    } catch (err) {
      return { content: `❌ Failed to save marketplaces: ${String(err)}` }
    }
    if (sub === 'add') {
      return {
        content: changed ? `✅ Added ${owner}/${repo}` : `ℹ ${owner}/${repo} already exists`,
      }
    }
    return { content: changed ? `✅ Removed ${owner}/${repo}` : `ℹ ${owner}/${repo} not found` }
  }

  return { content: 'Usage: /marketplace add|list|remove [owner/repo]' }
}

const browseMarketplaceCmd: CommandHandler = async (_ctx) => {
  const { readMarketplaces, discoverSkills, downloadFile } = await import('../skills/marketplace')
  const { readFileSync, existsSync } = await import('node:fs')

  const sources = readMarketplaces((p) => (existsSync(p) ? readFileSync(p, 'utf-8') : null))
  const lines = ['── Marketplace Skills ──', '']
  for (const source of sources) {
    lines.push(`  ${source.owner}/${source.repo}:`)
    try {
      const skills = await discoverSkills(source, globalThis.fetch, downloadFile)
      if (skills.length === 0) lines.push('    (no skills found)')
      for (const s of skills) lines.push(`    ${s.name.padEnd(24)} ${s.description}`)
    } catch {
      lines.push('    (failed to discover — check network / rate limit)')
    }
    lines.push('')
  }
  lines.push('Install: /install-skill <name>')
  return { content: lines.join('\n') }
}

// ═══════════════════════════════════════════════════════════════
// Plugins — Community plugin marketplace + local management
// ═══════════════════════════════════════════════════════════════

const pluginsCmd: CommandHandler = (ctx) => {
  const t = resolveT(ctx)
  const manager = ctx.pluginManager
  if (!manager) {
    return { content: t('commands.plugins.unavailable') }
  }

  const plugins = manager.list()
  if (plugins.length === 0) {
    return { content: t('commands.plugins.none') }
  }

  const lines: string[] = [
    t('commands.plugins.title'),
    '',
    ...plugins.map((p) => {
      const status = p.enabled ? '✅ enabled' : '⛔ disabled'
      return `  ${p.name.padEnd(24)} v${p.version.padEnd(10)} ${status}  ${p.installedAt ? new Date(p.installedAt).toLocaleDateString() : ''}`
    }),
    '',
    `${plugins.length} plugin(s) installed.`,
    '',
    'Manage: /install-plugin | /remove-plugin | /plugin-enable | /plugin-disable',
  ]
  return { content: lines.join('\n') }
}

const browsePluginsCmd: CommandHandler = async (ctx) => {
  const { getAvailablePlugins } = await import('../plugin/plugin-registry')
  const available = getAvailablePlugins()
  const installed = new Set((ctx.pluginManager?.list() ?? []).map((p) => p.name))

  const categories = new Map<string, string[]>()
  for (const p of available) {
    const list = categories.get(p.category) || []
    list.push(p.name)
    categories.set(p.category, list)
  }

  const lines: string[] = [
    '── Community Plugins ──',
    '',
    `${available.length} plugins available · ${installed.size} installed`,
    '',
  ]

  for (const [cat, names] of categories) {
    lines.push(`  ${cat}:`)
    for (const name of names) {
      const entry = available.find((p) => p.name === name)!
      const marker = installed.has(name) ? '✅' : '⬜'
      lines.push(`    ${marker} ${name.padEnd(22)} ${entry.description}`)
      lines.push(`       npm: ${entry.npmPackage}`)
    }
    lines.push('')
  }

  lines.push('Install: /install-plugin <npm-package>')
  lines.push('Remove:  /remove-plugin <name>')

  return { content: lines.join('\n') }
}

const installPluginCmd: CommandHandler = async (ctx, args) => {
  const target = args[0]
  if (!target) {
    return {
      content: [
        'Usage: /install-plugin <npm-package> or /install-plugin <local-path>',
        '',
        'Examples:',
        '  /install-plugin @roomi-fields/notebooklm-mcp',
        '  /install-plugin mipham-plugin-security',
        '  /install-plugin ~/my-custom-plugin/',
        '',
        'Use /browse-plugins to see available community plugins.',
      ].join('\n'),
    }
  }

  const manager = ctx.pluginManager
  if (!manager) {
    return { content: '❌ PluginManager not available in this session.' }
  }

  // Determine if it's a local path or npm package
  const isLocalPath = target.startsWith('./') || target.startsWith('/') || target.startsWith('~/')

  let result: { success: boolean; message: string }

  if (isLocalPath) {
    const { resolve } = await import('node:path')
    const resolved = resolve(target.replace(/^~/, process.env.HOME || '~'))
    result = manager.install(resolved)
  } else {
    // Treat as npm package name
    result = manager.installFromNpm(target)
  }

  return {
    content: result.success ? `✅ ${result.message}` : `❌ ${result.message}`,
  }
}

const removePluginCmd: CommandHandler = (ctx, args) => {
  const name = args[0]
  if (!name) {
    return { content: 'Usage: /remove-plugin <name>\n\nUse /plugins to see installed plugins.' }
  }

  const manager = ctx.pluginManager
  if (!manager) {
    return { content: '❌ PluginManager not available in this session.' }
  }

  const ok = manager.remove(name)
  return {
    content: ok
      ? `✅ Plugin "${name}" removed.`
      : `❌ Plugin "${name}" not found. Use /plugins to list installed plugins.`,
  }
}

const pluginEnableCmd: CommandHandler = (ctx, args) => {
  const name = args[0]
  if (!name) {
    return { content: 'Usage: /plugin-enable <name>\n\nUse /plugins to see installed plugins.' }
  }

  const manager = ctx.pluginManager
  if (!manager) {
    return { content: '❌ PluginManager not available in this session.' }
  }

  const ok = manager.enable(name)
  return {
    content: ok
      ? `✅ Plugin "${name}" enabled.`
      : `❌ Plugin "${name}" not found. Use /plugins to list installed plugins.`,
  }
}

const pluginDisableCmd: CommandHandler = (ctx, args) => {
  const name = args[0]
  if (!name) {
    return { content: 'Usage: /plugin-disable <name>\n\nUse /plugins to see installed plugins.' }
  }

  const manager = ctx.pluginManager
  if (!manager) {
    return { content: '❌ PluginManager not available in this session.' }
  }

  const ok = manager.disable(name)
  return {
    content: ok
      ? `✅ Plugin "${name}" disabled.`
      : `❌ Plugin "${name}" not found. Use /plugins to list installed plugins.`,
  }
}

// ═══════════════════════════════════════════════════════════════
// Phase 1 — History & Checkpoint Commands
// ═══════════════════════════════════════════════════════════════

const rewindCmd: CommandHandler = (ctx) => {
  const t = resolveT(ctx)
  const c = ctx.engine.getContext()
  const checkpoints = c.getCheckpoints()

  if (checkpoints.length === 0) {
    return { content: t('commands.rewind.no_checkpoints') }
  }

  const result = c.restoreCheckpoint()
  if (!result.restored) {
    return { content: t('commands.rewind.no_restore') }
  }

  return {
    content: t('commands.rewind.confirmed', {
      label: result.label,
      count: String(result.messageCount),
      remaining: String(c.getCheckpoints().length),
    }),
    clearMessages: true,
  }
}

const undoCmd: CommandHandler = rewindCmd

const copyCmd: CommandHandler = (ctx, args) => {
  const t = resolveT(ctx)
  const c = ctx.engine.getContext()
  const msgs = c.getMessages()
  const assistantMsgs = msgs.filter((m) => m.role === 'assistant')

  if (assistantMsgs.length === 0) {
    return { content: t('commands.copy.no_responses') }
  }

  // Determine which response to copy: last N or last 1
  let n = 1
  if (args[0]) {
    n = parseInt(args[0]!, 10)
    if (isNaN(n) || n < 1) {
      return { content: t('commands.copy.usage') }
    }
  }

  const toCopy = assistantMsgs.slice(-n)
  const text = toCopy
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n\n---\n\n')

  return {
    content: t('commands.copy.confirmed', { count: String(toCopy.length) }),
    copyContent: text,
  }
}

const diffCmd: CommandHandler = async (_ctx) => {
  const t = resolveT(_ctx)
  try {
    const { execSync } = await import('node:child_process')
    const output = execSync('git diff --stat', { encoding: 'utf-8', timeout: 5000 })
    if (!output.trim()) {
      return { content: t('commands.diff.clean') }
    }
    // Get full diff but limit to reasonable size
    const fullDiff = execSync('git diff --no-color', { encoding: 'utf-8', timeout: 5000 })
    const MAX_LINES = 60
    const lines = fullDiff.split('\n')
    const truncated =
      lines.length > MAX_LINES
        ? lines.slice(0, MAX_LINES).join('\n') +
          `\n\n... (${lines.length - MAX_LINES} more lines. Use git diff to see full output.)`
        : fullDiff

    return {
      content: `${t('commands.diff.title')}\n\n${truncated}`,
    }
  } catch {
    return {
      content: t('commands.diff.error'),
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Phase 1 — Model Control Commands
// ═══════════════════════════════════════════════════════════════

const fastCmd: CommandHandler = (ctx, args) => {
  const t = resolveT(ctx)
  const arg = args[0]?.toLowerCase()
  if (arg === 'on') {
    ctx.setFastMode(true)
    return { content: t('commands.fast.on') }
  } else if (arg === 'off') {
    ctx.setFastMode(false)
    return { content: t('commands.fast.off') }
  } else if (arg) {
    return { content: t('commands.fast.usage') }
  } else {
    return { content: t('commands.fast.unknown') }
  }
}

const effortCmd: CommandHandler = (ctx, args) => {
  const t = resolveT(ctx)
  const VALID_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
  const level = args[0]?.toLowerCase()

  if (!level || !VALID_LEVELS.includes(level)) {
    return { content: t('commands.effort.usage', { model: ctx.modelId }) }
  }

  ctx.setEffort(level)
  return { content: t('commands.effort.confirmed', { level }) }
}

const focusCmd: CommandHandler = (ctx) => {
  const t = resolveT(ctx)
  ctx.setFocusMode(true)
  return { content: t('commands.focus.on') }
}

// ═══════════════════════════════════════════════════════════════
// Ultracode Mode — toggle multi-agent workflow orchestration
// ═══════════════════════════════════════════════════════════════

const ultracodeCmd: CommandHandler = (ctx, args) => {
  const t = resolveT(ctx)
  const arg = args[0]?.toLowerCase()
  if (arg === 'on') {
    ctx.setUltracodeMode(true)
    return {
      content: t('commands.ultracode.on'),
      forwardToAI: stripIndent`
        Ultracode mode is now ACTIVE. For every substantive task:
        - Use the Workflow tool to orchestrate multi-agent execution
        - Default to pipeline() for multi-stage work — stages flow independently
        - Fan out independent work across parallel agents
        - Apply adversarial verification (verify with skeptics) to findings before accepting them
        - Synthesize results with a top-tier model pass
        - Prefer pipeline() over parallel() barriers — don't block stages unnecessarily
        - Use loopUntilConvergence when discovering unknown-size sets (bugs, issues, edge cases)
        - EDGE LOGIC IS FREE: flatten, dedupe, filter in plain JavaScript — NOT agent calls
        Keep responses concise — the workflow graph handles the depth.`,
    }
  } else if (arg === 'off') {
    ctx.setUltracodeMode(false)
    return {
      content: t('commands.ultracode.off'),
      forwardToAI:
        'Ultracode mode is now OFF. Revert to standard single-agent execution. Do NOT use Workflow tool unless explicitly asked.',
    }
  }
  return { content: t('commands.ultracode.usage') }
}

// ═══════════════════════════════════════════════════════════════
// Phase 1 — Workflow Commands
// ═══════════════════════════════════════════════════════════════

const tasksCmd: CommandHandler = (ctx) => {
  const t = resolveT(ctx)
  const c = ctx.engine.getContext()
  const msgs = c.getMessages()

  // Scan for task-related tool uses in message history
  const toolUses = msgs.flatMap((m) => {
    if (Array.isArray(m.content)) {
      return m.content.filter(
        (b) => b.type === 'tool_use' && ['TaskCreate', 'TaskUpdate', 'TaskList'].includes(b.name),
      )
    }
    return []
  })

  return {
    content: stripIndent`
      ${t('commands.task_list.title')}

      ${toolUses.length > 0 ? t('commands.task_list.detected', { count: String(toolUses.length) }) : t('commands.task_list.no_tasks')}

      ${t('commands.task_list.reference')}
        TaskCreate  — create a new task
        TaskList    — list all tasks
        TaskUpdate  — update task status
        TaskGet     — get task details
        TaskOutput  — get background task output
        TaskStop    — stop a running task

      ${t('commands.task_list.legacy_hint')}
    `,
  }
}

const branchCmd: CommandHandler = (ctx, args) => {
  const t = resolveT(ctx)
  const name = args.join(' ') || `branch-${Date.now()}`
  const c = ctx.engine.getContext()
  const msgs = c.getMessages()

  if (msgs.length === 0) {
    return { content: t('commands.branch.no_conversation') }
  }

  const checkpointId = c.saveCheckpoint(name)
  return {
    content: t('commands.branch.details', {
      name,
      checkpoint: String(checkpointId),
      messages: String(msgs.length),
    }),
  }
}

/** Parse human-readable interval to seconds. Returns null if invalid. */
function parseInterval(raw: string): number | null {
  const m = raw.trim().match(/^(\d+)\s*(s|sec|m|min|h|hr|hour)$/i)
  if (!m) return null
  const n = parseInt(m[1]!, 10)
  const unit = m[2]!.toLowerCase()
  if (unit === 's' || unit === 'sec') return n
  if (unit === 'm' || unit === 'min') return n * 60
  if (unit === 'h' || unit === 'hr' || unit === 'hour') return n * 3600
  return null
}

const loopCmd: CommandHandler = async (ctx, args) => {
  const sub = args[0]

  // ── /loop init — scaffold project vault ──
  if (sub === 'init' || sub === 'scaffold') {
    const targetPath = args[1] || process.cwd()
    const { scaffoldLoopKit } = await import('../commands/loop-scaffold')
    const { created, skipped } = scaffoldLoopKit(targetPath)
    const { resolve } = await import('node:path')
    const resolved = resolve(targetPath.replace(/^~/, process.env.HOME || '~'))

    const lines: string[] = ['── LoopKit Vault Created ──', '', `Location: ${resolved}`, '']

    if (created.length > 0) {
      lines.push(`Created (${created.length}):`)
      for (const c of created.slice(0, 12)) {
        const rel = c.replace(resolved + '/', '')
        lines.push(`  ✅ ${rel}`)
      }
      if (created.length > 12) {
        lines.push(`  ... and ${created.length - 12} more`)
      }
    }

    if (skipped.length > 0) {
      lines.push('')
      lines.push(`Skipped (${skipped.length} — already exist):`)
      for (const s of skipped.slice(0, 5)) {
        const rel = s.replace(resolved + '/', '')
        lines.push(`  ⏭  ${rel}`)
      }
      if (skipped.length > 5) {
        lines.push(`  ... and ${skipped.length - 5} more`)
      }
    }

    lines.push('')
    lines.push('── Structure ──')
    lines.push('')
    lines.push('  .mipham/          Mipham Code config directory')
    lines.push('  ├── CLAUDE.md      Project AI instructions')
    lines.push('  ├── settings.json  Permission & hook settings')
    lines.push('  ├── hooks/         Lifecycle hook scripts (3)')
    lines.push('  ├── agents/        Custom sub-agents')
    lines.push('  └── skills/        9 domain-sorted skill directories')
    lines.push('')
    lines.push('  .mcp.json          MCP server configuration')
    lines.push('  MEMORY.md          AI persistent memory')
    lines.push('  run.sh / install.sh Project scripts')
    lines.push('')
    lines.push('Edit .mipham/CLAUDE.md to customize AI behavior.')
    lines.push('Add skills to .mipham/skills/<domain>/ directories.')
    lines.push('Configure MCP servers in .mcp.json.')
    lines.push('')
    lines.push('/loop init <path> to scaffold in a different location.')

    return { content: lines.join('\n') }
  }

  // ── /loop stop — stop autonomous loop ──
  if (sub === 'stop') {
    const { completeAutoloopJournal, listActiveAutoloops } =
      await import('../commands/autoloop-journal.js')
    const active = listActiveAutoloops()
    if (active.length === 0) {
      return { content: 'No active autonomous loops to stop.' }
    }
    for (const j of active) completeAutoloopJournal(j.sessionId, 'stopped')
    return { content: `Stopped ${active.length} autonomous loop(s).` }
  }

  // ── /loop status — show autonomous loop progress ──
  if (sub === 'status') {
    const { listActiveAutoloops, getAutoloopStatus } =
      await import('../commands/autoloop-journal.js')
    const active = listActiveAutoloops()
    if (active.length === 0) {
      return { content: 'No active autonomous loops.\n\nUse /loop auto <prompt> to start one.' }
    }
    const lines = active.map((j) => getAutoloopStatus(j.sessionId))
    return { content: lines.join('\n\n') }
  }

  // ── /loop auto <prompt> — autonomous self-paced loop ──
  if (sub === 'auto') {
    const prompt = args.slice(1).join(' ')
    if (!prompt.trim()) {
      return {
        content:
          'Usage: /loop auto <prompt>\n\n' +
          'Start an autonomous self-paced loop. The AI will:\n' +
          '1. Work on the task\n' +
          '2. Decide how long to wait before the next iteration\n' +
          '3. Use ScheduleWakeup to self-schedule\n' +
          '4. Use ScheduleWakeup(stop:true) when the goal is reached\n\n' +
          'Use /loop status to view progress.\n' +
          'Use /loop stop to stop the loop.',
      }
    }

    const sessionId = `autoloop-${Date.now()}`
    const { createAutoloopJournal } = await import('../commands/autoloop-journal.js')
    createAutoloopJournal(sessionId, prompt, ctx.engine.getUsageTracker().totalApiTokens)

    const autoPrompt =
      `## Autonomous Loop — ${sessionId}\n\n` +
      `Task: ${prompt}\n\n` +
      `You are in an autonomous loop. Each iteration:\n` +
      `1. Make progress on the task above\n` +
      `2. When you need to wait (e.g., for a deploy, CI, external event), call ScheduleWakeup with:\n` +
      `   - delaySeconds: your best estimate of how long to wait (60-3600)\n` +
      `   - reason: one sentence explaining why\n` +
      `   - prompt: include this full autonomous loop ID: ${sessionId}\n` +
      `3. When the task is COMPLETE, call ScheduleWakeup with stop:true\n\n` +
      `After each iteration, log progress by reading/writing the journal at ~/.mipham/autoloop/${sessionId}.json.\n` +
      `Use the autoloop-journal module: logAutoloopIteration("${sessionId}", "<summary>").`

    return {
      content:
        `── Autonomous Loop Started ──\n\n` +
        `ID:      ${sessionId}\n` +
        `Prompt:  "${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}"\n\n` +
        `The AI will self-pace. Use /loop status to view progress.\n` +
        `Use /loop stop to stop.`,
      forwardToAI: autoPrompt,
    }
  }

  // ── /loop <interval> <prompt> — recurring prompt (or auto-detect autonomous) ──
  if (args.length < 2) {
    return {
      content: stripIndent`
        Usage: /loop <interval> <prompt>     Fixed-interval loop
           or: /loop auto <prompt>           Autonomous self-paced loop
           or: /loop stop                     Stop active autonomous loop
           or: /loop status                   Show autonomous loop progress
           or: /loop init [path]              Scaffold project vault structure

        Fixed interval formats:
          10s   — 10 seconds
          5m    — 5 minutes
          1h    — 1 hour

        Examples:
          /loop 5m check the deploy status
          /loop auto monitor CI and fix failing tests
          /loop init                  Create vault in current directory
      `,
    }
  }

  const interval = args[0]!
  const prompt = args.slice(1).join(' ')
  const seconds = parseInterval(interval)

  // Auto-detect: if first arg is not a valid interval, assume autonomous mode
  if (seconds === null) {
    // Could be: /loop <full prompt without interval>
    const fullPrompt = args.join(' ')
    if (fullPrompt.length > 0) {
      const sessionId = `autoloop-${Date.now()}`
      const { createAutoloopJournal } = await import('../commands/autoloop-journal.js')
      createAutoloopJournal(sessionId, fullPrompt, ctx.engine.getUsageTracker().totalApiTokens)

      const autoPrompt =
        `## Autonomous Loop — ${sessionId}\n\n` +
        `Task: ${fullPrompt}\n\n` +
        `You are in an autonomous loop (auto-detected — no interval specified). Each iteration:\n` +
        `1. Make progress on the task above\n` +
        `2. When you need to wait, call ScheduleWakeup with your chosen delaySeconds and this loop ID: ${sessionId}\n` +
        `3. When COMPLETE, call ScheduleWakeup with stop:true\n\n` +
        `Log progress using logAutoloopIteration("${sessionId}", "<summary>").`

      return {
        content:
          `── Autonomous Loop Started (auto-detected) ──\n\n` +
          `ID:      ${sessionId}\n` +
          `Prompt:  "${fullPrompt.slice(0, 100)}${fullPrompt.length > 100 ? '...' : ''}"\n\n` +
          `No interval specified — using autonomous self-paced mode.\n` +
          `Use /loop stop to stop.`,
        forwardToAI: autoPrompt,
      }
    }
    return {
      content: `── Invalid Interval ──\n\n"${interval}" is not a recognised interval.\n\nUse formats like: 10s, 5m, 1h, 30min, 2hr\nOr use /loop auto <prompt> for autonomous mode.`,
    }
  }

  // Fixed-interval loop — directly invoke ScheduleWakeup
  try {
    const { scheduleWakeupTool } = await import('../tools/scheduling/schedule-wakeup.js')
    const result = await scheduleWakeupTool.execute(
      { delaySeconds: seconds, reason: `Loop: ${prompt.slice(0, 40)}`, prompt },
      { cwd: process.cwd(), sessionId: 'loop-session', provider: '', model: '' },
    )
    if (!result.success) {
      return { content: `Loop failed: ${result.error || 'unknown error'}` }
    }
    // When scheduling notices are hidden, stay silent — the loop is already scheduled.
    if (ctx.config.showSchedulingNotices === false) {
      return { content: '' }
    }
    return { content: result.content }
  } catch (e) {
    return { content: `Loop failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}

const scheduleCmd: CommandHandler = async (_ctx) => {
  try {
    const { cronListTool } = await import('../tools/scheduling/cron.js')
    const result = await cronListTool.execute(
      {},
      { cwd: process.cwd(), sessionId: 'schedule-view', provider: '', model: '' },
    )
    return { content: result.content }
  } catch (e) {
    return { content: `Schedule check failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// ═══════════════════════════════════════════════════════════════
// Diagnostic
// ═══════════════════════════════════════════════════════════════

const doctorCmd: CommandHandler = async (ctx) => {
  const t = resolveT(ctx)
  const lines: string[] = [
    t('commands.doctor.title'),
    '',
    `Mipham Code  v${ctx.version}`,
    `Runtime      ${typeof Bun !== 'undefined' ? 'Bun ' + Bun.version : 'Node.js ' + process.version}`,
    `Platform     ${process.platform} ${process.arch}`,
    `CWD          ${process.cwd()}`,
    `PID          ${process.pid}`,
    '',
    t('commands.doctor.config_section'),
    `Provider     ${ctx.providerId} / ${ctx.modelId}`,
    `Permission   ${ctx.config.permission}`,
    `Providers    ${ctx.config.providers.length} configured (${ctx.config.providers.filter((p) => p.status !== 'upcoming').length} active)`,
    '',
    t('commands.doctor.session_section'),
  ]

  const c = ctx.engine.getContext()
  const msgs = c.getMessages()
  const tokens = c.getEstimatedTokens()
  lines.push(`Messages     ${msgs.length}`)
  lines.push(
    `Tokens       ~${tokens.toLocaleString()} / 200,000 (${((tokens / 200_000) * 100).toFixed(1)}%)`,
  )
  lines.push(`Checkpoints  ${c.getCheckpoints().length}`)

  // Git info
  try {
    const { execSync } = await import('node:child_process')
    lines.push('')
    lines.push(t('commands.doctor.git_section'))
    const branch = execSync('git branch --show-current', {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim()
    lines.push(`Branch       ${branch || '(detached)'}`)
    const status = execSync('git status --porcelain', { encoding: 'utf-8', timeout: 3000 })
    const changed = status.trim().split('\n').filter(Boolean).length
    lines.push(`Changed      ${changed} file${changed !== 1 ? 's' : ''}`)
    const log = execSync('git log --oneline -3', { encoding: 'utf-8', timeout: 3000 }).trim()
    lines.push(`Last commits ${log.split('\n').length}`)
    lines.push('')
    lines.push(
      log
        .split('\n')
        .map((l, i) => `  ${i + 1}. ${l}`)
        .join('\n'),
    )
  } catch {
    lines.push('')
    lines.push(t('commands.doctor.git_section'))
    lines.push(t('commands.doctor.no_git'))
  }

  // Skills info
  if (ctx.skillsLoader) {
    lines.push('')
    lines.push(t('commands.doctor.skills_section'))
    try {
      const skills = ctx.skillsLoader.list()
      const standard = skills.filter((s: { type: string }) => s.type === 'standard').length
      const mipham = skills.filter((s: { type: string }) => s.type === 'mipham').length
      lines.push(`Loaded       ${skills.length} (${standard} standard + ${mipham} mipham)`)
    } catch {
      lines.push(t('commands.doctor.skills_unavailable'))
    }
  }

  // CLAUDE.md audit — flag sections the model can infer from the codebase
  try {
    const loader = new InstructionsLoader()
    loader.loadAll(process.cwd())
    const claudeFiles = loader.list().filter((f) => f.path.endsWith('CLAUDE.md'))

    lines.push('')
    lines.push(t('commands.doctor.audit_section'))
    let found = false
    for (const file of claudeFiles) {
      const sections = findDerivableSections(file.content)
      if (sections.length === 0) continue
      found = true
      lines.push(`  ${file.path}`)
      for (const s of sections) {
        lines.push(`    - "${s.heading}" — ${DERIVABLE_HINTS[s.reason]}`)
      }
    }
    if (!found) {
      lines.push(t('commands.doctor.audit_clean'))
    } else {
      lines.push('')
      lines.push(t('commands.doctor.audit_found'))
    }
  } catch {
    // best-effort — skip the audit on any failure
  }

  return { content: lines.join('\n') }
}

const fixCmd: CommandHandler = async (ctx, args) => {
  const t = resolveT(ctx)
  const { readFileSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')
  const { parse: parseYaml } = await import('yaml')

  const target = args.find((a) => a === 'doctor' || a === 'config' || a === 'cache' || a === 'test')
  const dryRun = args.includes('--dry-run')
  const apply = args.includes('--apply')

  const lines: string[] = [t('commands.fix.title')]
  if (dryRun) lines.push(t('commands.fix.dryrun_banner'))
  lines.push('')

  const readSafe = (p: string): string | null => {
    try {
      return readFileSync(p, 'utf-8')
    } catch {
      return null
    }
  }

  if (!target || target === 'doctor') {
    const loader = new InstructionsLoader()
    loader.loadAll(process.cwd())
    const files = selectRepoClaudeFiles(loader.list())
    const result = fixDoctor(files, {
      read: readSafe,
      write: (p, c) => {
        if (!dryRun) writeFileSync(p, c, 'utf-8')
      },
    })
    if (result.fixed.length === 0) {
      lines.push(t('commands.fix.doctor_clean'))
    } else {
      for (const f of result.fixed) {
        lines.push(t('commands.fix.doctor_fixed', { path: f.path, added: f.added.join(', ') }))
      }
    }
    lines.push('')
  }

  if (!target || target === 'config') {
    const home = homedir()
    const configPaths = [
      join(process.cwd(), '.mipham', 'config.yml'),
      join(home, '.mipham', 'config.yml'),
    ]
    const hookEngine = ctx.engine.getHookEngine?.()
    const result = fixConfig({
      configPaths,
      read: readSafe,
      parseYaml,
      restore: (p) => tryRestoreFromBackup(p),
      hookHealth: () =>
        hookEngine
          ? hookEngine.getHookHealth().map((h) => ({ key: h.key, disabled: h.health.disabled }))
          : [],
      reEnableHook: (k) => (hookEngine ? hookEngine.reEnableHook(k) : false),
      dryRun,
    })
    if (result.corruptConfigs.length === 0 && result.disabledHooks.length === 0) {
      lines.push(t('commands.fix.config_clean'))
    } else {
      for (const p of result.restoredConfigs) {
        lines.push(t('commands.fix.config_restored', { path: p }))
      }
      for (const p of result.corruptConfigs.filter((p) => !result.restoredConfigs.includes(p))) {
        lines.push(t('commands.fix.config_corrupt', { path: p }))
      }
      for (const k of result.reenabledHooks) {
        lines.push(t('commands.fix.hook_reenabled', { key: k }))
      }
      for (const k of result.disabledHooks.filter((k) => !result.reenabledHooks.includes(k))) {
        lines.push(t('commands.fix.hook_disabled', { key: k }))
      }
    }
    lines.push('')
  }

  if (!target || target === 'cache') {
    const crsiDir = join(homedir(), '.mipham', 'crsi')
    const cacheFiles = ['eval-scores.jsonl', 'improvements.jsonl', 'prose-proposals.jsonl'].map(
      (f) => join(crsiDir, f),
    )
    const result = fixCache(
      cacheFiles,
      {
        read: readSafe,
        write: (p, c) => writeFileSync(p, c, 'utf-8'),
      },
      apply && !dryRun,
    )
    if (result.files.length === 0) {
      lines.push(t('commands.fix.cache_clean'))
    } else {
      for (const f of result.files) {
        lines.push(
          t('commands.fix.cache_found', { path: f.path, count: String(f.corruptLines.length) }),
        )
      }
      if (apply && !dryRun) {
        for (const c of result.cleaned) {
          lines.push(t('commands.fix.cache_cleaned', { path: c.path, count: String(c.removed) }))
        }
      } else {
        lines.push(t('commands.fix.cache_hint'))
      }
    }
    lines.push('')
  }

  if (!target || target === 'test') {
    const testFile = args.find(
      (a) =>
        !a.startsWith('--') && a !== 'test' && a !== 'doctor' && a !== 'config' && a !== 'cache',
    )
    if (!testFile) {
      lines.push(t('commands.fix.test_usage'))
    } else {
      const llm = ctx.engine.getLlm() ?? ctx.engine.getRegistry()
      if (!llm) {
        lines.push(t('commands.fix.test_no_llm'))
      } else {
        const { execSync } = await import('node:child_process')
        const { dirname, resolve } = await import('node:path')
        const result = await fixCodeTarget(
          {
            runVitest: (file) => {
              try {
                const output = execSync(`pnpm vitest run '${file}'`, {
                  cwd: process.cwd(),
                  encoding: 'utf-8',
                  stdio: ['ignore', 'pipe', 'pipe'],
                })
                return { exitCode: 0, output }
              } catch (e) {
                const err = e as { stdout?: string; stderr?: string }
                return { exitCode: 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` }
              }
            },
            readFile: readSafe,
            writeFile: (p, c) => writeFileSync(p, c, 'utf-8'),
            generateFix: async (prompt) => {
              let text = ''
              for await (const chunk of llm.chat({
                model: '',
                messages: [{ role: 'user' as const, content: prompt }],
                temperature: 0,
              })) {
                if (chunk.type === 'text' && chunk.content) text += chunk.content
              }
              return stripCodeFences(text)
            },
            resolveSourceFile: (tf, specifier) => {
              const base = resolve(dirname(tf), specifier)
              return /\.[cm]?[jt]sx?$/.test(base) ? base : `${base}.ts`
            },
          },
          testFile,
          { apply: apply && !dryRun, maxRetries: 3 },
        )
        if (result.fixed) {
          lines.push(
            t('commands.fix.test_fixed', {
              test: result.testFile,
              source: result.sourceFile ?? '-',
              attempts: String(result.attempts),
            }),
          )
          if (!apply) lines.push(t('commands.fix.test_hint'))
        } else {
          lines.push(
            t('commands.fix.test_failed', { test: result.testFile, detail: result.detail ?? '' }),
          )
        }
      }
    }
    lines.push('')
  }

  return { content: lines.join('\n').trimEnd() }
}

// ═══════════════════════════════════════════════════════════════
// GitHub & Git Workflow Commands (Claude Code parity)
// ═══════════════════════════════════════════════════════════════

function gitDiffBridgeCmd(opts: {
  label: string
  noChangesKey: string
  runningKey: string
  errorKey: string
  forwardToAI: string | (() => string)
}): CommandHandler {
  return async (ctx) => {
    const t = resolveT(ctx)
    try {
      const { execSync } = await import('node:child_process')
      const diff = execSync('git diff --stat', { encoding: 'utf-8', timeout: 5000 }).trim()
      if (!diff) {
        return { content: `─ ${opts.label} ─\n\n${t(opts.noChangesKey)}` }
      }
      return {
        content: `─ ${opts.label} ─\n\n${t(opts.runningKey)}\n\nChanged files:\n${diff}`,
        forwardToAI: typeof opts.forwardToAI === 'function' ? opts.forwardToAI() : opts.forwardToAI,
      }
    } catch {
      return { content: `─ ${opts.label} ─\n\n${t(opts.errorKey)}` }
    }
  }
}

const codeReviewCmd = gitDiffBridgeCmd({
  label: 'Code Review',
  noChangesKey: 'commands.code_review.no_changes',
  runningKey: 'commands.code_review.running',
  errorKey: 'commands.code_review.error',
  forwardToAI: () =>
    `use the code-review skill to review all uncommitted changes. Check all 7 dimensions: correctness, security, performance, code quality, architecture & design, testing, and language-specific issues. Use effort level: ${getPreference('lastCodeReviewEffort', 'high')}.`,
})

const simplifyCmd = gitDiffBridgeCmd({
  label: 'Simplify',
  noChangesKey: 'commands.simplify.no_changes',
  runningKey: 'commands.simplify.running',
  errorKey: 'commands.simplify.error',
  forwardToAI:
    'use the self-review skill to review these uncommitted changes. Focus on 4 cleanup passes: 1) Reuse — find duplicated logic, replace with existing helpers; 2) Simplification — flatten nesting, remove redundant state and dead code; 3) Efficiency — fix repeated object creation, unnecessary I/O, memory issues; 4) Abstraction Level — ensure code sits at the right architectural layer. Apply equivalent transformations only — do NOT change logic or fix bugs.',
})

const verifyCmd = gitDiffBridgeCmd({
  label: 'Verify',
  noChangesKey: 'commands.verify.no_changes',
  runningKey: 'commands.verify.running',
  errorKey: 'commands.verify.error',
  forwardToAI:
    'verify these uncommitted changes through runtime observation only. For each change: 1) Find the user-facing surface (CLI command, API endpoint, UI interaction); 2) Drive the changed code to execute; 3) Push boundaries — pass null, repeated values, wrong types, interrupt mid-flow (Ctrl-C), resize window; 4) Report verdict per change: PASS (works as expected), FAIL (does not work or breaks something), BLOCKED (cannot reach observable state), SKIP (no runtime surface, e.g. pure documentation). Do NOT run the test suite — observe real execution behavior only.',
})

const designCmd: CommandHandler = (_ctx, args) => {
  const t = resolveT(_ctx)
  const topic = args.join(' ') || 'the current task'
  return {
    content: t('commands.design.start', { topic }),
    forwardToAI: `help me design the architecture for ${topic}. Explore 2-3 approaches with trade-offs, then present a design covering: component breakdown, data flow, interfaces between components, error handling strategy, and testing approach. Use the plan sub-agent if deeper analysis would help. Prefer simplicity — YAGNI.`,
  }
}

const lintCmd: CommandHandler = async (ctx) => {
  const t = resolveT(ctx)
  try {
    const { execSync } = await import('node:child_process')
    const { existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const cwd = process.cwd()

    const hasPackageJson = existsSync(join(cwd, 'package.json'))

    let lintOutput = ''
    if (hasPackageJson) {
      try {
        lintOutput = execSync(
          'npx eslint . --ext .ts,.tsx,.js,.jsx --max-warnings 0 2>&1 || true',
          {
            encoding: 'utf-8',
            timeout: 30000,
            cwd,
          },
        ).trim()
      } catch {
        lintOutput = '(ESLint not configured or not found)'
      }
    } else {
      lintOutput = '(No package.json found — not a Node.js project)'
    }

    const lines = lintOutput.split('\n').slice(0, 40)
    const truncated = lines.length >= 40 ? lines.join('\n') + '\n... (truncated)' : lines.join('\n')

    return {
      content: [
        t('commands.lint.title'),
        '',
        truncated || '(no issues found)',
        '',
        hasPackageJson ? t('commands.lint.fix_hint') : t('commands.lint.setup_hint'),
      ].join('\n'),
    }
  } catch {
    return { content: t('commands.lint.error') }
  }
}

// ═══════════════════════════════════════════════════════════════
// Session Enhancement Commands (Claude Code parity)
// ═══════════════════════════════════════════════════════════════

const filesCmd: CommandHandler = async (ctx) => {
  const t = resolveT(ctx)
  const { readdirSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const cwd = process.cwd()

  try {
    const entries = readdirSync(cwd, { withFileTypes: true })
    const items = entries
      .filter((e) => !e.name.startsWith('.') || e.name === '.mipham' || e.name === '.mcp.json')
      .slice(0, 40)
      .map((e) => {
        const icon = e.isDirectory() ? '📁' : '📄'
        try {
          const stat = statSync(join(cwd, e.name))
          const size = stat.isFile() ? ` ${(stat.size / 1024).toFixed(1)}KB` : ''
          return `  ${icon} ${e.name}${size}`
        } catch {
          return `  ${icon} ${e.name}`
        }
      })

    return {
      content: [
        t('commands.files.title'),
        '',
        t('commands.files.cwd', { path: cwd }),
        '',
        ...items,
        entries.length > 40
          ? t('commands.files.more_files', { count: String(entries.length - 40) })
          : '',
        '',
        t('commands.files.hint'),
      ].join('\n'),
    }
  } catch {
    return { content: t('commands.files.error') }
  }
}

const statsCmd: CommandHandler = (ctx) => {
  const t = resolveT(ctx)
  const c = ctx.engine.getContext()
  const msgs = c.getMessages()
  const tokens = c.getEstimatedTokens()
  const tools = ctx.engine.getTools()

  const userMsgs = msgs.filter((m) => m.role === 'user').length
  const assistantMsgs = msgs.filter((m) => m.role === 'assistant').length
  const systemMsgs = msgs.filter((m) => m.role === 'system').length

  const base = [
    t('commands.stats.title'),
    '',
    t('commands.stats.messages', {
      total: String(msgs.length),
      user: String(userMsgs),
      assistant: String(assistantMsgs),
      system: String(systemMsgs),
    }),
    t('commands.stats.tokens', { tokens: tokens.toLocaleString() }),
    t('commands.stats.tools', { count: String(tools.size) }),
    t('commands.stats.provider', { provider: ctx.providerId }),
    t('commands.stats.model', { model: ctx.modelId }),
    t('commands.stats.permission', { permission: ctx.config.permission }),
    '',
    t('commands.stats.usage', { pct: ((tokens / 200_000) * 100).toFixed(1) }),
  ]

  // ── CRSI & SIS extensions ──
  const engine = ctx.engine
  const extras: string[] = []

  try {
    const db = engine.getErrorSignatureDB?.()
    if (db) {
      const s = db.getStats()
      if (s.total > 0) {
        extras.push(
          '',
          '── SIS Self-Immune ──',
          `Signatures: ${s.total} total, ${s.active} active | Success rate: ${(s.avgSuccessRate * 100).toFixed(0)}%`,
        )
      }
    }
  } catch {
    /* SIS not initialized */
  }

  try {
    const autoMemory = engine.getAutoMemory?.()
    if (autoMemory) {
      const count = autoMemory.sessionReflectionCount ?? 0
      if (count > 0) extras.push(`CRSI Reflections: ${count} turn(s) analyzed`)
    }
  } catch {
    /* CRSI not initialized */
  }

  try {
    const meta = engine.getMetaRuleEngine?.()
    if (meta) {
      const analysis = meta.analyze()
      if (analysis.systemHealth) {
        extras.push(
          `System Health: ${analysis.systemHealth.score}/100 — ${analysis.systemHealth.assessment}`,
        )
      }
    }
  } catch {
    /* Meta not initialized */
  }

  return { content: [...base, ...extras].join('\n') }
}

const summaryCmd: CommandHandler = (ctx) => {
  const t = resolveT(ctx)
  const c = ctx.engine.getContext()
  const msgs = c.getMessages()

  if (msgs.length === 0) {
    return { content: t('commands.summary.no_conversation') }
  }

  const userMsgs = msgs
    .filter((m) => m.role === 'user' && typeof m.content === 'string')
    .slice(0, 5)
    .map((m) => {
      const text = typeof m.content === 'string' ? m.content : ''
      return text.length > 100 ? text.slice(0, 100) + '...' : text
    })

  return {
    content: [
      t('commands.summary.title'),
      '',
      t('commands.summary.total_messages', { count: String(msgs.length) }),
      t('commands.summary.est_tokens', { tokens: c.getEstimatedTokens().toLocaleString() }),
      '',
      t('commands.summary.recent_topics'),
      ...userMsgs.map((t, i) => `  ${i + 1}. ${t}`),
      '',
      t('commands.summary.footer'),
    ].join('\n'),
  }
}

const cdCmd: CommandHandler = async (ctx, args) => {
  const t = resolveT(ctx)
  const target = args[0]
  if (!target) {
    return { content: t('commands.cd.usage', { cwd: process.cwd() }) }
  }

  const { existsSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const resolved = resolve(target.replace(/^~/, process.env.HOME || '~'))

  if (!existsSync(resolved)) {
    const suggestions = suggestDirectories(resolved)
    let content = t('commands.cd.not_found', { path: resolved })
    if (suggestions.length > 0) {
      content += `\n\n${t('commands.cd.suggestions')}\n${suggestions.map((s) => `  ${s}`).join('\n')}`
    }
    return { content }
  }

  try {
    process.chdir(resolved)

    try {
      const { SessionStore } = await import('../core/session-store')
      const saved = SessionStore.load(ctx.sessionId)
      if (saved) {
        const log = ctx.engine.getContext().getLog()
        if (log) {
          SessionStore.saveLog(ctx.sessionId, log, {
            provider: saved.metadata.provider,
            model: saved.metadata.model,
            cwd: resolved,
          })
        } else {
          SessionStore.save(ctx.sessionId, saved.messages, {
            provider: saved.metadata.provider,
            model: saved.metadata.model,
            cwd: resolved,
          })
        }
      }
    } catch {
      /* session persistence is best-effort */
    }

    return { content: t('commands.cd.content', { path: resolved }) }
  } catch (err) {
    return { content: t('commands.cd.failed', { error: (err as Error).message }) }
  }
}

const hooksCmd: CommandHandler = async (ctx) => {
  const t = resolveT(ctx)
  const { loadSettingsJson } = await import('../config/loader')
  const settingsJson = loadSettingsJson(process.cwd())

  const hooks = settingsJson.hooks as Record<
    string,
    Array<{ matcher?: string; hooks: Array<{ type: string; command?: string }> }>
  >

  const configured = Object.entries(hooks).filter(
    ([, entries]) => Array.isArray(entries) && entries.length > 0,
  )

  if (configured.length === 0) {
    return { content: t('commands.hooks.no_hooks') }
  }

  const lines: string[] = [
    t('commands.hooks.title'),
    '',
    t('commands.hooks.location', { path: '.mipham/settings.json' }),
    '',
  ]

  let count = 0
  for (const [eventName, entries] of configured) {
    for (const entry of entries) {
      for (const hook of entry.hooks) {
        count++
        const matcher = entry.matcher || '*'
        const cmd = hook.type === 'command' && hook.command ? hook.command : hook.type
        lines.push(`  ${eventName} [${matcher}] → ${cmd}`)
      }
    }
  }

  lines.push('')
  lines.push(t('commands.hooks.found', { count: String(count) }))
  return { content: lines.join('\n') }
}

const hooksHealthCmd: CommandHandler = (ctx) => {
  const hookEngine = ctx.engine.getHookEngine?.()
  if (!hookEngine) {
    return { content: 'Hook engine not available.' }
  }

  const health = hookEngine.getHookHealth()
  if (health.length === 0) {
    return { content: '✅ All hooks are healthy — no failures recorded.' }
  }

  const lines: string[] = ['## 🪝 Hook Health Status', '']
  for (const { key, health: h } of health) {
    const status = h.disabled ? '🔴 DISABLED' : h.failures > 0 ? '🟡 DEGRADED' : '🟢 HEALTHY'
    lines.push(`### ${status} \`${key}\``)
    lines.push(`| 连续失败 | ${h.failures} (threshold: 5) |`)
    lines.push(`| 总失败次数 | ${h.totalFailures} |`)
    if (h.disabled) {
      const remaining = Math.max(0, 5 - (Date.now() - h.disabledAt) / 60_000)
      lines.push(`| 自动恢复 | ${remaining.toFixed(0)} min remaining |`)
      lines.push('')
      lines.push(`Use \`/hooks enable "${key}"\` to re-enable manually.`)
    }
    lines.push('')
  }
  return { content: lines.join('\n') }
}

const hooksEnableCmd: CommandHandler = (ctx, args) => {
  const hookEngine = ctx.engine.getHookEngine?.()
  if (!hookEngine) return { content: 'Hook engine not available.' }
  const keyArg = args[0]?.trim().replace(/"/g, '')
  if (!keyArg) {
    return { content: 'Usage: /hooks enable "<hook-key>"\n\nUse /hooks health to see hook keys.' }
  }
  return hookEngine.reEnableHook(keyArg)
    ? { content: `✅ Hook "${keyArg}" re-enabled.` }
    : { content: `Hook "${keyArg}" not found or not disabled. Use /hooks health to check status.` }
}

const batchCmd: CommandHandler = async (ctx) => {
  const t = resolveT(ctx)
  return { content: t('commands.batch.title') }
}

// ═══════════════════════════════════════════════════════════════
// Export
// ═══════════════════════════════════════════════════════════════

const exportCmd: CommandHandler = async (ctx) => {
  const t = resolveT(ctx)
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')

  const cwd = process.cwd()
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const filename = `mipham-export-${timestamp}.md`
  const filepath = join(cwd, filename)

  const msgs = ctx.engine.getContext().getMessages()
  const lines: string[] = [
    `# Mipham Code — Session Export`,
    `> ${new Date().toISOString()}`,
    `> Provider: ${ctx.providerId} / ${ctx.modelId}`,
    '',
    '---',
    '',
  ]

  for (const msg of msgs) {
    const roleLabel =
      msg.role === 'user' ? '🧑 User' : msg.role === 'assistant' ? '🤖 Mipham Code' : '⚠ System'
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
    lines.push(`### ${roleLabel}`)
    lines.push('')
    lines.push(content)
    lines.push('')
  }

  writeFileSync(filepath, lines.join('\n'), 'utf-8')
  return {
    content: t('commands.export.confirmed', {
      path: filepath,
      count: String(msgs.length),
      lines: String(lines.length),
    }),
    copyContent: filepath,
  }
}

// ═══════════════════════════════════════════════════════════════
// Review — alias for /code-review (P1: 2026-08-06 polish)
// ═══════════════════════════════════════════════════════════════

const reviewCmd = codeReviewCmd

// ═══════════════════════════════════════════════════════════════
// PR Comments
// ═══════════════════════════════════════════════════════════════

const prCommentsCmd: CommandHandler = async () => {
  try {
    const { execSync } = await import('node:child_process')

    // Get branch info
    const branch = execSync('git branch --show-current', {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim()
    const mainBranch =
      execSync('git remote show origin 2>/dev/null | grep "HEAD branch" | cut -d: -f2', {
        encoding: 'utf-8',
        timeout: 3000,
      }).trim() || 'main'

    // Get diff stats vs main
    const diffStat = execSync(
      `git diff --stat origin/${mainBranch}...HEAD 2>/dev/null || git diff --stat ${mainBranch}...HEAD 2>/dev/null || echo "(no remote tracking)"`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim()
    const commits = execSync(
      `git log --oneline origin/${mainBranch}..HEAD 2>/dev/null || git log --oneline ${mainBranch}..HEAD 2>/dev/null || echo "(no commits ahead)"`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim()

    const lines: string[] = [
      '─ PR Review ─',
      '',
      `Branch:       ${branch}`,
      `Base:         ${mainBranch}`,
      `Commits ahead: ${commits.split('\n').filter(Boolean).length}`,
      '',
    ]

    if (commits && commits !== '(no commits ahead)') {
      lines.push('Commits:')
      for (const c of commits.split('\n')) lines.push(`  ${c}`)
      lines.push('')
    }

    if (diffStat && diffStat !== '(no remote tracking)') {
      lines.push('Changed files:')
      lines.push(diffStat)
      lines.push('')
    }

    lines.push(
      'To generate PR description: type "write a PR description for these changes" in chat.',
    )
    lines.push('To review PR: type "review this PR" or use /review.')

    return { content: lines.join('\n') }
  } catch {
    return {
      content:
        '─ PR Review ─\n\nCould not determine PR context. Are you in a git repository with a remote?',
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Resume
// ═══════════════════════════════════════════════════════════════

const resumeLastCmd: CommandHandler = async (ctx) => {
  const t = resolveT(ctx)
  const { SessionStore } = await import('../core/session-store')

  const latest = SessionStore.getLatest()
  if (!latest) {
    return {
      content: `${t('commands.resume.restored')}\n\n${t('commands.resume.no_sessions')}\n\n${t('commands.resume.empty_footer')}`,
    }
  }

  const session = SessionStore.load(latest.name)
  if (!session) {
    return {
      content: `${t('commands.resume.load_failed')}\n\nCould not load session "${latest.name}". The file may have been removed.`,
    }
  }

  const MAX_RESUME = 30
  const truncated = session.messages.length > MAX_RESUME
  const messages = truncated ? session.messages.slice(-MAX_RESUME) : session.messages

  const date = new Date(latest.updatedAt).toLocaleString()
  const truncatedStr = truncated ? ` (showing last ${MAX_RESUME})` : ''

  return {
    content: [
      t('commands.resume.restored'),
      '',
      t('commands.resume.restored_content', {
        name: latest.name,
        total: String(session.messages.length),
        truncated: truncatedStr,
        provider: latest.provider,
        model: latest.model,
        date,
      }),
      '',
      truncated
        ? t('commands.resume.restored_footer', {
            loaded: String(messages.length),
            total: String(session.messages.length),
          })
        : t('commands.resume.restored_full_footer', { loaded: String(messages.length) }),
    ].join('\n'),
    forwardedMessages: messages,
    resumeWarning: true,
  }
}

const resumeDeleteCmd: CommandHandler = async (ctx, args) => {
  const t = resolveT(ctx)
  const name = args.join(' ').trim()
  if (!name) {
    return { content: t('commands.resume.delete_usage') }
  }

  const { SessionStore } = await import('../core/session-store')
  const deleted = SessionStore.delete(name)

  return deleted
    ? { content: t('commands.resume.delete_confirmed', { name }) }
    : { content: t('commands.resume.delete_not_found', { name }) }
}

const resumeCmd: CommandHandler = async (ctx, args) => {
  const t = resolveT(ctx)
  const sub = args[0]?.toLowerCase()

  if (sub === 'last') {
    return resumeLastCmd(ctx, args.slice(1))
  }

  if (sub === 'delete') {
    return resumeDeleteCmd(ctx, args.slice(1))
  }

  const { SessionStore } = await import('../core/session-store')

  const targetName = args.join(' ')
  if (targetName) {
    const session = SessionStore.load(targetName)
    if (session) {
      return {
        content: `${t('commands.resume.found_title')}\n\n${t('commands.resume.found_content', { name: session.metadata.name, messages: String(session.metadata.messageCount), provider: session.metadata.provider, model: session.metadata.model, updated: session.metadata.updatedAt, target: targetName })}`,
      }
    }
    return {
      content: `${t('commands.resume.not_found_title')}\n\n${t('commands.resume.not_found_content', { name: targetName })}`,
    }
  }

  const sessions = SessionStore.list()

  if (sessions.length === 0) {
    return {
      content: `${t('commands.resume.restored')}\n\n${t('commands.resume.no_sessions')}\n\n${t('commands.resume.empty_footer')}`,
    }
  }

  const recent = sessions.slice(0, 10)

  const lines: string[] = [
    t('commands.resume.saved_title'),
    '',
    ...recent.map(
      (s, i) =>
        `  ${(i + 1).toString().padStart(2)}. ${s.name.padEnd(45)} ${s.messageCount.toString().padStart(4)} msgs  ${new Date(s.updatedAt).toLocaleString()}`,
    ),
    '',
    t('commands.resume.total_footer', { count: String(sessions.length) }),
    '',
    t('commands.resume.resume_hint'),
    t('commands.resume.resume_last_hint'),
    t('commands.resume.delete_hint'),
    t('commands.resume.cli_hint'),
    '',
    t('commands.resume.auto_save_hint'),
  ]

  return { content: lines.join('\n') }
}

// ═══════════════════════════════════════════════════════════════
// Wiki Save
// ═══════════════════════════════════════════════════════════════

const saveCmd: CommandHandler = (ctx, args) => {
  const t = resolveT(ctx)
  const target = args.join(' ').trim()
  const override = target
    ? `\nUser override: "${target}". If it names a note type (synthesis/concept/source/decision/session), file under that type; otherwise treat it as the note title.`
    : ''
  return {
    content: t('commands.save.content'),
    forwardToAI: `Invoke the save-to-wiki skill (use the Skill tool) to save this conversation into the Obsidian wiki.${override}`,
  }
}

// ═══════════════════════════════════════════════════════════════
// Memory Management
// ═══════════════════════════════════════════════════════════════

const memoryCmd: CommandHandler = async (ctx, args) => {
  const t = resolveT(ctx)
  const { existsSync, readdirSync, readFileSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')

  const home = process.env.HOME || '~'
  const memoryDir = join(home, '.mipham', 'memory')

  // /memory gc — 记忆卫生：归档「0 召回 + 过期」的 auto-* 记忆（手写只报告）
  if (args[0]?.toLowerCase() === 'gc') {
    const mm = getMemoryManager()
    const { archived, candidates } = mm.gc()
    const lines: string[] = [t('commands.memories.gc_title'), '']
    if (archived.length === 0 && candidates.length === 0) {
      lines.push(t('commands.memories.gc_none'))
    } else {
      if (archived.length > 0) {
        lines.push(t('commands.memories.gc_archived', { count: String(archived.length) }))
        lines.push(...archived.map((n) => `  - ${n}`))
        lines.push('')
      }
      if (candidates.length > 0) {
        lines.push(t('commands.memories.gc_candidates', { count: String(candidates.length) }))
        lines.push(...candidates.map((n) => `  - ${n}`))
        lines.push('')
      }
      lines.push(t('commands.memories.gc_done'))
    }
    return { content: lines.join('\n') }
  }

  // /memory consolidate — 会话记忆合并：把 auto-* 聚簇成持久化 lesson-*
  if (args[0]?.toLowerCase() === 'consolidate') {
    const mm = getMemoryManager()
    const { merged, removed } = mm.consolidateAutoMemories()
    const lines: string[] = [t('commands.memories.consolidate_title'), '']
    if (removed === 0) {
      lines.push(t('commands.memories.consolidate_none'))
    } else {
      lines.push(
        t('commands.memories.consolidate_result', {
          removed: String(removed),
          merged: String(merged),
        }),
      )
    }
    return { content: lines.join('\n') }
  }

  // /memory dedup — 只读近重复报告：列出 TF-IDF 余弦 > 阈值的近重复对，用户决定是否合并
  if (args[0]?.toLowerCase() === 'dedup') {
    const mm = getMemoryManager()
    const pairs = mm.listNearDuplicates()
    const lines: string[] = [t('commands.memories.dedup_title'), '']
    if (pairs.length === 0) {
      lines.push(t('commands.memories.dedup_none'))
    } else {
      for (const { a, b, similarity } of pairs) {
        lines.push(`  ${a} ↔ ${b}  (${(similarity * 100).toFixed(0)}%)`)
      }
      lines.push('')
      lines.push(t('commands.memories.dedup_footer'))
    }
    return { content: lines.join('\n') }
  }

  if (!existsSync(memoryDir)) {
    return { content: t('commands.memories.no_memories') }
  }

  try {
    const files = readdirSync(memoryDir).filter((f) => f.endsWith('.md'))
    if (files.length === 0) {
      return { content: t('commands.memories.empty') }
    }

    const memories: Array<{ file: string; size: number; mtime: Date; title: string }> = []
    for (const f of files) {
      const p = join(memoryDir, f)
      const stat = statSync(p)
      let title = f
      try {
        const content = readFileSync(p, 'utf-8')
        const match = content.match(/^#\s+(.+)$/m)
        if (match) title = match[1]!
      } catch {
        /* use filename */
      }
      memories.push({ file: f, size: stat.size, mtime: stat.mtime, title })
    }

    memories.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

    const lines: string[] = [
      t('commands.memories.title'),
      '',
      t('commands.memories.location', { path: memoryDir }),
      t('commands.memories.total', {
        count: String(memories.length),
        plural: memories.length === 1 ? 'y' : 'ies',
      }),
      '',
      ...memories.map(
        (m, i) =>
          `  ${(i + 1).toString().padStart(2)}. ${m.file.padEnd(35)} ${(m.size / 1024).toFixed(1)}KB  ${m.mtime.toLocaleDateString()}  ${m.title}`,
      ),
      '',
      t('commands.memories.footer'),
    ]

    return { content: lines.join('\n') }
  } catch {
    return { content: t('commands.memories.error') }
  }
}

// ═══════════════════════════════════════════════════════════════
// Upgrade
// ═══════════════════════════════════════════════════════════════

const upgradeCmd: CommandHandler = async (ctx) => {
  const t = resolveT(ctx)
  const { checkForUpdates, backupConfig, performUpdate, restoreConfig, getConfigPath } =
    await import('../shared/update')

  const update = checkForUpdates()

  if (!update.available) {
    return {
      content: t('commands.upgrade.uptodate', { current: update.current, latest: update.latest }),
    }
  }

  const backupPath = backupConfig(`upgrade-v${update.current}`)

  const lines: string[] = [
    t('commands.upgrade.title'),
    '',
    t('commands.upgrade.available', { current: update.current, latest: update.latest }),
    '',
  ]

  if (backupPath) {
    lines.push(`Config backed up to: ${backupPath}`)
  }

  const ok = performUpdate(update.latest)

  if (ok) {
    const configPath = getConfigPath()
    const { existsSync } = await import('node:fs')
    ctx.setUpdateStatus({ state: 'installed', latest: update.latest })
    lines.push('')
    lines.push(t('commands.upgrade.updated', { version: update.latest }))

    if (existsSync(configPath)) {
      lines.push(t('commands.upgrade.config_preserved', { path: configPath }))
    } else if (backupPath) {
      if (restoreConfig(backupPath)) {
        lines.push(t('commands.upgrade.config_restored'))
      }
    }

    lines.push('')
    lines.push(t('commands.upgrade.old_version_warning'))
  } else {
    lines.push('')
    lines.push(
      t('commands.upgrade.update_failed', { command: NPM_UPDATE_COMMAND, path: backupPath || '' }),
    )
  }

  return { content: lines.join('\n') }
}

// ═══════════════════════════════════════════════════════════════
// Language — i18n locale control
// ═══════════════════════════════════════════════════════════════

const langCmd: CommandHandler = (ctx, args) => {
  const t = resolveT(ctx)
  const requested = args[0]
  if (!requested || !['en-US', 'zh-CN'].includes(requested)) {
    return { content: t('commands.lang.current', { locale: 'en-US' }) }
  }
  return { content: t('commands.lang.set', { locale: requested }) }
}

// ═══════════════════════════════════════════════════════════════
// No-Plan — exit plan mode
// ═══════════════════════════════════════════════════════════════

const noPlanCmd: CommandHandler = (ctx) => {
  const t = resolveT(ctx)
  return { content: t('commands.no_plan.confirmed') }
}

// ═══════════════════════════════════════════════════════════════
// Workflows
// ═══════════════════════════════════════════════════════════════

const workflowsCmd: CommandHandler = async () => {
  const { existsSync, readdirSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')

  const locations = [
    join(process.cwd(), '.claude', 'workflows'),
    join(process.env.HOME || '~', '.claude', 'workflows'),
  ]

  const lines: string[] = ['─ Workflows ─', '']
  let found = 0

  for (const loc of locations) {
    if (!existsSync(loc)) continue
    try {
      const items = readdirSync(loc).filter((f) => f.endsWith('.js') || f.endsWith('.ts'))
      if (items.length === 0) continue

      lines.push(`📍 ${loc}`)
      for (const item of items) {
        const path = join(loc, item)
        try {
          const content = readFileSync(path, 'utf-8')
          const metaMatch = content.match(
            /export const meta\s*=\s*\{[^}]*name:\s*['"]([^'"]+)['"][^}]*description:\s*['"]([^'"]+)['"]/,
          )
          if (metaMatch) {
            lines.push(`  • ${item} — "${metaMatch[1]}" — ${metaMatch[2]}`)
          } else {
            lines.push(`  • ${item}`)
          }
        } catch {
          lines.push(`  • ${item}`)
        }
        found++
      }
    } catch {
      /* skip */
    }
  }

  if (found === 0) {
    lines.push('No workflow scripts found.')
    lines.push('')
    lines.push('Workflows are multi-agent orchestration scripts stored in:')
    lines.push('  .claude/workflows/   (project-level)')
    lines.push('  ~/.claude/workflows/ (user-level)')
    lines.push('')
    lines.push('Create a .js file in either location to add a workflow.')
  } else {
    lines.push('')
    lines.push(`${found} workflow(s) found.`)
    lines.push('Use /workflows <name> to run a specific workflow.')
  }

  return { content: lines.join('\n') }
}

// ═══════════════════════════════════════════════════════════════
// /workflow <task> — auto-generate + execute
// ═══════════════════════════════════════════════════════════════

const workflowSaveCmd = async (name: string): Promise<CommandResult> => {
  const { existsSync, mkdirSync, writeFileSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')

  const targetDir = join(process.cwd(), '.claude', 'workflows')
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }

  // Read the last-run state persisted by the Workflow tool
  const stateFile = join(targetDir, '.last-run.json')
  if (!existsSync(stateFile)) {
    return { content: 'No recent workflow run found. Run a workflow first with /workflow <task>.' }
  }

  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf-8'))
    const script = state.script as string
    if (!script) {
      return { content: 'No script found in last run state.' }
    }

    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '-')
    const scriptPath = join(targetDir, `${safeName}.js`)
    writeFileSync(scriptPath, script, 'utf-8')

    return {
      content: `Workflow saved to ${scriptPath}\nUse /workflow run ${safeName} to run it again.`,
    }
  } catch (err) {
    return { content: `Failed to save workflow: ${String(err)}` }
  }
}

const workflowRunCmd = async (name: string): Promise<CommandResult> => {
  const { existsSync } = await import('node:fs')
  const { join } = await import('node:path')

  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '-')

  const locations = [
    join(process.cwd(), '.claude', 'workflows'),
    join(process.env.HOME || '~', '.claude', 'workflows'),
  ]

  for (const loc of locations) {
    const scriptPath = join(loc, `${safeName}.js`)
    if (existsSync(scriptPath)) {
      return {
        content: '',
        forwardToAI:
          `Read the workflow script at ${scriptPath}, then call the Workflow tool with ` +
          `the file contents as the "script" parameter to execute it. Report the results.`,
      }
    }
  }

  return {
    content: `Workflow "${safeName}" not found in .claude/workflows/ or ~/.claude/workflows/`,
  }
}

const workflowAutoCmd: CommandHandler = async (_ctx, args) => {
  const task = args.join(' ').trim()

  if (!task) {
    return {
      content:
        'Usage: /workflow <task description>\n\n' +
        'Describes the task, and the AI will generate a workflow script to execute it.\n' +
        'Examples:\n' +
        '  /workflow audit all routes for missing auth\n' +
        '  /workflow research the impact of React 19 on our codebase\n' +
        '  /workflow find all hardcoded credentials in the codebase\n\n' +
        'Sub-commands:\n' +
        '  /workflow save <name>  — save last successful workflow script\n' +
        '  /workflow run <name>    — run a saved workflow by name\n' +
        '  /workflows              — list all saved workflow scripts',
    }
  }

  // Sub-commands
  const firstArg = args[0] || ''
  if (firstArg === 'save' && args[1]) {
    return workflowSaveCmd(args.slice(1).join(' '))
  }
  if (firstArg === 'run' && args[1]) {
    return workflowRunCmd(args.slice(1).join(' '))
  }

  // Default: forward to AI to generate + execute workflow
  return {
    content: '',
    forwardToAI:
      `Write and execute a workflow script for this task: ${task}\n\n` +
      `Use the Workflow tool to execute the generated script. ` +
      `After the workflow completes, summarize the results and offer to save the script ` +
      `with /workflow save <name> if it is reusable.`,
  }
}

// ═══════════════════════════════════════════════════════════════
// /deep-research <topic> — multi-agent deep research pipeline
// ═══════════════════════════════════════════════════════════════

const deepResearchCmd: CommandHandler = (_ctx, args) => {
  const topic = args.join(' ').trim()
  if (!topic) {
    return {
      content: stripIndent`
        Usage: /deep-research <topic>

        Conducts multi-agent deep research — 5-angle parallel search, adversarial verification,
        and top-tier synthesis into a well-cited report.

        Example:
          /deep-research impact of quantum computing on cryptography
          /deep-research latest advances in CRISPR gene editing
      `,
    }
  }
  return {
    content: stripIndent`
      ── Deep Research ──

      Topic: "${topic}"

      Orchestrating multi-agent research pipeline:
        1. Scope — 5 research angles
        2. Research — parallel web searches
        3. Reduce — deduplicate + merge
        4. Verify — adversarial skeptic pass
        5. Synthesize — cited report, top model

      This may take a few minutes...
    `,
    forwardToAI: stripIndent`
      Conduct deep research on: "${topic}"

      Use the Workflow tool to orchestrate a multi-agent research pipeline:

      **Phase 1 — Scope**: Define 5 research angles covering: overview, technical-details,
      competitors/alternatives, criticism/limitations, future-trends.

      **Phase 2 — Research**: Fan out parallel web searches across all 5 angles. Each agent
      searches the web and returns sources with titles, URLs, and key points. Use schema
      validation to ensure structured output.

      **Phase 3 — Reduce**: Deduplicate sources by URL. Merge overlapping findings. EDGE LOGIC
      IS FREE — use plain JavaScript, not agent calls.

      **Phase 4 — Verify**: Run adversarial verification (verify with mode: 'adversarial',
      skeptics: 2, threshold: 1) on each key claim. Discard claims that fail verification.

      **Phase 5 — Synthesize**: Use the best available model to synthesize all verified findings
      into a comprehensive, well-cited research report. Include:
      - Executive summary
      - Key findings with source citations (title, URL)
      - Competing perspectives and disagreements
      - Gaps and unknowns
      - Recommendations for further reading

      Output the final report as a structured markdown document with inline citations.
    `,
  }
}

// ═══════════════════════════════════════════════════════════════
// Permissions
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// Recommend — analyze project and recommend setup (like Claude Code
// automation recommender)
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// Setup — guided project initialization (mirrors Claude Code /setup)
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// Theme — display theme toggle
// ═══════════════════════════════════════════════════════════════

const mcpCmd: CommandHandler = async (ctx, args) => {
  const client = McpClient.getInstance()
  const sub = args[0]?.toLowerCase()

  // /mcp connect <name>
  if (sub === 'connect') {
    const name = args[1]
    if (!name) return { content: 'Usage: /mcp connect <server-name>' }
    const mcpServers = ctx.config.skills?.mcpServers ?? []
    const config = mcpServers.find((s) => s.name === name)
    if (!config) {
      return {
        content: `Server "${name}" not found in config.\n\nConfigured: ${mcpServers.map((s) => s.name).join(', ') || '(none)'}`,
      }
    }
    if (config.auth?.type === 'oauth') {
      return {
        content: [
          `── MCP Connect: ${name} (OAuth) ──`,
          '',
          'Starting OAuth PKCE flow...',
          `Authorization: ${config.auth.authorizationUrl}`,
          `Scopes: ${config.auth.scopes?.join(', ') || '(default)'}`,
        ].join('\n'),
        forwardToAI: `Connect to MCP server "${name}" using OAuth. Call McpClient.getInstance().connectWithOAuth() with the server config, then register its tools. Report the result.`,
      }
    }
    const via = config.url ? 'HTTP' : 'stdio'
    if (config.url) {
      const headerKeys = config.headers ? Object.keys(config.headers) : []
      const headerLine = headerKeys.length > 0 ? `\nHeaders to send: ${headerKeys.join(', ')}` : ''
      return {
        content: `── MCP Connect: ${name} ──\n\nConnecting via HTTP\nURL: ${config.url}${headerLine}\n\n⚠️ Verify the URL — any configured headers (e.g. Authorization) will be sent to this server.`,
        forwardToAI: `Connect to MCP server "${name}" using McpClient.getInstance().connect(config), then register its tools. Report the result.`,
      }
    }
    return {
      content: `── MCP Connect: ${name} ──\n\nConnecting via ${via}...`,
      forwardToAI: `Connect to MCP server "${name}" using McpClient.getInstance().connect(config), then register its tools. Report the result.`,
    }
  }

  // /mcp disconnect <name>
  if (sub === 'disconnect') {
    const name = args[1]
    if (!name) return { content: 'Usage: /mcp disconnect <server-name>' }
    const tools = client.disconnect(name)
    return {
      content: [
        `── MCP Disconnect: ${name} ──`,
        '',
        tools.length > 0
          ? `Disconnected. ${tools.length} tool(s) removed.`
          : 'Disconnected (no tools were registered).',
      ].join('\n'),
    }
  }

  // /mcp reload
  if (sub === 'reload') {
    return {
      content: '── MCP Reload ──\n\nDisconnecting all and reconnecting...',
      forwardToAI:
        'Disconnect all MCP servers via McpClient.getInstance().closeAll(), then reconnect all configured servers. Report each status.',
    }
  }

  // /mcp (default status)
  const configuredServers = ctx.config.skills?.mcpServers ?? []
  const liveConnections = client.listConnections()

  const lines: string[] = ['── MCP Servers ──', '']

  if (configuredServers.length > 0) {
    lines.push(`Configured servers (${configuredServers.length}):`)
    lines.push('')
    for (const s of configuredServers) {
      const live = liveConnections.find((c) => c.config.name === s.name)
      const statusIcon = live
        ? live.status === 'connected'
          ? '🟢'
          : live.status === 'connecting'
            ? '🟡'
            : live.status === 'error'
              ? '🔴'
              : '⚪'
        : '⚪'
      const statusLabel = live ? live.status : 'not started'
      const oauthTag = s.auth?.type === 'oauth' ? ' [OAuth]' : ''
      lines.push(`  ${statusIcon} ${s.name}${oauthTag}  [${statusLabel}]`)
      const transportInfo = s.url
        ? `URL: ${s.url}`
        : `Command: ${s.command ?? ''} ${(s.args ?? []).join(' ')}`
      lines.push(`     ${transportInfo}`)
      if (live?.tools && live.tools.length > 0) {
        lines.push(`     Tools: ${live.tools.length} registered`)
      }
      if (live?.error) lines.push(`     Error: ${live.error}`)
      lines.push('')
    }
  } else {
    lines.push('No MCP servers configured.')
  }

  lines.push('── Commands ──')
  lines.push('  /mcp connect <name>    Connect to a server (OAuth or stdio)')
  lines.push('  /mcp disconnect <name>  Disconnect from a server')
  lines.push('  /mcp reload            Disconnect all and reconnect')
  lines.push('')
  lines.push('── Protocol ──')
  lines.push('MCP stdio transport (JSON-RPC 2.0) — fully implemented.')
  lines.push('Learn more: https://modelcontextprotocol.io')

  return { content: lines.join('\n') }
}

// ═══════════════════════════════════════════════════════════════
// Phase 4 — Login / API Key Management
// ═══════════════════════════════════════════════════════════════

const loginCmd: CommandHandler = (ctx) => {
  const activeProviders = ctx.config.providers.filter((p) => p.status === 'active')

  // Map provider IDs to their expected env var names
  const providerEnvMap: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    google: 'GEMINI_API_KEY',
    qwen: 'QWEN_API_KEY',
    doubao: 'DOUBAO_API_KEY',
    hunyuan: 'HUNYUAN_API_KEY',
  }

  const lines: string[] = [
    '── Authentication ──',
    '',
    'Mipham Code uses API keys for authentication — no account login needed.',
    'Each provider requires its own API key, set via environment variable or config file.',
    '',
    '── Provider API Keys ──',
    '',
  ]

  for (const p of activeProviders) {
    const envVar = providerEnvMap[p.id] ?? `${p.id.toUpperCase()}_API_KEY`
    const isSet = typeof process !== 'undefined' && !!process.env[envVar]
    const icon = isSet ? '✅' : '⬜'
    lines.push(`  ${icon} ${p.id.padEnd(14)} $${envVar}${isSet ? ' (set)' : ''}`)
  }

  lines.push('')
  lines.push('── Setup ──')
  lines.push('')
  lines.push('  # Option 1: Environment variables (recommended)')
  lines.push('  export ANTHROPIC_API_KEY="sk-ant-..."')
  lines.push('  export OPENAI_API_KEY="sk-..."')
  lines.push('')
  lines.push('  # Option 2: Config file (~/.mipham/config.yml)')
  lines.push('  providers:')
  lines.push('    - id: anthropic')
  lines.push('      apiKey: $ANTHROPIC_API_KEY')
  lines.push('')
  lines.push('Current provider: ' + ctx.providerId + ' / ' + ctx.modelId)
  lines.push('')
  lines.push("Get API keys from each provider's developer console.")
  lines.push('Dashboard: https://mipham.ai/code/dashboard')

  return { content: lines.join('\n') }
}

// ═══════════════════════════════════════════════════════════════
// Phase 4 — Logout / Clear Credentials
// ═══════════════════════════════════════════════════════════════

const logoutCmd: CommandHandler = async () => {
  const { existsSync } = await import('node:fs')
  const { join } = await import('node:path')

  const home = process.env.HOME || '~'
  const userConfig = join(home, '.mipham', 'config.yml')
  const hasUserConfig = existsSync(userConfig)

  return {
    content: `── Sign Out ──

Mipham Code uses API keys (not sessions), so there is no persistent login to "log out" of.

To clear your credentials:

1. Unset environment variables (current session only):
     unset ANTHROPIC_API_KEY
     unset OPENAI_API_KEY
     unset DEEPSEEK_API_KEY
     # ... and others

2. Remove from shell profile (permanent):
     Edit ~/.zshrc or ~/.bashrc and remove the export lines.

3. User config: ${hasUserConfig ? '⚠  ~/.mipham/config.yml exists — check for stored keys' : '✅ ~/.mipham/config.yml not found (no stored keys)'}

Note: Clearing keys will prevent Mipham Code from making API calls
until you set them again with /login or manually.

To switch providers without clearing keys, use /switch <provider> <model>.`,
  }
}

// ═══════════════════════════════════════════════════════════════
// Phase 4 — Feedback
// ═══════════════════════════════════════════════════════════════

const feedbackCmd: CommandHandler = async (ctx, args) => {
  const message = args.join(' ').trim()

  const lines: string[] = ['── Feedback ──', '']

  // If a message was provided, save it to ~/.mipham/feedback/
  if (message) {
    try {
      const { writeFileSync, mkdirSync, existsSync } = await import('node:fs')
      const { join } = await import('node:path')
      const { homedir } = await import('node:os')

      const dir = join(homedir(), '.mipham', 'feedback')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const file = join(dir, `feedback-${ts}.md`)
      const content = [
        '---',
        `timestamp: ${new Date().toISOString()}`,
        `version: ${ctx.version}`,
        `session: ${ctx.sessionId}`,
        `provider: ${ctx.providerId}`,
        `model: ${ctx.modelId}`,
        '---',
        '',
        message,
      ].join('\n')
      writeFileSync(file, content, 'utf-8')

      lines.push('Your feedback:')
      lines.push('')
      lines.push('  """')
      for (const line of message.split('\n')) {
        lines.push('  ' + line)
      }
      lines.push('  """')
      lines.push('')
      lines.push(`✅ Saved to \`${file}\``)
      lines.push('')
    } catch (err) {
      lines.push(`⚠️ Save failed: ${String(err)}`)
      lines.push('')
    }
  }

  lines.push('── Feedback Channels ──')
  lines.push('')
  lines.push('  🐛 Bug Reports')
  lines.push('     GitHub Issues: https://github.com/One-Mipham/mipham-code/issues')
  lines.push('     Or run `/bug-report` to auto-generate a diagnostic report')
  lines.push('')
  lines.push('  💡 Feature Requests')
  lines.push('     GitHub Issues: https://github.com/One-Mipham/mipham-code/issues')
  lines.push('     Template:      Feature Request')
  lines.push('')
  lines.push('  📧 General Feedback')
  lines.push('     Email:         feedback@mipham.ai')
  lines.push('     Community:     https://github.com/One-Mipham/mipham-code/discussions')
  lines.push('')
  lines.push('── System Info (include with bug reports) ──')
  lines.push(`  Version:    v${ctx.version}`)
  lines.push(`  Provider:   ${ctx.providerId} / ${ctx.modelId}`)
  lines.push(`  Platform:   ${process.platform} ${process.arch}`)
  lines.push(
    `  Runtime:    ${typeof Bun !== 'undefined' ? 'Bun ' + Bun.version : 'Node.js ' + process.version}`,
  )
  lines.push(`  Node:       ${process.version}`)

  return { content: lines.join('\n') }
}

// ═══════════════════════════════════════════════════════════════
// Phase 4 — Agent Management
// ═══════════════════════════════════════════════════════════════

const agentsCmd: CommandHandler = (ctx) => {
  const agentViewManager = ctx.engine.getAgentViewManager?.()
  if (!agentViewManager) {
    return { content: 'Agent View dashboard is initializing...' }
  }
  const counts = agentViewManager.countByStatus()
  const total = counts['needs-input'] + counts.working + counts.completed + counts.failed

  if (total === 0) {
    return {
      content: `── Agent View ──

No background agents running.

Use /bg <prompt> to spawn a background agent session.

Example:
  /bg Fix all TypeScript errors in the project
  /bg Review the auth module for security issues

Or use the Agent tool in a conversation to launch a sub-agent.`,
    }
  }

  const lines: string[] = [
    '── Agent View ──',
    '',
    `  ${total} session(s):`,
    `  🟡 Needs input: ${counts['needs-input']}`,
    `  🔵 Working:     ${counts.working}`,
    `  🟢 Completed:   ${counts.completed}`,
    `  🔴 Failed:      ${counts.failed}`,
    '',
    'Sessions:',
  ]

  const all = agentViewManager.list()
  for (const s of all.slice(0, 10)) {
    const statusIcon: Record<string, string> = {
      'needs-input': '🟡',
      working: '🔵',
      completed: '🟢',
      failed: '🔴',
    }
    const elapsed =
      s.elapsedMs < 1000
        ? '<1s'
        : s.elapsedMs < 60000
          ? `${Math.floor(s.elapsedMs / 1000)}s`
          : `${Math.floor(s.elapsedMs / 60000)}m`
    lines.push(
      `  ${statusIcon[s.status] || '⚪'} ${s.id} · ${s.provider}/${s.model} · ${elapsed} · ${s.task.slice(0, 50)}`,
    )
  }

  if (total > 10) {
    lines.push(`  ... and ${total - 10} more`)
  }

  lines.push('', 'Run `mipham agents` for the full interactive dashboard with j/k navigation.')

  return { content: lines.join('\n') }
}

const bgCmd: CommandHandler = (ctx, args) => {
  const prompt = args.join(' ')
  if (!prompt.trim()) {
    return {
      content: `Usage: /bg <prompt>

Spawn a background agent to work on a task while you continue chatting.

Examples:
  /bg Run the full test suite and report failures
  /bg Audit the src/ directory for security issues
  /bg Generate API documentation from JSDoc comments

Background agents appear in the Agent View dashboard (/agents).`,
    }
  }

  const agentViewManager = ctx.engine.getAgentViewManager?.()
  if (!agentViewManager) {
    return { content: 'Agent View manager is initializing...' }
  }

  const session = agentViewManager.create(prompt, prompt, {
    provider: ctx.providerId,
    model: ctx.modelId,
  })

  agentViewManager.addMessage(session.id, { role: 'user', content: prompt })
  agentViewManager.updateStatus(session.id, 'working')

  return {
    content: `✓ Background agent spawned: ${session.id}

  Task:     ${session.task.slice(0, 80)}
  Provider: ${session.provider} / ${session.model}
  Status:   working

Use /agents to view all background sessions.
Run \`mipham agents\` for the interactive dashboard.`,
  }
}

// ═══════════════════════════════════════════════════════════════
// Artifacts
// ═══════════════════════════════════════════════════════════════

const forkCmd: CommandHandler = async (ctx, args) => {
  const prompt = args.join(' ')
  if (!prompt.trim()) {
    return {
      content: [
        'Usage: /fork <task description>',
        '',
        'Fork a task into an isolated worktree with auto commit/push.',
        '',
        'Workflow:',
        '  1. Creates a new git worktree on branch worktree/<slug>',
        '  2. Spawns a background agent to work on the task',
        '  3. Auto-commits changes with Co-Authored-By on completion',
        '  4. Auto-pushes to origin',
        '  5. Reports branch and worktree path in the result',
        '',
        'Examples:',
        '  /fork Refactor the auth module',
        '  /fork Add input validation to all API endpoints',
      ].join('\n'),
    }
  }

  const { execSync } = await import('node:child_process')
  const { join } = await import('node:path')

  try {
    execSync('git rev-parse --git-dir', { stdio: 'ignore' })
  } catch {
    return { content: '/fork requires a git repository.' }
  }

  const agentViewManager = ctx.engine.getAgentViewManager?.()
  if (!agentViewManager) {
    return { content: 'Agent View manager is initializing...' }
  }

  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  const name = `${slug}-${Date.now().toString(36)}`
  const branch = `worktree/${name}`
  const wtPath = join(process.cwd(), '.claude', 'worktrees', name)

  try {
    execSync(`git worktree add -b ${branch} ${wtPath} HEAD`, { stdio: 'ignore', timeout: 30_000 })
  } catch (err) {
    try {
      execSync(`git worktree remove --force ${wtPath}`, { stdio: 'ignore' })
    } catch {
      /* ok */
    }
    try {
      execSync(`git branch -D ${branch}`, { stdio: 'ignore' })
    } catch {
      /* ok */
    }
    return {
      content: `Worktree creation failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const session = agentViewManager.create(prompt, prompt, {
    provider: ctx.providerId,
    model: ctx.modelId,
  })
  agentViewManager.addMessage(session.id, { role: 'user', content: prompt })
  agentViewManager.updateStatus(session.id, 'working')
  session.worktree = wtPath
  session.branch = branch
  session.kind = 'forked'

  const bgReg = (await import('../agent/background-registry')).getBackgroundAgentRegistry()
  bgReg.spawn(
    prompt,
    'general',
    async (_signal) => {
      const { SubAgent } = await import('../agent/sub-agent')
      const sa = new SubAgent(
        ctx.engine.getRegistry(),
        ctx.engine.getTools(),
        ctx.engine.getPermission(),
        undefined,
        undefined,
        ctx.engine.getLlm(),
      )
      const parentContext = ctx.engine.getContext()
      const result = await sa.execute(prompt, 'fork: ' + prompt.slice(0, 60), {
        worktreePath: wtPath,
        inheritContext: { messages: parentContext.getMessages() },
      })
      try {
        const { execSync: ex } = await import('node:child_process')
        ex(`git -C ${wtPath} add -A`, { stdio: 'ignore', timeout: 10_000 })
        const st = ex(`git -C ${wtPath} status --porcelain`, { encoding: 'utf-8', timeout: 10_000 })
        if (st.trim()) {
          ex(`git -C ${wtPath} commit -m "feat: ${prompt.slice(0, 60)}\n\n${COAUTHOR_TRAILER}"`, {
            stdio: 'ignore',
            timeout: 10_000,
          })
          ex(`git push origin ${branch}`, { stdio: 'ignore', timeout: 30_000 })
        }
      } catch {
        /* best-effort */
      }
      return [
        `## Fork done: ${prompt}`,
        '',
        `Branch: \`${branch}\``,
        `Worktree: \`${wtPath}\``,
        '',
        result || '(no output)',
      ].join('\n')
    },
    'forked',
  )

  return {
    content: [
      `✓ Forked: ${session.id}`,
      `  Task: ${prompt.slice(0, 80)}`,
      `  Branch: ${branch}`,
      `  Worktree: ${wtPath}`,
      `  Status: working`,
      '',
      'Agent will auto-commit + push on completion.',
      'Use /agents to track.',
    ].join('\n'),
  }
}

async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import('node:child_process')
  // Use spawn with array args — no shell, no command injection
  const [cmd, ...args] =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url]
  spawn(cmd!, args, { detached: true, stdio: 'ignore' }).unref()
}

const artifactOpenCmd: CommandHandler = async (ctx, args) => {
  const name = args[0]
  if (!name) {
    return { content: 'Usage: /artifact open <name>\nExample: /artifact open dashboard' }
  }

  const sessionId = 'session-1' // default session
  const port = 9876
  const ext = name.endsWith('.svg') ? '' : '.html'
  const url = `http://localhost:${port}/${sessionId}/${name}${ext}`

  try {
    await openBrowser(url)
    return { content: `✓ Opening artifact "${name}" in browser...\n   ${url}` }
  } catch (err) {
    return { content: `✗ Failed to open browser: ${String(err)}\n   URL: ${url}` }
  }
}

const artifactListCmd: CommandHandler = async (_ctx, _args) => {
  const { getSessionArtifacts } = await import('../artifacts/manifest')
  const { join } = await import('node:path')
  const { ARTIFACTS_DIR } = await import('../shared/constants')

  const dir = join(process.cwd(), ARTIFACTS_DIR)
  const entries = getSessionArtifacts(dir, 'session-1')

  if (entries.length === 0) {
    return {
      content: 'No artifacts created yet. Ask the AI to generate one with the Artifact tool.',
    }
  }

  const lines = ['── Artifacts ──', '']
  for (const e of entries) {
    const ver = e.versions && e.versions.length > 1 ? ` v${e.versions.length}` : ''
    lines.push(
      `  ${e.name.padEnd(24)} ${(e.type + ver).padEnd(8)} ${(e.size / 1024).toFixed(1).padStart(8)}KB  ${e.createdAt.slice(0, 16).replace('T', ' ')}`,
    )
  }
  lines.push('', `  ${entries.length} artifact(s) — /artifact open <name> to view`)
  lines.push(`  Gallery: http://localhost:9876`)

  return { content: lines.join('\n') }
}

const artifactServerCmd: CommandHandler = async (_ctx, _args) => {
  const url = 'http://localhost:9876'
  return {
    content: `── Artifact Server ──\n\n  URL:  ${url}\n  Port: 9876\n\nArtifacts are served locally. No external network access.`,
  }
}

const artifactBaseCmd: CommandHandler = (ctx, args) => {
  const sub = args[0]
  if (sub === 'open') return artifactOpenCmd(ctx, args.slice(1))
  if (sub === 'list') return artifactListCmd(ctx, [])
  if (sub === 'server') return artifactServerCmd(ctx, [])
  return {
    content:
      'Usage: /artifact <open|list|server> [name]\n\n  /artifact open <name>  Open artifact in browser\n  /artifact list        List all artifacts\n  /artifact server      Show server status',
  }
}

// ═══════════════════════════════════════════════════════════════
// Remaining low-priority stubs (backend not yet available)
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// Commands — list all registered slash commands
// ═══════════════════════════════════════════════════════════════

const commandsListCmd: CommandHandler = () => {
  const names = getCommandNames()
  const categories: Record<string, string[]> = {
    'Session & Identity': [],
    History: [],
    'Model & Provider': [],
    'Tools & Skills': [],
    Plugins: [],
    Workflow: [],
    Project: [],
    Environment: [],
    Account: [],
    Agents: [],
    Artifacts: [],
    Other: [],
  }

  const catMap: Record<string, string> = {
    '/help': 'Session & Identity',
    '/version': 'Session & Identity',
    '/clear': 'Session & Identity',
    '/exit': 'Session & Identity',
    '/quit': 'Session & Identity',
    '/compact': 'Session & Identity',
    '/context': 'Session & Identity',
    '/status': 'Session & Identity',
    '/cost': 'Session & Identity',
    '/usage': 'Session & Identity',
    '/rename': 'Session & Identity',
    '/goal': 'Session & Identity',
    '/recap': 'Session & Identity',
    '/save': 'Session & Identity',
    '/export': 'Session & Identity',
    '/doctor': 'Session & Identity',
    '/dream': 'Session & Identity',
    '/constitution': 'Session & Identity',
    '/bug-report': 'Session & Identity',
    '/changelog': 'Session & Identity',
    '/resume': 'Session & Identity',
    '/resume last': 'Session & Identity',
    '/resume delete': 'Session & Identity',
    '/branch': 'Session & Identity',
    '/rewind': 'History',
    '/undo': 'History',
    '/copy': 'History',
    '/focus': 'History',
    '/ultracode': 'Workflow',
    '/pick': 'Model & Provider',
    '/model': 'Model & Provider',
    '/models': 'Model & Provider',
    '/ollama-refresh': 'Model & Provider',
    '/provider': 'Model & Provider',
    '/providers': 'Model & Provider',
    '/switch': 'Model & Provider',
    '/config': 'Model & Provider',
    '/fast': 'Model & Provider',
    '/effort': 'Model & Provider',
    '/theme': 'Model & Provider',
    '/upgrade': 'Model & Provider',
    '/tools': 'Tools & Skills',
    '/skills': 'Tools & Skills',
    '/reload-skills': 'Tools & Skills',
    '/browse-skills': 'Tools & Skills',
    '/install-skill': 'Tools & Skills',
    '/marketplace': 'Tools & Skills',
    '/browse-marketplace': 'Tools & Skills',
    '/remove-skill': 'Tools & Skills',
    '/mcp': 'Tools & Skills',
    '/plugins': 'Plugins',
    '/browse-plugins': 'Plugins',
    '/install-plugin': 'Plugins',
    '/remove-plugin': 'Plugins',
    '/plugin-enable': 'Plugins',
    '/plugin-disable': 'Plugins',
    '/commands': 'Tools & Skills',
    '/crsi rules': 'Tools & Skills',
    '/crsi disable': 'Tools & Skills',
    '/crsi analyze': 'Tools & Skills',
    '/crsi restore': 'Tools & Skills',
    '/crsi stats': 'Tools & Skills',
    '/crsi health': 'Tools & Skills',
    '/crsi inventory': 'Tools & Skills',
    '/crsi modify': 'Tools & Skills',
    '/crsi propose': 'Tools & Skills',
    '/crsi prose-clear': 'Tools & Skills',
    '/crsi eval': 'Tools & Skills',
    '/crsi bench': 'Tools & Skills',
    '/crsi meta': 'Tools & Skills',
    '/crsi interpret': 'Tools & Skills',
    '/crsi critique': 'Tools & Skills',
    '/crsi red-team': 'Tools & Skills',
    '/sis errors': 'Tools & Skills',
    '/sis stats': 'Tools & Skills',
    '/sis clear': 'Tools & Skills',
    '/plan': 'Workflow',
    '/no-plan': 'Workflow',
    '/tdd': 'Workflow',
    '/todos': 'Workflow',
    '/tasks': 'Workflow',
    '/review': 'Code Quality',
    '/pr-comments': 'Workflow',
    '/diff': 'Workflow',
    '/workflows': 'Workflow',
    '/workflow view': 'Workflow',
    '/workflow watch': 'Workflow',
    '/deep-research': 'Workflow',
    '/loop': 'Workflow',
    '/init': 'Project',
    '/setup': 'Project',
    '/permissions': 'Project',
    '/add-dir': 'Project',
    '/recommend': 'Project',
    '/security': 'Project',
    '/audit': 'Project',
    '/trust': 'Project',
    '/prompt-audit': 'Code Quality',
    '/ide': 'Environment',
    '/terminal-setup': 'Environment',
    '/memory': 'Environment',
    '/release-notes': 'Environment',
    '/login': 'Account',
    '/logout': 'Account',
    '/keys': 'Account',
    '/keys rotate': 'Account',
    '/keys audit': 'Account',
    '/keys view': 'Account',
    '/feedback': 'Account',
    '/agents': 'Agents',
    '/bg': 'Agents',
    '/fork': 'Agents',
    '/artifact': 'Artifacts',
    '/schedule': 'Other',
    '/commit': 'Workflow',
    '/push': 'Workflow',
    '/pr': 'Workflow',
    '/issue': 'Workflow',
    '/code-review': 'Code Quality',
    '/simplify': 'Code Quality',
    '/verify': 'Code Quality',
    '/design': 'Code Quality',
    '/lint': 'Code Quality',
    '/files': 'Session & Identity',
    '/stats': 'Session & Identity',
    '/summary': 'Session & Identity',
    '/cd': 'Session & Identity',
    '/hooks': 'Workflow',
    '/batch': 'Workflow',
  }

  for (const name of names) {
    const cat = catMap[name] ?? 'Other'
    categories[cat]?.push(name)
  }

  const lines: string[] = [`── All Slash Commands (${names.length}) ──`, '']

  for (const [cat, cmds] of Object.entries(categories)) {
    if (cmds.length === 0) continue
    lines.push(`── ${cat} (${cmds.length}) ──`)
    for (const c of cmds) {
      lines.push(`  ${c}`)
    }
    lines.push('')
  }

  lines.push('Type /help for details, or /<command> to run.')

  return { content: lines.join('\n') }
}

// ═══════════════════════════════════════════════════════════════
// Command Registry
// ═══════════════════════════════════════════════════════════════

const registry = new Map<string, CommandHandler>()

// Session
registry.set('/help', helpCmd)
const pickCmd: CommandHandler = (ctx) => ({
  content: `── Model Picker ──

Use ↑↓ to navigate, Enter to select, Esc to close.

Current: ${ctx.providerId} / ${ctx.modelId}
Available: ${ctx.config.providers.filter((p) => p.status === 'active').length} providers, ${ctx.config.providers.flatMap((p) => p.models.filter((m) => m.status === 'active')).length} models

Tip: Press Ctrl+P or type /pick from the chat input.`,
})
registry.set('/pick', pickCmd)
registry.set('/version', versionCmd)
registry.set('/clear', clearCmd)
registry.set('/exit', exitCmd)
registry.set('/quit', exitCmd)
registry.set('/compact', compactCmd)
registry.set('/context', contextCmd)
registry.set('/status', statusCmd)
registry.set('/cost', costCmd)
registry.set('/usage', usageCmd)
registry.set('/rename', renameCmd)
registry.set('/goal', goalCmd)
registry.set('/recap', recapCmd)

// History
registry.set('/rewind', rewindCmd)
registry.set('/undo', undoCmd)
registry.set('/copy', copyCmd)
registry.set('/focus', focusCmd)
registry.set('/ultracode', ultracodeCmd)

// Model & Provider
registry.set('/model', modelCmd)
registry.set('/models', modelsCmd)
registry.set('/ollama-refresh', ollamaRefreshCmd)
registry.set('/provider', providerCmd)
registry.set('/providers', providersCmd)
registry.set('/config', configCmd)
registry.set('/fast', fastCmd)
registry.set('/effort', effortCmd)
registry.set('/switch', switchCmd)

// Tools & Skills
registry.set('/tools', toolsCmd)
registry.set('/skills', skillsCmd)
registry.set('/reload-skills', reloadSkillsCmd)
registry.set('/browse-skills', browseSkillsCmd)
registry.set('/install-skill', installSkillCmd)
registry.set('/marketplace', marketplaceCmd)
registry.set('/browse-marketplace', browseMarketplaceCmd)
registry.set('/remove-skill', removeSkillCmd)
registry.set('/plugins', pluginsCmd)
registry.set('/browse-plugins', browsePluginsCmd)
registry.set('/install-plugin', installPluginCmd)
registry.set('/remove-plugin', removePluginCmd)
registry.set('/plugin-enable', pluginEnableCmd)
registry.set('/plugin-disable', pluginDisableCmd)
registry.set('/commands', commandsListCmd)
registry.set('/crsi rules', crsiRulesCmd)
registry.set('/crsi disable', crsiDisableCmd)
registry.set('/crsi analyze', crsiAnalyzeCmd)
registry.set('/crsi restore', crsiRestoreCmd)
registry.set('/crsi stats', crsiStatsCmd)
registry.set('/crsi health', crsiHealthCmd)
registry.set('/crsi inventory', crsiInventoryCmd)
registry.set('/crsi modify', crsiModifyCmd)
registry.set('/crsi propose', crsiProposeCmd)
registry.set('/crsi prose-clear', crsiProseClearCmd)
registry.set('/crsi eval', crsiEvalCmd)
registry.set('/crsi bench', crsiBenchCmd)
registry.set('/crsi meta', crsiMetaCmd)
registry.set('/crsi interpret', crsiInterpretCmd)
registry.set('/crsi critique', crsiCritiqueCmd)
registry.set('/crsi red-team', crsiRedTeamCmd)
registry.set('/sis errors', sisErrorsCmd)
registry.set('/sis stats', sisStatsCmd)
registry.set('/sis clear', sisClearCmd)
registry.set('/sis cleanup', sisCleanupCmd)
registry.set('/dream', dreamCmd)
registry.set('/constitution', constitutionCmd)
registry.set('/bug-report', bugReportCmd)
registry.set('/changelog', changelogCmd)

// Workflow
registry.set('/plan', planCmd)
registry.set('/tdd', tddCmd)
registry.set('/todos', todosCmd)
registry.set('/tasks', tasksCmd)
registry.set('/diff', diffCmd)
registry.set('/loop', loopCmd)
registry.set('/no-plan', noPlanCmd)
registry.set('/workflow', workflowAutoCmd)
registry.set('/workflows', workflowsCmd)
registry.set('/workflow view', workflowViewCmd)
registry.set('/workflow watch', workflowWatchCmd)
registry.set('/deep-research', deepResearchCmd)
registry.set('/review', reviewCmd)
registry.set('/pr-comments', prCommentsCmd)

// Session Management
registry.set('/doctor', doctorCmd)
registry.set('/fix', fixCmd)
registry.set('/export', exportCmd)
registry.set('/resume', resumeCmd)
registry.set('/resume last', resumeLastCmd)
registry.set('/resume delete', resumeDeleteCmd)
registry.set('/memory', memoryCmd)
registry.set('/save', saveCmd)
registry.set('/upgrade', upgradeCmd)

// Project
registry.set('/init', initCmd)
registry.set('/setup', setupCmd)
registry.set('/recommend', recommendCmd)
registry.set('/permissions', permissionsCmd)
registry.set('/add-dir', addDirCmd)
registry.set('/security', securityCmd)
registry.set('/audit', securityCmd)
registry.set('/trust', trustCmd)
registry.set('/prompt-audit', promptAuditCmd)

// Environment
registry.set('/theme', themeCmd)
registry.set('/lang', langCmd)
registry.set('/ide', ideCmd)
registry.set('/terminal-setup', terminalSetupCmd)
registry.set('/release-notes', releaseNotesCmd)

// Phase 4 — MCP, Auth, Feedback, Agents
registry.set('/mcp', mcpCmd)
registry.set('/login', loginCmd)
registry.set('/logout', logoutCmd)
registry.set('/keys', keysCmd)
registry.set('/keys rotate', keysCmd)
registry.set('/keys audit', keysCmd)
registry.set('/keys view', keysCmd)
registry.set('/feedback', feedbackCmd)
registry.set('/agents', agentsCmd)
registry.set('/bg', bgCmd)
registry.set('/fork', forkCmd)

// Artifacts
registry.set('/artifact', artifactBaseCmd)

// Lower-priority semi-stubs (WIP, backend pending)
registry.set('/branch', branchCmd)
registry.set('/schedule', scheduleCmd)

// GitHub & Git Workflow (Claude Code parity)
registry.set('/commit', commitCmd)
registry.set('/push', pushCmd)
registry.set('/pr', prCmd)
registry.set('/issue', issueCmd)

// Code Quality (Claude Code parity)
registry.set('/code-review', codeReviewCmd)
registry.set('/simplify', simplifyCmd)
registry.set('/verify', verifyCmd)
registry.set('/design', designCmd)
registry.set('/lint', lintCmd)

// Session Enhancement (Claude Code parity)
registry.set('/files', filesCmd)
registry.set('/stats', statsCmd)
registry.set('/summary', summaryCmd)
registry.set('/cd', cdCmd)
registry.set('/hooks', hooksCmd)
registry.set('/hooks health', hooksHealthCmd)
registry.set('/hooks enable', hooksEnableCmd)
registry.set('/batch', batchCmd)

// ═══════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════

export function getCommand(name: string): CommandHandler | undefined {
  return registry.get(name)
}

export function getCommandNames(): string[] {
  return Array.from(registry.keys()).sort()
}

export interface CommandEntry {
  name: string
  description: string
}

const COMMAND_DESCRIPTIONS: Record<string, string> = {
  '/help': 'Show help',
  '/commands': 'List all slash commands',
  '/version': 'Show version info',
  '/clear': 'Clear conversation',
  '/exit': 'Exit Mipham Code',
  '/quit': 'Exit Mipham Code',
  '/compact': 'Compact context window',
  '/context': 'Show context stats',
  '/status': 'Session and system status',
  '/cost': 'Token usage estimate',
  '/usage': 'Detailed usage dashboard',
  '/rename': 'Rename current session',
  '/goal': 'Set session goal',
  '/recap': 'Summarize session so far',
  '/save': 'Save conversation to Obsidian wiki (skill: save-to-wiki)',
  '/export': 'Export conversation to file',
  '/doctor': 'System diagnostics',
  '/fix': 'Deterministic self-repair: doctor/config/cache',
  '/dream': 'Background memory consolidation',
  '/constitution': 'View or reload constitutional principles',
  '/bug-report': 'Generate diagnostic report for GitHub Issues',
  '/changelog': 'Recent version history',
  '/resume': 'List saved sessions',
  '/resume last': 'Restore the most recent saved session',
  '/resume delete': 'Delete a saved session',
  '/branch': 'Fork conversation',
  '/rewind': 'Undo last AI turn',
  '/undo': 'Same as /rewind',
  '/copy': 'Copy last response to clipboard',
  '/focus': 'Toggle focus view',
  '/ultracode': 'Toggle multi-agent workflow orchestration mode',
  '/pick': 'Open model picker',
  '/model': 'Show current model',
  '/models': 'List all available models',
  '/provider': 'Show current provider',
  '/providers': 'List configured providers',
  '/switch': 'Switch provider and model',
  '/config': 'View configuration',
  '/fast': 'Toggle fast mode',
  '/effort': 'Set reasoning effort',
  '/theme': 'Set terminal theme',
  '/lang': 'Set display language (en-US, zh-CN)',
  '/tools': 'List available tools',
  '/skills': 'List loaded skills',
  '/reload-skills': 'Reload all skills',
  '/browse-skills': 'Browse community skill marketplace',
  '/install-skill': 'Install a skill by name or URL',
  '/marketplace': 'Manage marketplace sources (add/list/remove)',
  '/browse-marketplace': 'Browse skills across all marketplace sources',
  '/remove-skill': 'Remove an installed skill',
  '/mcp': 'MCP server status',
  '/plugins': 'List installed plugins',
  '/browse-plugins': 'Browse community plugin marketplace',
  '/install-plugin': 'Install a plugin from npm or local path',
  '/remove-plugin': 'Remove an installed plugin',
  '/plugin-enable': 'Enable a disabled plugin',
  '/plugin-disable': 'Disable an enabled plugin',
  '/crsi rules': 'List all active CRSI rules with their status',
  '/crsi disable': 'Disable a CRSI rule by ID',
  '/crsi analyze': 'Manually trigger CRSI pattern analysis across all agents',
  '/crsi restore': 'Restore a disabled or degraded CRSI rule',
  '/crsi stats': 'Show CRSI overall effectiveness statistics',
  '/crsi health': 'CRSI + SIS unified health dashboard with scoring',
  '/crsi inventory': 'Live capability self-report — CRSI/SIS/constitution state',
  '/crsi modify': 'Run a code self-modification through the sandbox (worktree → tests → approve)',
  '/crsi propose':
    '固化 CRSI 失败信号（默认教训 / --rule 受管理规则 / --prose 改 skill 散文），沙箱 + 人批准门控',
  '/crsi prose-clear': '清空散文提议去重 ledger（~/.mipham/crsi/prose-proposals.jsonl）',
  '/crsi eval': 'Run the ground-truth CRSI eval harness and record the score',
  '/crsi bench': 'Run the LLM task-performance benchmark and report the score',
  '/crsi meta': 'RSI Level 3 meta-rule analysis — rules that improve the rules',
  '/crsi interpret': 'Tool-call behavior dashboard — error patterns, usage, health',
  '/crsi critique': 'Enable/disable RLAIF self-critique on tool calls',
  '/crsi red-team': 'Run adversarial self-test — verify SIS blocks known attacks',
  '/sis errors': 'List all active SIS immune memory signatures',
  '/sis stats': 'Show SIS self-immune system aggregate statistics',
  '/sis clear': 'Retire an immune memory signature by ID',
  '/sis cleanup': 'Run immune memory garbage collection (dedup + cleanup)',
  '/plan': 'Enter plan mode',
  '/no-plan': 'Exit plan mode',
  '/tdd': 'Test-Driven Development workflow (RED → GREEN → REFACTOR)',
  '/todos': 'Task management (list/create tasks)',
  '/tasks': 'Background tasks',
  '/review': 'Review code for bugs, security, performance (alias for /code-review)',
  '/pr-comments': 'PR review summary',
  '/diff': 'Show git diff',
  '/workflows': 'List workflow scripts',
  '/workflow view': 'View workflow run details or list runs',
  '/workflow watch': 'Monitor active workflow execution',
  '/deep-research':
    'Deep research with multi-agent parallel search, verification, and cited synthesis',
  '/loop': 'Run prompt on interval',
  '/init': 'Initialize .mipham config',
  '/setup': 'Guided project setup wizard',
  '/permissions': 'Show permission settings',
  '/add-dir': 'Add workspace directory',
  '/recommend': 'Analyze project + recommend skills & setup',
  '/security': 'Security review checklist',
  '/audit': 'Same as /security',
  '/trust': 'Show and manage trusted workspaces',
  '/prompt-audit': 'Audit prompts for modern model optimization',
  '/ide': 'IDE integration guide',
  '/terminal-setup': 'Shell & terminal config',
  '/memory': 'Manage AI memories',
  '/release-notes': 'View version changelog',
  '/upgrade': 'Show upgrade instructions',
  '/login': 'Show API key status',
  '/logout': 'Clear credentials guide',
  '/keys': 'List API key rotation status',
  '/keys rotate': 'Rotate an API key',
  '/keys audit': 'Check for expired keys',
  '/keys view': 'View a provider plaintext API key',
  '/feedback': 'Send feedback',
  '/agents': 'Agent view dashboard',
  '/bg': 'Run a background agent task',
  '/fork': 'Fork task into isolated worktree',
  '/artifact': 'Manage artifacts',
  '/schedule': 'View scheduled tasks and cron jobs',
  '/commit': 'Generate commit message and review staged changes',
  '/push': 'Push the current branch',
  '/pr': 'Create a pull request',
  '/issue': 'File a GitHub issue',
  '/code-review': 'Review code for bugs, security, performance (7 dimensions)',
  '/simplify': 'Cleanup-only review: reuse, simplification, efficiency, abstraction',
  '/verify': 'Runtime verification — observe actual execution, not tests',
  '/design': 'Start architectural design session — explore approaches and trade-offs',
  '/lint': 'Run linting on the project',
  '/files': 'List files in current working directory',
  '/stats': 'Show session usage statistics',
  '/summary': 'Generate session summary',
  '/cd': 'Change session working directory',
  '/hooks': 'List configured hooks from settings.json',
  '/hooks health': 'Check hook health — see failures, disabled hooks, recovery status',
  '/hooks enable': 'Manually re-enable a hook that was auto-disabled after repeated failures',
  '/batch': 'Apply changes across multiple files',
}

export function getCommandList(): CommandEntry[] {
  return getCommandNames().map((name) => ({
    name,
    description: COMMAND_DESCRIPTIONS[name] ?? '',
  }))
}

export function looksLikeSlashCommand(input: string): boolean {
  return input.trim().startsWith('/')
}

export function parseSlashCommand(input: string): { command: string; args: string[] } {
  const parts = input.trim().split(/\s+/)
  const command = parts[0]?.toLowerCase() || ''
  const args = parts.slice(1)
  return { command, args }
}

export { stripIndent } from './strip-indent.js'

export { switchCmd as handleSwitch }
