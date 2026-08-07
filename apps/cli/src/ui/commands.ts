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
import { McpClient } from '../mcp/client'
import { NPM_INSTALL_COMMAND, NPM_UPDATE_COMMAND, PACKAGE_VERSION } from '../shared/index.ts'
import { getPreference } from '../config/preferences'
import { stripIndent } from './strip-indent.js'
import {
  initCmd,
  setupCmd,
  recommendCmd,
  permissionsCmd,
  addDirCmd,
  securityCmd,
  promptAuditCmd,
} from '../commands/project.js'
import { themeCmd, releaseNotesCmd, ideCmd, terminalSetupCmd } from '../commands/environment.js'
import { commitCmd, pushCmd, prCmd, issueCmd } from '../commands/git.js'

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
  skillsLoader?: SkillsLoader
  pluginManager?: PluginManager
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
  return { content: '✓ Conversation cleared. Context reset.', clearMessages: true }
}

const exitCmd: CommandHandler = () => ({ content: '', exit: true })

// ═══════════════════════════════════════════════════════════════
// Context & Status
// ═══════════════════════════════════════════════════════════════

const compactCmd: CommandHandler = async (ctx) => {
  const context = ctx.engine.getContext()
  const before = context.getEstimatedTokens()
  await context.compact('user requested compaction')
  const after = context.getEstimatedTokens()
  return {
    content: `✓ Context compacted.\nTokens: ${before.toLocaleString()} → ${after.toLocaleString()} (saved ${((1 - after / before) * 100).toFixed(0)}%)`,
  }
}

const contextCmd: CommandHandler = (ctx) => {
  const c = ctx.engine.getContext()
  const tokens = c.getEstimatedTokens()
  const msgs = c.getMessages()
  const systemPromptLen = c.getSystemPrompt().length
  return {
    content: stripIndent`
      ── Context Stats ──
      Messages:       ${msgs.length}
      Estimated tokens: ${tokens.toLocaleString()} / 200,000
      Usage:           ${((tokens / 200_000) * 100).toFixed(1)}%
      System prompt:   ${systemPromptLen.toLocaleString()} chars (~${Math.ceil(systemPromptLen / 4).toLocaleString()} tokens)
      Compaction:      at 90% (${(200_000 * 0.9).toLocaleString()} tokens)
    `,
  }
}

const statusCmd: CommandHandler = (ctx) => {
  const c = ctx.engine.getContext()
  const tools = ctx.engine.getTools()
  return {
    content: stripIndent`
      ── Session Status ──
      Provider:   ${ctx.providerId}
      Model:      ${ctx.modelId}
      Messages:   ${c.getMessages().length}
      Tokens:     ~${c.getEstimatedTokens().toLocaleString()} / 200,000
      Tools:      ${tools.size} loaded
      Permission: ${ctx.config.permission}

      ── System ──
      Platform:   ${process.platform} ${process.arch}
      Runtime:    ${typeof Bun !== 'undefined' ? 'Bun' : 'Node.js'} ${typeof Bun !== 'undefined' ? Bun.version : process.version}
      CWD:        ${process.cwd()}
    `,
  }
}

const costCmd: CommandHandler = (ctx) => {
  const tokens = ctx.engine.getContext().getEstimatedTokens()
  return {
    content: stripIndent`
      ── Token Usage (estimated) ──
      Context tokens: ~${tokens.toLocaleString()} / 200,000
      Usage: ${((tokens / 200_000) * 100).toFixed(1)}%

      Token counting is approximate (chars/4).
      Actual API usage depends on provider and model.
    `,
  }
}

// ═══════════════════════════════════════════════════════════════
// Model & Provider
// ═══════════════════════════════════════════════════════════════

const modelCmd: CommandHandler = (ctx) => ({
  content: `Current model: ${ctx.modelId}\nProvider: ${ctx.providerId}\n\nUse /switch <provider> <model> to change.`,
})

const modelsCmd: CommandHandler = (ctx) => {
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
    content: `Available models (${lines.length} active):\n\nProvider      Model                          Context     Vision\n${'-'.repeat(80)}\n${lines.join('\n')}\n\nUse /switch <provider> <model> to change.\nSee /providers for upcoming models.`,
  }
}

const providerCmd: CommandHandler = (ctx) => ({
  content: `Current provider: ${ctx.providerId}\nModel: ${ctx.modelId}`,
})

const providersCmd: CommandHandler = (ctx) => {
  const lines = ctx.config.providers.map(
    (p) =>
      `  ${p.id.padEnd(14)} ${p.name.padEnd(20)} ${p.protocol.padEnd(18)} ${p.models.length} models  ${p.status === 'upcoming' ? '[upcoming]' : '✓'}`,
  )
  return {
    content: `Configured providers:\n\n${lines.join('\n')}\n\nCurrent: ${ctx.providerId}/${ctx.modelId}`,
  }
}

const switchCmd: CommandHandler = (ctx, args) => {
  const [newProvider, newModel] = args
  if (!newProvider || !newModel) {
    return {
      content: 'Usage: /switch <provider> <model>\nExample: /switch deepseek deepseek-v4-pro',
    }
  }
  ctx.engine.switchProvider(newProvider, newModel)
  return {
    content: `✓ Switched to ${newProvider}/${newModel}`,
    nextProvider: newProvider,
    nextModel: newModel,
  }
}

const configCmd: CommandHandler = (ctx) => {
  const c = ctx.config
  const lines = [
    `version:          ${c.version}`,
    `defaultProvider:  ${c.defaultProvider}`,
    `defaultModel:     ${c.defaultModel}`,
    `permission:       ${c.permission}`,
    `providers:        ${c.providers.length} configured`,
  ]
  return {
    content: `── Configuration ──\n${lines.join('\n')}\n\nEdit: ~/.mipham/config.yml or .mipham/config.yml`,
  }
}

// ═══════════════════════════════════════════════════════════════
// Tools & Skills
// ═══════════════════════════════════════════════════════════════

const toolsCmd: CommandHandler = (ctx) => {
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

  return { content: `Available tools (${tools.size}):\n\n${sections.join('\n\n')}` }
}

const skillsCmd: CommandHandler = (ctx) => {
  if (!ctx.skillsLoader) {
    return { content: 'SkillsLoader not available.' }
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
    `${counts.total} skills loaded. Use Skill tool to invoke.`,
  ]
  return { content: lines.join('\n') }
}

// ═══════════════════════════════════════════════════════════════
// Workflow
// ═══════════════════════════════════════════════════════════════

const planCmd: CommandHandler = (_ctx, args) => {
  const description = args.join(' ') || undefined
  return {
    content:
      '── Plan Mode ──\n\nEntering plan mode — read-only analysis and design.\nUse EnterPlanMode to start, ExitPlanMode to submit for approval.',
    forwardToAI: description
      ? `Use EnterPlanMode with description: "${description}". Then explore, design, and use ExitPlanMode when ready for approval.`
      : 'Use EnterPlanMode to enter plan mode. Explore the codebase, design an approach, then use ExitPlanMode to submit for approval.',
  }
}

const tddCmd: CommandHandler = (_ctx, args) => {
  const target = args.join(' ') || 'the current task'
  return {
    content: stripIndent`
      ── TDD Mode ──
      Starting Test-Driven Development workflow for: ${target}

      Cycle: 🔴 RED → 🟢 GREEN → 🔵 REFACTOR
        RED:   Write a failing test first
        GREEN: Write minimal code to pass
        REFACTOR: Clean up while keeping tests green

      The AI will guide you through each cycle.
    `,
    forwardToAI: `Follow the Test-Driven Development workflow for ${target}:
1. RED — Write a failing test that defines the expected behavior. Use the project's test framework (Vitest/Jest/pytest). Show me the test code and confirm it fails.
2. GREEN — Write the minimum code needed to make the test pass. Run the test to verify it passes.
3. REFACTOR — Clean up both test and implementation code. Remove duplication, improve names, simplify. Keep tests green.
Repeat for each behavior. Do NOT write implementation before tests.`,
  }
}

const todosCmd: CommandHandler = (_ctx, args) => {
  const sub = args[0]
  if (sub === 'create') {
    const title = args.slice(1).join(' ')
    if (!title.trim()) {
      return {
        content:
          'Usage: /todos create <task-title>\n\nExample: /todos create Add user authentication',
      }
    }
    return {
      content: `── Create Task ──\n\nCreating task: "${title.trim()}"\n\nPassing to AI for structured task creation with TaskCreate...`,
      forwardToAI: `Create a new task using TaskCreate with subject "${title.trim()}". Set a clear description and activeForm.`,
    }
  }

  if (sub === 'list' || !sub) {
    return {
      content: stripIndent`
        ── Task Management ──
        Fetching current task list...

        Shortcuts:
          /todos list           Show all tasks
          /todos create <title> Create a new task
      `,
      forwardToAI:
        'Use TaskList to show all current tasks. Present them in a clear summary grouped by status (pending/in_progress/completed). If there are no tasks, suggest creating one.',
    }
  }

  return {
    content: stripIndent`
      ── Task Management ──
      /todos list           Show all tasks
      /todos create <title> Create a new task

      The AI manages task state via TaskCreate, TaskList, TaskUpdate, and TaskGet tools.
      Tasks appear in the /tasks view and persist across the session.
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
  const name = args.join(' ')
  if (!name.trim()) {
    return { content: 'Usage: /rename <session-name>\nExample: /rename Bug Fix Session' }
  }
  ctx.setSessionTitle(name.trim())
  return { content: `✓ Session renamed to "${name.trim()}"` }
}

const goalCmd: CommandHandler = (ctx, args) => {
  const input = args.join(' ')

  // ── Show goal status ──
  if (!input.trim()) {
    const state = ctx.engine.getGoalState?.() || { goal: undefined, decompose: false, subtasks: [] }
    if (!state.goal) {
      return {
        content:
          `Usage: /goal <statement> [options]\n\n` +
          `Set a session-level completion condition with optional verification.\n\n` +
          `Options:\n` +
          `  --decompose              Auto-decompose goal into subtasks\n` +
          `  --verify-script <path>   Run a shell script to check completion\n` +
          `  --verify-skill <name>    Use a skill for verification\n\n` +
          `Examples:\n` +
          `  /goal Fix all TS errors and make tests pass --decompose\n` +
          `  /goal Complete the build --verify-script ./check-build.sh\n` +
          `  /goal Security audit passes --verify-skill security-review`,
      }
    }
    const lines = [`── Goal Status ──`, '', `🎯 Goal: ${state.goal}`]
    if (state.verifyScript) lines.push(`📜 Verification: ${state.verifyScript}`)
    if (state.verifySkill) lines.push(`🛠  Verification skill: ${state.verifySkill}`)
    if (state.decompose) lines.push(`📋 Decompose: enabled (${state.subtasks.length} subtasks)`)
    lines.push('', 'Type /goal without arguments to clear.')
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
    return { content: 'Goal text is required. Use /goal without arguments to see usage.' }
  }

  ctx.setGoal(goal)
  ctx.engine.setGoal(goal, { verifyScript, verifySkill, decompose })

  const lines = [`✓ Goal set: "${goal}"`]
  if (decompose) {
    lines.push('📋 Decomposition: enabled — AI will break goal into subtasks')
    // Decompose by creating initial subtasks
    const decomposeMsg = `Break down this goal into 3-5 subtasks: "${goal}". For each subtask, use TaskCreate with the subject and description. Mark each as blocked by the previous one to create a dependency chain.`
    return {
      content: lines.join('\n'),
      forwardToAI: decomposeMsg,
    }
  }
  if (verifyScript) lines.push(`📜 Verification: ${verifyScript}`)
  if (verifySkill) lines.push(`🛠  Verification skill: ${verifySkill}`)
  lines.push('')
  lines.push('Use /status to view progress. Type /goal without arguments to clear.')

  return { content: lines.join('\n') }
}

const recapCmd: CommandHandler = (ctx) => {
  const c = ctx.engine.getContext()
  const msgs = c.getMessages()
  if (msgs.length === 0) {
    return { content: 'No conversation to recap.' }
  }
  // Show summary of conversation: count messages, roles, estimated tokens
  const userMsgs = msgs.filter((m) => m.role === 'user').length
  const assistantMsgs = msgs.filter((m) => m.role === 'assistant').length
  const tokens = c.getEstimatedTokens()
  const checkpointCount = c.getCheckpoints().length

  // Extract first few user messages as "topics"
  const topics = msgs
    .filter((m) => m.role === 'user' && typeof m.content === 'string')
    .slice(0, 5)
    .map((m) => {
      const text = typeof m.content === 'string' ? m.content : ''
      return text.length > 80 ? text.slice(0, 80) + '...' : text
    })

  return {
    content: stripIndent`
      ── Session Recap ──
      Messages:  ${msgs.length} (${userMsgs} user, ${assistantMsgs} assistant)
      Est. tokens: ~${tokens.toLocaleString()}
      Checkpoints: ${checkpointCount}

      Recent topics:
      ${topics.map((t, i) => `  ${i + 1}. ${t}`).join('\n')}

      Use /rewind to undo, /clear to reset, /export to save.
    `,
  }
}

const usageCmd: CommandHandler = (ctx) => {
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
      ? `API tokens:      ${summary.apiInputTokens.toLocaleString().padStart(8)} in / ${summary.apiOutputTokens.toLocaleString().padStart(6)} out (${apiTotal.toLocaleString()} total)`
      : 'API tokens:      (no API usage data yet)'

  const toolSection = toolLines.length > 0 ? `\n── Per-Tool ──\n${toolLines.join('\n')}` : ''

  return {
    content: stripIndent`
      ── Usage Dashboard ──
      ${apiLine}
      Context tokens:  ~${estTokens.toLocaleString()} / ${maxTokens.toLocaleString()}  (${pct}%)
      Messages:         ${msgs.length}
      Provider:         ${ctx.providerId}
      Model:            ${ctx.modelId}

      ${'█'.repeat(Math.ceil(Number(pct) / 5))}${'░'.repeat(20 - Math.ceil(Number(pct) / 5))} ${pct}%
      ${toolSection}

      Use /context for detailed stats, /compact to free space.
    `,
  }
}

const reloadSkillsCmd: CommandHandler = (ctx) => {
  if (!ctx.skillsLoader) {
    return { content: 'SkillsLoader not available in this context.' }
  }
  try {
    const config = ctx.config
    // Re-load builtin skills from the skills directory
    // The base path is typically relative to the CLI package
    ctx.skillsLoader.loadBuiltin(process.cwd())
    if (config.skills?.paths) {
      ctx.skillsLoader.loadExternal(config.skills.paths)
    }
    const skills = ctx.skillsLoader.list()
    return {
      content: `✓ Skills reloaded — ${skills.length} loaded.\n\n${skills.map((s) => `  ${s.name.padEnd(28)} ${s.type.padEnd(10)} ${s.description}`).join('\n')}`,
    }
  } catch (err) {
    return { content: `Failed to reload skills: ${String(err)}` }
  }
}

// ═══════════════════════════════════════════════════════════════
// Skill Marketplace — Community skill registry + installation
// ═══════════════════════════════════════════════════════════════

const browseSkillsCmd: CommandHandler = async () => {
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
    result = installSkillFromUrl(target, marketplaceConfig)
  } else {
    result = installSkill(target, marketplaceConfig)
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

// ═══════════════════════════════════════════════════════════════
// Plugins — Community plugin marketplace + local management
// ═══════════════════════════════════════════════════════════════

const pluginsCmd: CommandHandler = (ctx) => {
  const manager = ctx.pluginManager
  if (!manager) {
    return { content: 'PluginManager not available in this session.' }
  }

  const plugins = manager.list()
  if (plugins.length === 0) {
    return {
      content: [
        '── Installed Plugins ──',
        '',
        'No plugins installed.',
        '',
        'Install plugins:',
        '  /install-plugin <npm-package>    Install from npm registry',
        '  /browse-plugins                  Browse community plugins',
        '  mipham plugin install <path>    Install from local directory',
      ].join('\n'),
    }
  }

  const lines: string[] = [
    '── Installed Plugins ──',
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
  const c = ctx.engine.getContext()
  const checkpoints = c.getCheckpoints()

  if (checkpoints.length === 0) {
    return {
      content:
        'No checkpoints available. Checkpoints are automatically saved after each AI response.',
    }
  }

  const result = c.restoreCheckpoint()
  if (!result.restored) {
    return { content: 'No checkpoint to restore.' }
  }

  return {
    content: stripIndent`
      ✓ Rewound to checkpoint "${result.label}"
      Restored ${result.messageCount} messages.

      Remaining checkpoints: ${c.getCheckpoints().length}
      Use /rewind again to go back further, or continue chatting.
    `,
    clearMessages: true,
  }
}

const undoCmd: CommandHandler = rewindCmd

const copyCmd: CommandHandler = (ctx, args) => {
  const c = ctx.engine.getContext()
  const msgs = c.getMessages()
  const assistantMsgs = msgs.filter((m) => m.role === 'assistant')

  if (assistantMsgs.length === 0) {
    return { content: 'No assistant responses to copy.' }
  }

  // Determine which response to copy: last N or last 1
  let n = 1
  if (args[0]) {
    n = parseInt(args[0]!, 10)
    if (isNaN(n) || n < 1) {
      return {
        content: 'Usage: /copy [N]\nN = number of recent assistant responses to copy (default: 1)',
      }
    }
  }

  const toCopy = assistantMsgs.slice(-n)
  const text = toCopy
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n\n---\n\n')

  return {
    content: `✓ Copied ${toCopy.length} assistant response(s) to clipboard (${text.length.toLocaleString()} chars).`,
    copyContent: text,
  }
}

const diffCmd: CommandHandler = async (_ctx) => {
  try {
    const { execSync } = await import('node:child_process')
    const output = execSync('git diff --stat', { encoding: 'utf-8', timeout: 5000 })
    if (!output.trim()) {
      return { content: 'No uncommitted changes (working tree clean).' }
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
      content: `── Git Diff ──\n\n${truncated}`,
    }
  } catch {
    return {
      content: 'Unable to run git diff. Ensure git is installed and you are in a repository.',
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Phase 1 — Model Control Commands
// ═══════════════════════════════════════════════════════════════

const fastCmd: CommandHandler = (ctx, args) => {
  const arg = args[0]?.toLowerCase()
  if (arg === 'on') {
    ctx.setFastMode(true)
    return { content: '✓ Fast mode ON — responses will prioritize speed over depth.' }
  } else if (arg === 'off') {
    ctx.setFastMode(false)
    return { content: '✓ Fast mode OFF — standard quality mode.' }
  } else if (arg) {
    return { content: 'Usage: /fast [on|off]\nToggle fast mode for faster responses.' }
  } else {
    // Toggle
    // We can't read current state from context, so we just show usage
    return {
      content:
        'Usage: /fast [on|off]\n\nFast mode prioritizes speed over depth. Currently available as a configuration toggle.\n\nExample:\n  /fast on   — enable fast mode\n  /fast off  — disable fast mode',
    }
  }
}

const effortCmd: CommandHandler = (ctx, args) => {
  const VALID_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
  const level = args[0]?.toLowerCase()

  if (!level || !VALID_LEVELS.includes(level)) {
    return {
      content: stripIndent`
        Usage: /effort <level>

        Set reasoning effort level:
          low      — Fast, simple tasks
          medium   — Balanced quality and speed
          high     — Thorough reasoning (default)
          xhigh    — Maximum depth for coding/agentic use
          max      — Absolute ceiling, very thorough

        Current model: ${ctx.modelId}
        Effort levels require compatible providers (Anthropic Opus 4.6+, Sonnet 4.6).
      `,
    }
  }

  ctx.setEffort(level)
  return { content: `✓ Reasoning effort set to "${level}"` }
}

const focusCmd: CommandHandler = (ctx) => {
  ctx.setFocusMode(true)
  return {
    content: stripIndent`
      ✓ Focus mode ON — showing only the most recent exchange.
      Previous messages are hidden but preserved.
      Type /focus again to exit focus mode and show all messages.
    `,
  }
}

// ═══════════════════════════════════════════════════════════════
// Ultracode Mode — toggle multi-agent workflow orchestration
// ═══════════════════════════════════════════════════════════════

const ultracodeCmd: CommandHandler = (ctx, args) => {
  const arg = args[0]?.toLowerCase()
  if (arg === 'on') {
    ctx.setUltracodeMode(true)
    return {
      content:
        '✓ Ultracode mode ON — multi-agent workflow orchestration enabled.\n\nThe AI will use Workflow tool to fan out, verify, and synthesize for all substantive tasks.',
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
      content: '✓ Ultracode mode OFF.',
      forwardToAI:
        'Ultracode mode is now OFF. Revert to standard single-agent execution. Do NOT use Workflow tool unless explicitly asked.',
    }
  }
  return {
    content: stripIndent`
      Usage: /ultracode [on|off]

      Ultracode mode enables multi-agent workflow orchestration for every substantive task.
      When ON, the AI uses the Workflow tool to decompose tasks, fan out parallel agents,
      verify findings adversarially, and synthesize results with a top-tier model.

      Examples:
        /ultracode on    — enable multi-agent mode
        /ultracode off   — return to standard single-agent mode
    `,
  }
}

// ═══════════════════════════════════════════════════════════════
// Phase 1 — Workflow Commands
// ═══════════════════════════════════════════════════════════════

const tasksCmd: CommandHandler = (ctx) => {
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
      ── Background Tasks ──

      ${
        toolUses.length > 0
          ? `${toolUses.length} task operations detected in this session.\n\nUse Task tool (TaskCreate / TaskUpdate / TaskList) to manage structured task tracking.`
          : 'No tasks tracked yet. Use TaskCreate, TaskUpdate, and TaskList tools to manage structured tasks.'
      }

      Quick reference:
        TaskCreate  — create a new task
        TaskList    — list all tasks
        TaskUpdate  — update task status
        TaskGet     — get task details
        TaskOutput  — get background task output
        TaskStop    — stop a running task

      Type /todos for the legacy task interface.
    `,
  }
}

const branchCmd: CommandHandler = (ctx, args) => {
  const name = args.join(' ') || `branch-${Date.now()}`
  const c = ctx.engine.getContext()
  const msgs = c.getMessages()

  if (msgs.length === 0) {
    return { content: 'No conversation to branch. Start a conversation first.' }
  }

  // Save current session state as a named checkpoint
  const checkpointId = c.saveCheckpoint(name)
  return {
    content: stripIndent`
      ── Branch Created ──
      Name:       "${name}"
      Checkpoint:  #${checkpointId}
      Messages:    ${msgs.length} saved

      Current conversation continues from this point.
      To return to this branch point later, use:
        /rewind

      Note: Full session branching (separate concurrent sessions) requires session persistence, coming in a future release. For now, this saves a named checkpoint you can rewind to.
    `,
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

const loopCmd: CommandHandler = async (_ctx, args) => {
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
    createAutoloopJournal(sessionId, prompt)

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
      createAutoloopJournal(sessionId, fullPrompt)

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
    return result.success
      ? { content: result.content }
      : { content: `Loop failed: ${result.error || 'unknown error'}` }
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
  const lines: string[] = [
    '── System Diagnostics ──',
    '',
    `Mipham Code  v${ctx.version}`,
    `Runtime      ${typeof Bun !== 'undefined' ? 'Bun ' + Bun.version : 'Node.js ' + process.version}`,
    `Platform     ${process.platform} ${process.arch}`,
    `CWD          ${process.cwd()}`,
    `PID          ${process.pid}`,
    '',
    '── Config ──',
    `Provider     ${ctx.providerId} / ${ctx.modelId}`,
    `Permission   ${ctx.config.permission}`,
    `Providers    ${ctx.config.providers.length} configured (${ctx.config.providers.filter((p) => p.status !== 'upcoming').length} active)`,
    '',
    '── Session ──',
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
    lines.push('── Git ──')
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
    lines.push('── Git ──')
    lines.push('  (not a git repository or git not available)')
  }

  // Skills info
  if (ctx.skillsLoader) {
    lines.push('')
    lines.push('── Skills ──')
    try {
      const skills = ctx.skillsLoader.list()
      const standard = skills.filter((s: { type: string }) => s.type === 'standard').length
      const mipham = skills.filter((s: { type: string }) => s.type === 'mipham').length
      lines.push(`Loaded       ${skills.length} (${standard} standard + ${mipham} mipham)`)
    } catch {
      lines.push('  (skills info unavailable)')
    }
  }

  return { content: lines.join('\n') }
}

// ═══════════════════════════════════════════════════════════════
// GitHub & Git Workflow Commands (Claude Code parity)
// ═══════════════════════════════════════════════════════════════

function gitDiffBridgeCmd(opts: {
  label: string
  noChangesHint: string
  runningMsg: string
  forwardToAI: string | (() => string)
}): CommandHandler {
  return async () => {
    try {
      const { execSync } = await import('node:child_process')
      const diff = execSync('git diff --stat', { encoding: 'utf-8', timeout: 5000 }).trim()
      if (!diff) {
        return { content: `─ ${opts.label} ─\n\n${opts.noChangesHint}` }
      }
      return {
        content: `─ ${opts.label} ─\n\n${opts.runningMsg}\n\nChanged files:\n${diff}`,
        forwardToAI: typeof opts.forwardToAI === 'function' ? opts.forwardToAI() : opts.forwardToAI,
      }
    } catch {
      return {
        content: `─ ${opts.label} ─\n\nCould not detect changes. Are you in a git repository?`,
      }
    }
  }
}

const codeReviewCmd = gitDiffBridgeCmd({
  label: 'Code Review',
  noChangesHint:
    'No uncommitted changes to review.\n\nTo review a specific file: /code-review path/to/file.ts',
  runningMsg:
    'Reviewing uncommitted changes with the code-review skill (7 dimensions: correctness, security, performance, code quality, architecture, testing, language-specific)...',
  forwardToAI: () =>
    `use the code-review skill to review all uncommitted changes. Check all 7 dimensions: correctness, security, performance, code quality, architecture & design, testing, and language-specific issues. Use effort level: ${getPreference('lastCodeReviewEffort', 'high')}.`,
})

const simplifyCmd = gitDiffBridgeCmd({
  label: 'Simplify',
  noChangesHint:
    'No uncommitted changes to simplify.\n\nMake changes first, then run /simplify for cleanup review.',
  runningMsg:
    'Running cleanup review — 4 passes: reuse, simplification, efficiency, abstraction level...',
  forwardToAI:
    'use the self-review skill to review these uncommitted changes. Focus on 4 cleanup passes: 1) Reuse — find duplicated logic, replace with existing helpers; 2) Simplification — flatten nesting, remove redundant state and dead code; 3) Efficiency — fix repeated object creation, unnecessary I/O, memory issues; 4) Abstraction Level — ensure code sits at the right architectural layer. Apply equivalent transformations only — do NOT change logic or fix bugs.',
})

const verifyCmd = gitDiffBridgeCmd({
  label: 'Verify',
  noChangesHint:
    'No uncommitted changes to verify.\n\nMake changes first, then run /verify for runtime verification.',
  runningMsg:
    'Running runtime verification — observing actual execution behavior (not tests, not typecheck)...',
  forwardToAI:
    'verify these uncommitted changes through runtime observation only. For each change: 1) Find the user-facing surface (CLI command, API endpoint, UI interaction); 2) Drive the changed code to execute; 3) Push boundaries — pass null, repeated values, wrong types, interrupt mid-flow (Ctrl-C), resize window; 4) Report verdict per change: PASS (works as expected), FAIL (does not work or breaks something), BLOCKED (cannot reach observable state), SKIP (no runtime surface, e.g. pure documentation). Do NOT run the test suite — observe real execution behavior only.',
})

const designCmd: CommandHandler = (_ctx, args) => {
  const topic = args.join(' ') || 'the current task'
  return {
    content: `─ Design ─\n\nStarting architectural design session for: ${topic}\n\nExploring approaches, trade-offs, component breakdown, data flow...`,
    forwardToAI: `help me design the architecture for ${topic}. Explore 2-3 approaches with trade-offs, then present a design covering: component breakdown, data flow, interfaces between components, error handling strategy, and testing approach. Use the plan sub-agent if deeper analysis would help. Prefer simplicity — YAGNI.`,
  }
}

const lintCmd: CommandHandler = async () => {
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
        '── Lint Results ──',
        '',
        truncated || '(no issues found)',
        '',
        hasPackageJson
          ? 'To fix: type "fix the lint errors"'
          : 'Set up linting: https://mipham.ai/code/docs/linting',
      ].join('\n'),
    }
  } catch {
    return {
      content: '── Lint ──\n\nCould not run linter. Ensure ESLint is installed and configured.',
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Session Enhancement Commands (Claude Code parity)
// ═══════════════════════════════════════════════════════════════

const filesCmd: CommandHandler = async () => {
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
        '── Project Files ──',
        '',
        `CWD: ${cwd}`,
        '',
        ...items,
        entries.length > 40 ? `  ... and ${entries.length - 40} more files` : '',
        '',
        'Use Read/Glob/Grep tools to examine files.',
      ].join('\n'),
    }
  } catch {
    return { content: '── Files ──\n\nCould not read directory.' }
  }
}

const statsCmd: CommandHandler = (ctx) => {
  const c = ctx.engine.getContext()
  const msgs = c.getMessages()
  const tokens = c.getEstimatedTokens()
  const tools = ctx.engine.getTools()

  const userMsgs = msgs.filter((m) => m.role === 'user').length
  const assistantMsgs = msgs.filter((m) => m.role === 'assistant').length
  const systemMsgs = msgs.filter((m) => m.role === 'system').length

  return {
    content: [
      '── Session Stats ──',
      '',
      `Messages:        ${msgs.length} (${userMsgs} user, ${assistantMsgs} AI, ${systemMsgs} system)`,
      `Tokens:          ~${tokens.toLocaleString()} / 200,000`,
      `Tools available:  ${tools.size}`,
      `Provider:         ${ctx.providerId}`,
      `Model:            ${ctx.modelId}`,
      `Permission:       ${ctx.config.permission}`,
      '',
      `Usage:            ${((tokens / 200_000) * 100).toFixed(1)}% of context window`,
    ].join('\n'),
  }
}

const summaryCmd: CommandHandler = (ctx) => {
  const c = ctx.engine.getContext()
  const msgs = c.getMessages()

  if (msgs.length === 0) {
    return { content: '── Summary ──\n\nNo conversation to summarize.' }
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
      '── Session Summary ──',
      '',
      `Total messages: ${msgs.length}`,
      `Est. tokens:    ~${c.getEstimatedTokens().toLocaleString()}`,
      '',
      'Recent topics:',
      ...userMsgs.map((t, i) => `  ${i + 1}. ${t}`),
      '',
      'Use /export to save, /clear to reset.',
    ].join('\n'),
  }
}

const cdCmd: CommandHandler = async (ctx, args) => {
  const target = args[0]
  if (!target) {
    return {
      content: [
        'Usage: /cd <path>',
        '',
        'Change the session working directory.',
        'Example: /cd ~/projects/my-app',
        '',
        `Current: ${process.cwd()}`,
      ].join('\n'),
    }
  }

  const { existsSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const resolved = resolve(target.replace(/^~/, process.env.HOME || '~'))

  if (!existsSync(resolved)) {
    return { content: `❌ Directory not found: ${resolved}` }
  }

  try {
    process.chdir(resolved)

    // Persist cwd to active session (best-effort)
    try {
      const { SessionStore } = await import('../core/session-store')
      const saved = SessionStore.load(ctx.sessionId)
      if (saved) {
        SessionStore.save(ctx.sessionId, saved.messages, {
          provider: saved.metadata.provider,
          model: saved.metadata.model,
          cwd: resolved,
        })
      }
    } catch {
      /* session persistence is best-effort */
    }

    return {
      content: [
        '── Directory Changed ──',
        '',
        `New CWD: ${resolved}`,
        '',
        'The AI will now work relative to this directory.',
        'Note: This changes the filesystem root for tools like Read, Write, Bash.',
      ].join('\n'),
    }
  } catch (err) {
    return { content: `❌ Failed to change directory: ${(err as Error).message}` }
  }
}

const hooksCmd: CommandHandler = async () => {
  const { existsSync, readdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const cwd = process.cwd()
  const hooksDir = join(cwd, '.mipham', 'hooks')

  if (!existsSync(hooksDir)) {
    return {
      content: [
        '── Hooks ──',
        '',
        'No hooks configured.',
        '',
        'Create hook scripts in .mipham/hooks/:',
        '  pre-tool-use.sh   — runs before each tool',
        '  post-tool-use.sh  — runs after each tool',
        '  stop.sh           — runs when session ends',
        '',
        'Use /loop init to scaffold hooks directory.',
      ].join('\n'),
    }
  }

  try {
    const files = readdirSync(hooksDir).filter((f) => f.endsWith('.sh'))
    const lines: string[] = ['── Hooks ──', '', `Location: ${hooksDir}`, '']

    for (const f of files) {
      try {
        const stat = (await import('node:fs')).statSync(join(hooksDir, f))
        const isExec = (stat.mode & 0o111) !== 0
        lines.push(
          `  ${isExec ? '✅' : '⚠️'} ${f}${isExec ? '' : ' (not executable — run chmod +x)'}`,
        )
      } catch {
        lines.push(`  📄 ${f}`)
      }
    }

    lines.push('')
    lines.push(`${files.length} hook(s) found.`)
    return { content: lines.join('\n') }
  } catch {
    return { content: '── Hooks ──\n\nCould not read hooks directory.' }
  }
}

const batchCmd: CommandHandler = async () => {
  return {
    content: [
      '── Batch Operations ──',
      '',
      'Apply a change across multiple files or directories.',
      '',
      'Usage: type "apply this change to all .ts files in src/"',
      '',
      'The AI will:',
      '  1. Understand your change description',
      '  2. Find all matching files',
      '  3. Apply the change consistently',
      '  4. Report what was modified',
      '',
      'Use this for:',
      '  • Renaming symbols across codebase',
      '  • Updating import patterns',
      '  • Applying consistent formatting changes',
      '  • Bulk config updates',
    ].join('\n'),
  }
}

// ═══════════════════════════════════════════════════════════════
// Export
// ═══════════════════════════════════════════════════════════════

const exportCmd: CommandHandler = async (ctx) => {
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
    content: `✓ Session exported to:\n  ${filepath}\n\n${msgs.length} messages · ${lines.length} lines`,
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

const resumeLastCmd: CommandHandler = async () => {
  const { SessionStore } = await import('../core/session-store')

  const latest = SessionStore.getLatest()
  if (!latest) {
    return { content: '─ Resume Session ─\n\nNo saved sessions found.\n\nSessions are auto-saved to ~/.mipham/sessions/ when Mipham Code exits.' }
  }

  const session = SessionStore.load(latest.name)
  if (!session) {
    return { content: `─ Load Failed ─\n\nCould not load session "${latest.name}". The file may have been removed.` }
  }

  const date = new Date(latest.updatedAt).toLocaleString()
  return {
    content: [
      '─ Session Restored ─',
      '',
      `Name:      ${latest.name}`,
      `Messages:  ${session.messages.length}`,
      `Provider:  ${latest.provider} / ${latest.model}`,
      `Updated:   ${date}`,
      '',
      `${session.messages.length} messages loaded. Context has been restored.`,
    ].join('\n'),
    forwardedMessages: session.messages,
  }
}

const resumeDeleteCmd: CommandHandler = async (_ctx, args) => {
  const name = args.join(' ').trim()
  if (!name) {
    return { content: 'Usage: /resume delete <session-name>\n\nDelete a saved session. Use /resume to list all sessions.' }
  }

  const { SessionStore } = await import('../core/session-store')
  const deleted = SessionStore.delete(name)

  return deleted
    ? { content: `✓ Session "${name}" deleted.` }
    : { content: `✗ Session "${name}" not found. Use /resume to list all sessions.` }
}

const resumeCmd: CommandHandler = async (_ctx, args) => {
  const sub = args[0]?.toLowerCase()

  // Sub-command: /resume last
  if (sub === 'last') {
    return resumeLastCmd(_ctx, args.slice(1))
  }

  // Sub-command: /resume delete <name>
  if (sub === 'delete') {
    return resumeDeleteCmd(_ctx, args.slice(1))
  }

  const { SessionStore } = await import('../core/session-store')

  // If a name is provided, show load instructions
  const targetName = args.join(' ')
  if (targetName) {
    const session = SessionStore.load(targetName)
    if (session) {
      return {
        content: [
          '─ Session Found ─',
          '',
          `Name:      ${session.metadata.name}`,
          `Messages:  ${session.metadata.messageCount}`,
          `Provider:  ${session.metadata.provider} / ${session.metadata.model}`,
          `Updated:   ${session.metadata.updatedAt}`,
          '',
          'To resume this session:',
          `  /resume last    — restore the most recent session`,
          `  mipham --resume "${targetName}"`,
          '',
          'Or restart Mipham Code — the most recent session loads automatically.',
        ].join('\n'),
      }
    }
    return {
      content: `─ Session Not Found ─\n\nNo session named "${targetName}".\n\nUse /resume without arguments to list all saved sessions.`,
    }
  }

  const sessions = SessionStore.list()

  if (sessions.length === 0) {
    return {
      content:
        '─ Resume Session ─\n\nNo saved sessions found.\n\nSessions are auto-saved to ~/.mipham/sessions/ when Mipham Code exits.\nStart a conversation — it will be saved automatically.',
    }
  }

  const recent = sessions.slice(0, 10)

  const lines: string[] = [
    '─ Saved Sessions ─',
    '',
    ...recent.map(
      (s, i) =>
        `  ${(i + 1).toString().padStart(2)}. ${s.name.padEnd(45)} ${s.messageCount.toString().padStart(4)} msgs  ${new Date(s.updatedAt).toLocaleString()}`,
    ),
    '',
    `Total: ${sessions.length} session(s) • Location: ~/.mipham/sessions/`,
    '',
    'To resume a session:   /resume <name>',
    'To resume most recent:  /resume last',
    'To delete a session:    /resume delete <name>',
    'To resume from CLI:     mipham --resume "<name>"',
    '',
    'Sessions are auto-saved on exit. The most recent session loads automatically on restart.',
  ]

  return { content: lines.join('\n') }
}

// ═══════════════════════════════════════════════════════════════
// Memory Management
// ═══════════════════════════════════════════════════════════════

const memoryCmd: CommandHandler = async () => {
  const { existsSync, readdirSync, readFileSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')

  const home = process.env.HOME || '~'
  const memoryDir = join(home, '.mipham', 'memory')

  if (!existsSync(memoryDir)) {
    return {
      content:
        '─ Memory ─\n\nNo memories stored yet.\n\nMemory is saved to ~/.mipham/memory/ by the AI when you ask it to remember something.\nTry: "remember that I prefer TypeScript"',
    }
  }

  try {
    const files = readdirSync(memoryDir).filter((f) => f.endsWith('.md'))
    if (files.length === 0) {
      return { content: '─ Memory ─\n\nNo memory files found in ~/.mipham/memory/' }
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
      '─ Memory ─',
      '',
      `Location: ${memoryDir}`,
      `Total:    ${memories.length} memor${memories.length === 1 ? 'y' : 'ies'}`,
      '',
      ...memories.map(
        (m, i) =>
          `  ${(i + 1).toString().padStart(2)}. ${m.file.padEnd(35)} ${(m.size / 1024).toFixed(1)}KB  ${m.mtime.toLocaleDateString()}  ${m.title}`,
      ),
      '',
      'Memories are used by the AI to provide personalized context across sessions.',
      'Each file in ~/.mipham/memory/ represents one remembered fact or preference.',
    ]

    return { content: lines.join('\n') }
  } catch {
    return { content: '─ Memory ─\n\nCould not read memory directory.' }
  }
}

// ═══════════════════════════════════════════════════════════════
// Upgrade
// ═══════════════════════════════════════════════════════════════

const upgradeCmd: CommandHandler = async () => {
  const { checkForUpdates, backupConfig, performUpdate, restoreConfig, getConfigPath } =
    await import('../shared/update')

  const update = checkForUpdates()

  if (!update.available) {
    return {
      content: `── Upgrade Mipham Code ──

Current version: v${update.current}
Latest:          v${update.latest}

✓ Already up to date.

To check manually: https://www.npmjs.com/package/@miphamai/cli`,
    }
  }

  // Update available — back up config and perform the upgrade
  const backupPath = backupConfig(`upgrade-v${update.current}`)

  const lines: string[] = [
    '── Upgrade Mipham Code ──',
    '',
    `Current version: v${update.current}`,
    `Latest:          v${update.latest}`,
    '',
    `→ New version available! Updating...`,
    '',
  ]

  if (backupPath) {
    lines.push(`Config backed up to: ${backupPath}`)
  }

  const ok = performUpdate(update.latest)

  if (ok) {
    const configPath = getConfigPath()
    const { existsSync } = await import('node:fs')
    lines.push('')
    lines.push(`✓ Updated to @miphamai/cli v${update.latest}`)

    if (existsSync(configPath)) {
      lines.push(`✓ Config preserved: ${configPath}`)
    } else if (backupPath) {
      if (restoreConfig(backupPath)) {
        lines.push('✓ Config restored from backup.')
      }
    }

    lines.push('')
    lines.push('⚠ The running Mipham Code process is still the old version.')
    lines.push('  Run `mipham` again to use the new version, or `mipham --version` to verify.')
  } else {
    lines.push('')
    lines.push('✗ Update failed.')
    lines.push(`  Try manually: ${NPM_UPDATE_COMMAND}`)
    if (backupPath) {
      lines.push(`  Your config backup is at: ${backupPath}`)
    }
  }

  return { content: lines.join('\n') }
}

// ═══════════════════════════════════════════════════════════════
// No-Plan — exit plan mode
// ═══════════════════════════════════════════════════════════════

const noPlanCmd: CommandHandler = () => ({
  content:
    '✓ Plan mode exited. Your plan has been discarded.\n\nContinue chatting as normal, or type /plan to start a new plan.',
})

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

const mcpCmd: CommandHandler = (ctx) => {
  const configuredServers = ctx.config.skills?.mcpServers ?? []
  const liveConnections = McpClient.getInstance().listConnections()

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
      const envKeys = s.env ? Object.keys(s.env).join(', ') : '(none)'

      lines.push(`  ${statusIcon} ${s.name}  [${statusLabel}]`)
      lines.push(`     Command: ${s.command} ${s.args.join(' ')}`)
      lines.push(`     Env vars: ${envKeys}`)
      if (live?.tools && live.tools.length > 0) {
        lines.push(`     Tools: ${live.tools.map((t) => t.name).join(', ')}`)
      }
      if (live?.error) {
        lines.push(`     Error: ${live.error}`)
      }
      if (live?.serverInfo) {
        lines.push(`     Server: ${live.serverInfo.name} v${live.serverInfo.version}`)
      }
      lines.push('')
    }
  } else {
    lines.push('No MCP servers configured.')
    lines.push('')
    lines.push('── Configuration ──')
    lines.push('')
    lines.push('Add MCP servers to .mipham/config.yml:')
    lines.push('')
    lines.push('  skills:')
    lines.push('    mcpServers:')
    lines.push('      - name: filesystem')
    lines.push('        command: npx')
    lines.push('        args: ["-y", "@anthropic/mcp-filesystem", "/path"]')
    lines.push('        env:')
    lines.push('          HOME: $HOME')
    lines.push('')
    lines.push('      - name: github')
    lines.push('        command: npx')
    lines.push('        args: ["-y", "@anthropic/mcp-github"]')
    lines.push('        env:')
    lines.push('          GITHUB_TOKEN: $GITHUB_TOKEN')
    lines.push('')
    lines.push('After configuring, restart Mipham Code to connect.')
    lines.push('Use the MCP tool (Tool 16) to call server tools.')
  }

  lines.push('')
  lines.push('── Protocol ──')
  lines.push('MCP stdio transport (JSON-RPC 2.0) — fully implemented.')
  lines.push('Servers auto-connect on startup when configured.')
  lines.push('')
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

const feedbackCmd: CommandHandler = (ctx, args) => {
  const message = args.join(' ').trim()

  const lines: string[] = ['── Feedback ──', '']

  if (message) {
    lines.push('Your feedback:')
    lines.push('')
    lines.push('  """')
    for (const line of message.split('\n')) {
      lines.push('  ' + line)
    }
    lines.push('  """')
    lines.push('')
    lines.push('── Preview Complete ──')
    lines.push('')
    lines.push('Copy the above and submit via one of the channels below.')
    lines.push('')
  }

  lines.push('── Feedback Channels ──')
  lines.push('')
  lines.push('  🐛 Bug Reports')
  lines.push('     GitHub Issues: https://github.com/One-Mipham/mipham-code/issues')
  lines.push('     Template:      Bug Report (include version + reproduction steps)')
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
      )
      const result = await sa.execute(prompt, 'fork: ' + prompt.slice(0, 60), {
        worktreePath: wtPath,
      })
      try {
        const { execSync: ex } = await import('node:child_process')
        ex(`git -C ${wtPath} add -A`, { stdio: 'ignore', timeout: 10_000 })
        const st = ex(`git -C ${wtPath} status --porcelain`, { encoding: 'utf-8', timeout: 10_000 })
        if (st.trim()) {
          ex(
            `git -C ${wtPath} commit -m "feat: ${prompt.slice(0, 60)}\n\nCo-Authored-By: Claude <noreply@anthropic.com>"`,
            { stdio: 'ignore', timeout: 10_000 },
          )
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
  const cmd =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`
  const { exec } = await import('node:child_process')
  exec(cmd, () => {
    /* fire-and-forget */
  })
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
    '/export': 'Session & Identity',
    '/doctor': 'Session & Identity',
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
    '/remove-skill': 'Tools & Skills',
    '/mcp': 'Tools & Skills',
    '/plugins': 'Plugins',
    '/browse-plugins': 'Plugins',
    '/install-plugin': 'Plugins',
    '/remove-plugin': 'Plugins',
    '/plugin-enable': 'Plugins',
    '/plugin-disable': 'Plugins',
    '/commands': 'Tools & Skills',
    '/plan': 'Workflow',
    '/no-plan': 'Workflow',
    '/tdd': 'Workflow',
    '/todos': 'Workflow',
    '/tasks': 'Workflow',
    '/review': 'Code Quality',
    '/pr-comments': 'Workflow',
    '/diff': 'Workflow',
    '/workflows': 'Workflow',
    '/deep-research': 'Workflow',
    '/loop': 'Workflow',
    '/init': 'Project',
    '/setup': 'Project',
    '/permissions': 'Project',
    '/add-dir': 'Project',
    '/recommend': 'Project',
    '/security': 'Project',
    '/audit': 'Project',
    '/prompt-audit': 'Code Quality',
    '/ide': 'Environment',
    '/terminal-setup': 'Environment',
    '/memory': 'Environment',
    '/release-notes': 'Environment',
    '/login': 'Account',
    '/logout': 'Account',
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
registry.set('/remove-skill', removeSkillCmd)
registry.set('/plugins', pluginsCmd)
registry.set('/browse-plugins', browsePluginsCmd)
registry.set('/install-plugin', installPluginCmd)
registry.set('/remove-plugin', removePluginCmd)
registry.set('/plugin-enable', pluginEnableCmd)
registry.set('/plugin-disable', pluginDisableCmd)
registry.set('/commands', commandsListCmd)

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
registry.set('/deep-research', deepResearchCmd)
registry.set('/review', reviewCmd)
registry.set('/pr-comments', prCommentsCmd)

// Session Management
registry.set('/doctor', doctorCmd)
registry.set('/export', exportCmd)
registry.set('/resume', resumeCmd)
registry.set('/resume last', resumeLastCmd)
registry.set('/resume delete', resumeDeleteCmd)
registry.set('/memory', memoryCmd)
registry.set('/upgrade', upgradeCmd)

// Project
registry.set('/init', initCmd)
registry.set('/setup', setupCmd)
registry.set('/recommend', recommendCmd)
registry.set('/permissions', permissionsCmd)
registry.set('/add-dir', addDirCmd)
registry.set('/security', securityCmd)
registry.set('/audit', securityCmd)
registry.set('/prompt-audit', promptAuditCmd)

// Environment
registry.set('/theme', themeCmd)
registry.set('/ide', ideCmd)
registry.set('/terminal-setup', terminalSetupCmd)
registry.set('/release-notes', releaseNotesCmd)

// Phase 4 — MCP, Auth, Feedback, Agents
registry.set('/mcp', mcpCmd)
registry.set('/login', loginCmd)
registry.set('/logout', logoutCmd)
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
  '/export': 'Export conversation to file',
  '/doctor': 'System diagnostics',
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
  '/tools': 'List available tools',
  '/skills': 'List loaded skills',
  '/reload-skills': 'Reload all skills',
  '/browse-skills': 'Browse community skill marketplace',
  '/install-skill': 'Install a skill by name or URL',
  '/remove-skill': 'Remove an installed skill',
  '/mcp': 'MCP server status',
  '/plugins': 'List installed plugins',
  '/browse-plugins': 'Browse community plugin marketplace',
  '/install-plugin': 'Install a plugin from npm or local path',
  '/remove-plugin': 'Remove an installed plugin',
  '/plugin-enable': 'Enable a disabled plugin',
  '/plugin-disable': 'Disable an enabled plugin',
  '/plan': 'Enter plan mode',
  '/no-plan': 'Exit plan mode',
  '/tdd': 'Test-Driven Development workflow (RED → GREEN → REFACTOR)',
  '/todos': 'Task management (list/create tasks)',
  '/tasks': 'Background tasks',
  '/review': 'Review code for bugs, security, performance (alias for /code-review)',
  '/pr-comments': 'PR review summary',
  '/diff': 'Show git diff',
  '/workflows': 'List workflow scripts',
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
  '/prompt-audit': 'Audit prompts for modern model optimization',
  '/ide': 'IDE integration guide',
  '/terminal-setup': 'Shell & terminal config',
  '/memory': 'Manage AI memories',
  '/release-notes': 'View version changelog',
  '/upgrade': 'Show upgrade instructions',
  '/login': 'Show API key status',
  '/logout': 'Clear credentials guide',
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
  '/hooks': 'Manage lifecycle hook scripts',
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
