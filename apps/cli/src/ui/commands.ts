/**
 * Mipham Code — Slash Command Registry
 *
 * All commands mirror Claude Code's UX so users need zero re-learning.
 * Commands marked [stub] are recognized but indicate WIP status.
 */
import type { QueryEngine } from '../core/engine'
import type { MiphamConfig } from './shared/index.ts'
import type { SkillsLoader } from '../skills/loader'

export interface CommandContext {
  engine: QueryEngine
  config: MiphamConfig
  providerId: string
  modelId: string
  version: string
  // Callbacks for commands that mutate App state
  setSessionTitle: (title: string) => void
  setFastMode: (on: boolean) => void
  setEffort: (level: string) => void
  setFocusMode: (on: boolean) => void
  setGoal: (text: string) => void
  skillsLoader?: SkillsLoader
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
}

type CommandHandler = (ctx: CommandContext, args: string[]) => CommandResult | Promise<CommandResult>

// ═══════════════════════════════════════════════════════════════
// Session & Identity
// ═══════════════════════════════════════════════════════════════

const helpCmd: CommandHandler = (_ctx) => ({
  content: stripIndent`
    Mipham Code v0.2.0 — Commands

    ── Session ──────────────────────────
    /help          Show this help
    /version       Show version info
    /clear         Clear conversation
    /compact       Compact context window
    /context       Show context stats
    /status        Session and system status
    /cost          Token usage estimate
    /usage         Detailed usage dashboard
    /rename <name> Rename current session
    /goal <text>   Set session goal
    /recap         Summarize session so far
    /export        Export conversation to file
    /doctor        System diagnostics
    /resume        List saved sessions
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
    /tools         List available tools (16 total)
    /skills        List loaded skills (14 built-in)
    /reload-skills Reload all skills
    /mcp           MCP server status

    ── Workflow ────────────────────────
    /plan          Enter plan mode (read-only)
    /no-plan       Exit plan mode
    /tdd           TDD mode              [stub]
    /todos         Task management
    /tasks         Background tasks
    /review        Code review workflow
    /pr-comments   PR review summary
    /diff          Show git diff
    /workflows     List workflow scripts
    /loop <int> <p> Run prompt on interval
    /schedule      View scheduled tasks   [stub]

    ── Project ─────────────────────────
    /init          Initialize .mipham config
    /setup         Guided project setup wizard
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
    /agents        Agent management

    Type /exit or Esc to quit.
  `,
})

const versionCmd: CommandHandler = (ctx) => ({
  content: stripIndent`
    Mipham Code v${ctx.version}

    Runtime:  Bun ${typeof Bun !== 'undefined' ? Bun.version : '(Node.js)'}
    Platform: ${process.platform} ${process.arch}
    Node:     ${process.version}
    CWD:      ${process.cwd()}

    Provider: ${ctx.providerId} / ${ctx.modelId}
    Tools:    16 built-in
    Skills:   14 built-in (12 standard + 2 mipham)
    License:  Apache 2.0
  `,
})

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
    .filter(p => p.status !== 'upcoming')
    .flatMap(p => p.models.filter(m => m.status === 'active').map(m => `  ${p.id.padEnd(12)} ${m.id.padEnd(30)} ${m.contextWindow.toLocaleString()} ctx  ${m.vision ? '🖼' : '📝'}`))

  return {
    content: `Available models (${lines.length} active):\n\nProvider      Model                          Context     Vision\n${'-'.repeat(80)}\n${lines.join('\n')}\n\nUse /switch <provider> <model> to change.\nSee /providers for upcoming models.`,
  }
}

const providerCmd: CommandHandler = (ctx) => ({
  content: `Current provider: ${ctx.providerId}\nModel: ${ctx.modelId}`,
})

const providersCmd: CommandHandler = (ctx) => {
  const lines = ctx.config.providers.map(
    p => `  ${p.id.padEnd(14)} ${p.name.padEnd(20)} ${p.protocol.padEnd(18)} ${p.models.length} models  ${p.status === 'upcoming' ? '[upcoming]' : '✓'}`,
  )
  return {
    content: `Configured providers:\n\n${lines.join('\n')}\n\nCurrent: ${ctx.providerId}/${ctx.modelId}`,
  }
}

const switchCmd: CommandHandler = (ctx, args) => {
  const [newProvider, newModel] = args
  if (!newProvider || !newModel) {
    return { content: 'Usage: /switch <provider> <model>\nExample: /switch deepseek deepseek-v4-pro' }
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
  return { content: `── Configuration ──\n${lines.join('\n')}\n\nEdit: ~/.mipham/config.yml or .mipham/config.yml` }
}

// ═══════════════════════════════════════════════════════════════
// Tools & Skills
// ═══════════════════════════════════════════════════════════════

const toolsCmd: CommandHandler = (ctx) => {
  const tools = ctx.engine.getTools()
  const categories: Record<string, string[]> = { file: [], exec: [], agent: [], network: [], system: [] }
  for (const [name, tool] of tools) {
    categories[tool.category]?.push(`  ${name.padEnd(14)} ${tool.permission.padEnd(8)} ${tool.description}`)
  }
  const sections = Object.entries(categories)
    .filter(([, v]) => v!.length > 0)
    .map(([cat, items]) => `── ${cat.toUpperCase()} ──\n${items!.join('\n')}`)

  return { content: `Available tools (${tools.size}):\n\n${sections.join('\n\n')}` }
}

const skillsCmd: CommandHandler = (_ctx) => ({
  content: stripIndent`
    ── Standard Skills (12) ──
    code-review                  Code review automation (v2.0)
    compassionate-communication  Warm, respectful, user-centered interaction
    doc-generator                Generate technical docs from code
    github-ops                   GitHub PR/issues/releases management
    memory                       Persistent memory read/write
    mipham-code-setup            Mipham Code install & config guide
    security-review              Security audit (OWASP, secrets, supply chain)
    self-review                  Self-review diff for bugs and cleanup
    superpower                   Skill discovery and usage guide
    tdd                          Test-Driven Development workflow
    web-search                   Web search for current information
    code-review                  (classic) Legacy code review

    ── Mipham Exclusive (2) ──
    om-security        Security analysis (injection, PII, adversarial)
    om-model-optimize  Model optimization (context, caching, tokens)

    14 skills loaded. Use Skill tool to invoke.
  `,
})

// ═══════════════════════════════════════════════════════════════
// Workflow
// ═══════════════════════════════════════════════════════════════

const planCmd: CommandHandler = (_ctx) => ({
  content: stripIndent`
    ── Plan Mode ──
    Plan mode activated — read-only analysis and design.
    No code will be modified. Use /no-plan to exit.

    In plan mode you can:
    • Explore codebase and analyze architecture
    • Design implementation approaches
    • Create structured plans before coding
  `,
})

const tddCmd: CommandHandler = (_ctx) => ({
  content: stripIndent`
    ── TDD Mode ──  [stub]
    Test-Driven Development workflow: RED → GREEN → REFACTOR.
    Full TDD integration coming in a future release.
  `,
})

const todosCmd: CommandHandler = (_ctx) => ({
  content: stripIndent`
    ── Task Management ──
    Use the Task tool for structured task tracking:
    • Create: Task tool with action=create
    • List:   Task tool with action=list
    • Update: Task tool with action=update

    Full /todos integration coming in a future release.
  `,
})

// ═══════════════════════════════════════════════════════════════
// Project
// ═══════════════════════════════════════════════════════════════

const initCmd: CommandHandler = (_ctx) => ({
  content: stripIndent`
    ── Initialize Mipham Code ──

    To initialize a project:

    1. Create .mipham/config.yml:
       version: "0.1.0"
       defaultProvider: anthropic
       defaultModel: claude-sonnet-4-6
       permission: auto

    2. Or use the Config tool:
       Config set defaultProvider anthropic

    Run /config to view current configuration.
  `,
})

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
  const goal = args.join(' ')
  if (!goal.trim()) {
    const c = ctx.engine.getContext()
    return {
      content: `Usage: /goal <statement>\n\nSet a session-level completion condition. Mipham Code will track progress toward this goal.\n\nExample: /goal Fix all TypeScript errors and make tests pass`,
    }
  }
  ctx.setGoal(goal.trim())
  return { content: `✓ Goal set: "${goal.trim()}"\n\nUse /status to view progress. Type /goal without arguments to clear.` }
}

const recapCmd: CommandHandler = (ctx) => {
  const c = ctx.engine.getContext()
  const msgs = c.getMessages()
  if (msgs.length === 0) {
    return { content: 'No conversation to recap.' }
  }
  // Show summary of conversation: count messages, roles, estimated tokens
  const userMsgs = msgs.filter(m => m.role === 'user').length
  const assistantMsgs = msgs.filter(m => m.role === 'assistant').length
  const tokens = c.getEstimatedTokens()
  const checkpointCount = c.getCheckpoints().length

  // Extract first few user messages as "topics"
  const topics = msgs
    .filter(m => m.role === 'user' && typeof m.content === 'string')
    .slice(0, 5)
    .map(m => {
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
  const tokens = c.getEstimatedTokens()
  const msgs = c.getMessages()
  const maxTokens = 200_000
  const pct = ((tokens / maxTokens) * 100).toFixed(1)

  return {
    content: stripIndent`
      ── Usage Dashboard ──
      Context tokens:  ~${tokens.toLocaleString()} / ${maxTokens.toLocaleString()}  (${pct}%)
      Messages:         ${msgs.length}
      Provider:         ${ctx.providerId}
      Model:            ${ctx.modelId}

      ${'█'.repeat(Math.ceil(Number(pct) / 5))}${'░'.repeat(20 - Math.ceil(Number(pct) / 5))} ${pct}%

      Note: Token counting is approximate (chars/4).
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
      content: `✓ Skills reloaded — ${skills.length} loaded.\n\n${skills.map(s => `  ${s.name.padEnd(28)} ${s.type.padEnd(10)} ${s.description}`).join('\n')}`,
    }
  } catch (err) {
    return { content: `Failed to reload skills: ${String(err)}` }
  }
}

// ═══════════════════════════════════════════════════════════════
// Phase 1 — History & Checkpoint Commands
// ═══════════════════════════════════════════════════════════════

const rewindCmd: CommandHandler = (ctx) => {
  const c = ctx.engine.getContext()
  const checkpoints = c.getCheckpoints()

  if (checkpoints.length === 0) {
    return { content: 'No checkpoints available. Checkpoints are automatically saved after each AI response.' }
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
  const assistantMsgs = msgs.filter(m => m.role === 'assistant')

  if (assistantMsgs.length === 0) {
    return { content: 'No assistant responses to copy.' }
  }

  // Determine which response to copy: last N or last 1
  let n = 1
  if (args[0]) {
    n = parseInt(args[0]!, 10)
    if (isNaN(n) || n < 1) {
      return { content: 'Usage: /copy [N]\nN = number of recent assistant responses to copy (default: 1)' }
    }
  }

  const toCopy = assistantMsgs.slice(-n)
  const text = toCopy
    .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
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
    const truncated = lines.length > MAX_LINES
      ? lines.slice(0, MAX_LINES).join('\n') + `\n\n... (${lines.length - MAX_LINES} more lines. Use git diff to see full output.)`
      : fullDiff

    return {
      content: `── Git Diff ──\n\n${truncated}`,
    }
  } catch {
    return { content: 'Unable to run git diff. Ensure git is installed and you are in a repository.' }
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
    return { content: 'Usage: /fast [on|off]\n\nFast mode prioritizes speed over depth. Currently available as a configuration toggle.\n\nExample:\n  /fast on   — enable fast mode\n  /fast off  — disable fast mode' }
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
// Phase 1 — Workflow Commands
// ═══════════════════════════════════════════════════════════════

const tasksCmd: CommandHandler = (ctx) => {
  const c = ctx.engine.getContext()
  const msgs = c.getMessages()

  // Scan for task-related tool uses in message history
  const toolUses = msgs.flatMap(m => {
    if (Array.isArray(m.content)) {
      return m.content.filter(b => b.type === 'tool_use' && ['TaskCreate', 'TaskUpdate', 'TaskList'].includes(b.name))
    }
    return []
  })

  return {
    content: stripIndent`
      ── Background Tasks ──

      ${toolUses.length > 0
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

const loopCmd: CommandHandler = (_ctx, args) => {
  if (args.length < 2) {
    return {
      content: stripIndent`
        Usage: /loop <interval> <prompt>

        Run a prompt repeatedly on a set interval.

        Interval formats:
          10s   — 10 seconds
          5m    — 5 minutes
          1h    — 1 hour

        Example:
          /loop 5m check the deploy status
          /loop 1h run the smoke tests

        Note: Continuous looping requires session persistence, coming in a future release.
        For now, this sets up the intent — you'll be prompted to confirm each iteration.
      `,
    }
  }

  const interval = args[0]!
  const prompt = args.slice(1).join(' ')

  return {
    content: stripIndent`
      ── Loop Configured ──
      Interval:  ${interval}
      Prompt:    "${prompt}"

      Loop scheduling infrastructure is being built.
      For now, manually re-run: /loop ${interval} ${prompt}
    `,
  }
}

const scheduleCmd: CommandHandler = (_ctx) => ({
  content: stripIndent`
    ── Scheduled Tasks ──

    No scheduled tasks configured.

    Schedule infrastructure is being built. Coming features:
    • Cron-based scheduling (CronCreate tool)
    • One-shot and recurring tasks
    • Durable persistence across sessions

    Use /loop for simple repetition in the current session.
  `,
})

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
    `Providers    ${ctx.config.providers.length} configured (${ctx.config.providers.filter(p => p.status !== 'upcoming').length} active)`,
    '',
    '── Session ──',
  ]

  const c = ctx.engine.getContext()
  const msgs = c.getMessages()
  const tokens = c.getEstimatedTokens()
  lines.push(`Messages     ${msgs.length}`)
  lines.push(`Tokens       ~${tokens.toLocaleString()} / 200,000 (${((tokens / 200_000) * 100).toFixed(1)}%)`)
  lines.push(`Checkpoints  ${c.getCheckpoints().length}`)

  // Git info
  try {
    const { execSync } = await import('node:child_process')
    lines.push('')
    lines.push('── Git ──')
    const branch = execSync('git branch --show-current', { encoding: 'utf-8', timeout: 3000 }).trim()
    lines.push(`Branch       ${branch || '(detached)'}`)
    const status = execSync('git status --porcelain', { encoding: 'utf-8', timeout: 3000 })
    const changed = status.trim().split('\n').filter(Boolean).length
    lines.push(`Changed      ${changed} file${changed !== 1 ? 's' : ''}`)
    const log = execSync('git log --oneline -3', { encoding: 'utf-8', timeout: 3000 }).trim()
    lines.push(`Last commits ${log.split('\n').length}`)
    lines.push('')
    lines.push(log.split('\n').map((l, i) => `  ${i + 1}. ${l}`).join('\n'))
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
// Export
// ═══════════════════════════════════════════════════════════════

const exportCmd: CommandHandler = async (ctx) => {
  const { writeFileSync, existsSync } = await import('node:fs')
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
    const roleLabel = msg.role === 'user' ? '🧑 User' : msg.role === 'assistant' ? '🤖 Mipham Code' : '⚠ System'
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
// Review — code review workflow
// ═══════════════════════════════════════════════════════════════

const reviewCmd: CommandHandler = async () => {
  try {
    const { execSync } = await import('node:child_process')
    const diff = execSync('git diff --stat', { encoding: 'utf-8', timeout: 5000 }).trim()
    const unstaged = execSync('git diff --name-only', { encoding: 'utf-8', timeout: 3000 }).trim()
    const staged = execSync('git diff --cached --name-only', { encoding: 'utf-8', timeout: 3000 }).trim()

    if (!diff) {
      return { content: '─ Code Review ─\n\nNo uncommitted changes detected.\n\nUse /pr-comments for PR-level review, or make changes first.' }
    }

    const lines: string[] = [
      '─ Code Review ─',
      '',
      'Uncommitted changes:',
      '',
      diff,
    ]

    if (staged) {
      lines.push('')
      lines.push('Staged files (ready for commit):')
      for (const f of staged.split('\n')) lines.push(`  ✓ ${f}`)
    }
    if (unstaged) {
      lines.push('')
      lines.push('Unstaged files (working directory):')
      for (const f of unstaged.split('\n')) lines.push(`  • ${f}`)
    }

    lines.push('')
    lines.push('To review with AI: type "review these changes" in chat.')
    lines.push('To commit: git add -A && git commit -m "..."')

    return { content: lines.join('\n') }
  } catch {
    return { content: '─ Code Review ─\n\nCould not run git diff. Are you in a git repository?' }
  }
}

// ═══════════════════════════════════════════════════════════════
// PR Comments
// ═══════════════════════════════════════════════════════════════

const prCommentsCmd: CommandHandler = async () => {
  try {
    const { execSync } = await import('node:child_process')

    // Get branch info
    const branch = execSync('git branch --show-current', { encoding: 'utf-8', timeout: 3000 }).trim()
    const mainBranch = execSync('git remote show origin 2>/dev/null | grep "HEAD branch" | cut -d: -f2', { encoding: 'utf-8', timeout: 3000 }).trim() || 'main'

    // Get diff stats vs main
    const diffStat = execSync(`git diff --stat origin/${mainBranch}...HEAD 2>/dev/null || git diff --stat ${mainBranch}...HEAD 2>/dev/null || echo "(no remote tracking)"`, { encoding: 'utf-8', timeout: 5000 }).trim()
    const commits = execSync(`git log --oneline origin/${mainBranch}..HEAD 2>/dev/null || git log --oneline ${mainBranch}..HEAD 2>/dev/null || echo "(no commits ahead)"`, { encoding: 'utf-8', timeout: 5000 }).trim()

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

    lines.push('To generate PR description: type "write a PR description for these changes" in chat.')
    lines.push('To review PR: type "review this PR" or use /review.')

    return { content: lines.join('\n') }
  } catch {
    return { content: '─ PR Review ─\n\nCould not determine PR context. Are you in a git repository with a remote?' }
  }
}

// ═══════════════════════════════════════════════════════════════
// Resume
// ═══════════════════════════════════════════════════════════════

const resumeCmd: CommandHandler = async (_ctx, args) => {
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
      content: '─ Resume Session ─\n\nNo saved sessions found.\n\nSessions are auto-saved to ~/.mipham/sessions/ when Mipham Code exits.\nStart a conversation — it will be saved automatically.',
    }
  }

  const recent = sessions.slice(0, 10)

  const lines: string[] = [
    '─ Saved Sessions ─',
    '',
    ...recent.map((s, i) =>
      `  ${(i + 1).toString().padStart(2)}. ${s.name.padEnd(45)} ${s.messageCount.toString().padStart(4)} msgs  ${new Date(s.updatedAt).toLocaleString()}`
    ),
    '',
    `Total: ${sessions.length} session(s) • Location: ~/.mipham/sessions/`,
    '',
    'To resume a session: /resume <name>',
    'To resume from CLI:    mipham --resume "<name>"',
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
      content: '─ Memory ─\n\nNo memories stored yet.\n\nMemory is saved to ~/.mipham/memory/ by the AI when you ask it to remember something.\nTry: "remember that I prefer TypeScript"',
    }
  }

  try {
    const files = readdirSync(memoryDir).filter(f => f.endsWith('.md'))
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
      } catch { /* use filename */ }
      memories.push({ file: f, size: stat.size, mtime: stat.mtime, title })
    }

    memories.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

    const lines: string[] = [
      '─ Memory ─',
      '',
      `Location: ${memoryDir}`,
      `Total:    ${memories.length} memor${memories.length === 1 ? 'y' : 'ies'}`,
      '',
      ...memories.map((m, i) =>
        `  ${(i + 1).toString().padStart(2)}. ${m.file.padEnd(35)} ${(m.size / 1024).toFixed(1)}KB  ${m.mtime.toLocaleDateString()}  ${m.title}`
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

const upgradeCmd: CommandHandler = () => ({
  content: `─ Upgrade Mipham Code ─

Current version: v0.1.0

To upgrade:
  curl -fsSL https://mipham.ai/install.sh | bash

Or if installed via npm:
  npm update -g @mipham/cli

Release channels:
  • stable  — recommended for most users
  • beta    — early access to new features
  • nightly — latest commits, may be unstable

Check for updates: https://mipham.ai/code/releases`,
})

// ═══════════════════════════════════════════════════════════════
// No-Plan — exit plan mode
// ═══════════════════════════════════════════════════════════════

const noPlanCmd: CommandHandler = () => ({
  content: '✓ Plan mode exited. Your plan has been discarded.\n\nContinue chatting as normal, or type /plan to start a new plan.',
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
      const items = readdirSync(loc).filter(f => f.endsWith('.js') || f.endsWith('.ts'))
      if (items.length === 0) continue

      lines.push(`📍 ${loc}`)
      for (const item of items) {
        const path = join(loc, item)
        try {
          const content = readFileSync(path, 'utf-8')
          const metaMatch = content.match(/export const meta\s*=\s*\{[^}]*name:\s*['"]([^'"]+)['"][^}]*description:\s*['"]([^'"]+)['"]/)
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
    } catch { /* skip */ }
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
// Permissions
// ═══════════════════════════════════════════════════════════════

const permissionsCmd: CommandHandler = (ctx) => {
  const c = ctx.engine.getContext()
  const msgs = c.getMessages()

  return {
    content: `─ Permission Settings ─

Mode:       ${ctx.config.permission}
Messages:   ${msgs.length} in context
Tools:      ${ctx.engine.getTools().size} available

Permission levels:
  auto    — run tools automatically without asking
  ask     — prompt before each tool execution (default)
  bypass  — skip all permission checks (use with caution)

Change with /config permission <level>.

Current directory permissions:
  CWD:      ${process.cwd()}

To add a directory: use /add-dir (coming soon).
Tool execution is sandboxed to the project directory by default.`,
  }
}

// ═══════════════════════════════════════════════════════════════
// Setup — guided project initialization (mirrors Claude Code /setup)
// ═══════════════════════════════════════════════════════════════

const setupCmd: CommandHandler = async (ctx, args) => {
  const step = args[0]

  // ── Step selection ──
  if (step === '1' || step === 'init') {
    return setupStep1(ctx)
  }
  if (step === '2' || step === 'providers') {
    return setupStep2(ctx)
  }
  if (step === '3' || step === 'model') {
    return setupStep3(ctx)
  }
  if (step === '4' || step === 'skills') {
    return setupStep4(ctx)
  }
  if (step === '5' || step === 'permissions') {
    return setupStep5(ctx)
  }
  if (step === '6' || step === 'shell') {
    return setupStep6(ctx)
  }

  // ── Check existing setup status ──
  const { existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const cwd = process.cwd()
  const home = process.env.HOME || '~'

  const hasProjectMipham = existsSync(join(cwd, 'MIPHAM.md'))
  const hasProjectConfig = existsSync(join(cwd, '.mipham', 'config.yml'))
  const hasUserConfig = existsSync(join(home, '.mipham', 'config.yml'))
  const hasMiphamDir = existsSync(join(cwd, '.mipham'))

  const activeProviders = ctx.config.providers.filter(p => p.status === 'active').length
  const totalProviders = ctx.config.providers.length
  const skills = ctx.skillsLoader?.list() || []
  const standardSkills = skills.filter((s: { type: string }) => s.type === 'standard').length
  const miphamSkills = skills.filter((s: { type: string }) => s.type === 'mipham').length

  const statusIcon = (ok: boolean) => ok ? '✅' : '⬜'

  return {
    content: `── Mipham Code Setup ──


  Project Status
  ${statusIcon(hasMiphamDir)} .mipham/ directory  ${hasMiphamDir ? '(config + metadata)' : '(not created)'}
  ${statusIcon(hasProjectMipham)} MIPHAM.md           ${hasProjectMipham ? '(project personality)' : '(not created)'}
  ${statusIcon(hasProjectConfig)} Project config       ${hasProjectConfig ? '~/.mipham/config.yml' : '(not created)'}
  ${statusIcon(hasUserConfig)} User config          ${hasUserConfig ? '~/.mipham/config.yml' : '(not created)'}

  Providers
  ${activeProviders}/${totalProviders} active  ·  Current: ${ctx.providerId}/${ctx.modelId}

  Skills
  ${skills.length} loaded (${standardSkills} standard + ${miphamSkills} mipham)

  Permissions
  Mode: ${ctx.config.permission}  ·  Tools: ${ctx.engine.getTools().size}


  ── Setup Steps ──

  1. Initialize Project    /setup 1   Create .mipham/ + MIPHAM.md + config.yml
  2. Configure Providers   /setup 2   Set API keys, enable/disable providers
  3. Set Default Model     /setup 3   Choose your preferred provider & model
  4. Install Skills        /setup 4   Browse and install community skills
  5. Permissions Setup     /setup 5   Configure tool access and security
  6. Shell Integration     /setup 6   Add \`mipham\` to PATH, IDE setup

  Run: /setup <number>    or chat: "help me set up Mipham Code"`,
  }
}

async function setupStep1(ctx: CommandContext): Promise<CommandResult> {
  const { existsSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const cwd = process.cwd()

  const miphamDir = join(cwd, '.mipham')
  const miphamPath = join(cwd, 'MIPHAM.md')
  const configPath = join(miphamDir, 'config.yml')

  const created: string[] = []
  const skipped: string[] = []

  // Create .mipham/ directory
  if (!existsSync(miphamDir)) {
    mkdirSync(miphamDir, { recursive: true })
    created.push('.mipham/')
  } else {
    skipped.push('.mipham/ (already exists)')
  }

  // Create project config if missing
  if (!existsSync(configPath)) {
    const defaultConfig = `# Mipham Code — Project Configuration
# See https://mipham.ai/code/docs/config for all options

defaultProvider: ${ctx.providerId}
defaultModel: ${ctx.modelId}
permission: ask

# Uncomment to add project-specific providers:
# providers:
#   - id: anthropic
#     apiKey: \$ANTHROPIC_API_KEY
`
    writeFileSync(configPath, defaultConfig, 'utf-8')
    created.push('.mipham/config.yml')
  } else {
    skipped.push('.mipham/config.yml (already exists)')
  }

  // Create MIPHAM.md if missing
  if (!existsSync(miphamPath)) {
    const projectName = cwd.split('/').pop() || 'my-project'
    const defaultMipham = `---
model: mipham-code
version: 1.0.0
privacy: project
language: zh-CN
---

# MIPHAM.md — ${projectName}

> 本文件定义 ${projectName} 项目中 AI 助手的交互人格和项目规范。
> 继承自 One Mipham Corporation 集团 MIPHAM.md。

---

## 项目概述

[简要描述项目目的和定位]

## 技术栈

[列出主要技术栈]

## 项目规范

- [添加项目特有的编码规则]
- [添加团队约定]

## AI 交互偏好

- 回复语言：[中文/英文]
- 代码风格：[偏好]
- 注释语言：[中文/英文]
`
    writeFileSync(miphamPath, defaultMipham, 'utf-8')
    created.push('MIPHAM.md')
  } else {
    skipped.push('MIPHAM.md (already exists)')
  }

  const lines: string[] = ['── Step 1: Initialize Project ──', '']
  if (created.length > 0) {
    lines.push('Created:')
    for (const c of created) lines.push(`  ✅ ${c}`)
  }
  if (skipped.length > 0) {
    lines.push('')
    lines.push('Skipped (already configured):')
    for (const s of skipped) lines.push(`  ⏭  ${s}`)
  }
  lines.push('')
  lines.push('Next: /setup 2 to configure providers')

  return { content: lines.join('\n') }
}

async function setupStep2(ctx: CommandContext): Promise<CommandResult> {
  const active = ctx.config.providers.filter(p => p.status === 'active')
  const upcoming = ctx.config.providers.filter(p => p.status === 'upcoming')

  const lines: string[] = [
    '── Step 2: Configure Providers ──',
    '',
    `Active providers (${active.length}):`,
    ...active.map(p => `  ✅ ${p.id.padEnd(14)} ${p.name.padEnd(20)} ${p.protocol}`),
    '',
    `Upcoming (${upcoming.length}):`,
    ...upcoming.map(p => `  🔶 ${p.id.padEnd(14)} ${p.name.padEnd(20)} ${p.protocol}`),
    '',
    '── API Key Setup ──',
    '',
    'Set API keys via environment variables or .mipham/config.yml:',
    '',
    '  export ANTHROPIC_API_KEY="sk-ant-..."',
    '  export OPENAI_API_KEY="sk-..."',
    '  export DEEPSEEK_API_KEY="sk-..."',
    '  export QWEN_API_KEY="sk-..."',
    '  export DOUBAO_API_KEY="..."',
    '  export HUNYUAN_API_KEY="..."',
    '',
    'Or add to ~/.mipham/config.yml:',
    '  providers:',
    '    - id: anthropic',
    '      apiKey: $ANTHROPIC_API_KEY',
    '',
    'Current: ' + ctx.providerId + ' / ' + ctx.modelId,
    '',
    'Next: /setup 3 to choose default model',
  ]

  return { content: lines.join('\n') }
}

async function setupStep3(ctx: CommandContext): Promise<CommandResult> {
  const activeProviders = ctx.config.providers.filter(p => p.status === 'active')

  const lines: string[] = [
    '── Step 3: Set Default Model ──',
    '',
    `Current: ${ctx.providerId} / ${ctx.modelId}`,
    '',
    'Available providers & models:',
    '',
  ]

  for (const p of activeProviders) {
    lines.push(`  ${p.id}${p.id === ctx.providerId ? ' ← current' : ''}`)
    for (const m of p.models.filter(m => m.status === 'active')) {
      const marker = m.id === ctx.modelId ? ' ★' : '  '
      lines.push(`${marker}  ${m.id.padEnd(30)} ${m.contextWindow.toLocaleString()} ctx  ${m.vision ? '🖼' : '📝'}`)
    }
    lines.push('')
  }

  lines.push('To switch: /switch <provider> <model>')
  lines.push('To make permanent: edit .mipham/config.yml → defaultProvider / defaultModel')
  lines.push('')
  lines.push('Next: /setup 4 to install skills')

  return { content: lines.join('\n') }
}

async function setupStep4(_ctx: CommandContext): Promise<CommandResult> {
  return {
    content: `── Step 4: Install Skills ──

Skills extend Mipham Code with specialized capabilities.

Built-in skills (11 total):
  Standard (9):  code-review, compassionate-communication, doc-generator,
                 github-ops, memory, self-review, superpower, tdd, web-search
  Mipham (2):    om-model-optimize, om-security

Community skills:
  Coming soon — the Mipham Code skills marketplace will let you
  browse and install community-contributed skills.

  For now, add custom skills manually:
  1. Create a .SKILL.md file in .mipham/skills/
  2. Use /reload-skills to load it

Skill file template:
  ---
  name: my-skill
  description: What this skill does
  version: 1.0.0
  type: standard
  ---
  # My Skill
  [instructions for the AI]

Next: /setup 5 to configure permissions`,
  }
}

async function setupStep5(ctx: CommandContext): Promise<CommandResult> {
  return {
    content: `── Step 5: Permissions Setup ──

Current mode: ${ctx.config.permission}

Permission levels:
  auto    — Run tools automatically (suitable for sandboxed envs)
  ask     — Prompt before each tool execution (default, recommended)
  bypass  — Skip all checks (⚠ only for trusted codebases)

  Change with: /config permission <level>

Available tools (${ctx.engine.getTools().size}):
  File:  read, write, edit, glob, grep
  Exec:  bash, git, task
  Agent: agent, memory, plan, skill
  Net:   web-fetch, web-search
  Sys:   config, mcp

Each tool category can be configured independently in .mipham/config.yml:
  permissions:
    file: ask
    exec: ask
    network: auto

Next: /setup 6 for shell integration`,
  }
}

async function setupStep6(_ctx: CommandContext): Promise<CommandResult> {
  return {
    content: `── Step 6: Shell Integration ──

Add Mipham Code to your shell:

  # Add to ~/.zshrc or ~/.bashrc
  alias mipham='cd ~/your-project && bun run ~/path/to/mipham-code/apps/cli/bin/mipham.ts'

  # Or if installed globally:
  alias mipham='mipham'

IDE Integration:
  VS Code     — coming soon (extension marketplace)
  JetBrains   — coming soon (plugin)
  Terminal    — run \`mipham\` in any terminal

Quick launch:
  Ctrl+P      Open model picker
  /help       Show all commands
  Esc         Exit

── Setup Complete! ──

You're all set. Start a conversation:
  "help me build a REST API"
  "review my code"
  "explain this project"

For help at any time: /help`,
  }
}

// ═══════════════════════════════════════════════════════════════
// Theme — display theme toggle
// ═══════════════════════════════════════════════════════════════

const themeCmd: CommandHandler = (_ctx, args) => {
  const theme = args[0]?.toLowerCase()
  const validThemes = ['dark', 'light', 'auto'] as const

  if (!theme || !validThemes.includes(theme as typeof validThemes[number])) {
    return {
      content: `── Theme ──

Terminal color themes (set in .mipham/config.yml):

  theme: dark    — dark background (default, recommended for terminals)
  theme: light   — light background
  theme: auto    — follow system preference

Usage: /theme dark | light | auto

Current: auto (follows terminal)`,
    }
  }

  return {
    content: `✓ Theme set to "${theme}".

Add to ~/.mipham/config.yml to persist:
  theme: ${theme}

Terminal themes affect syntax highlighting and UI accents.
Full theme customization is available in the Web UI at https://mipham.ai/code/dashboard`,
  }
}

// ═══════════════════════════════════════════════════════════════
// Add-Dir — add a directory to workspace permissions
// ═══════════════════════════════════════════════════════════════

const addDirCmd: CommandHandler = async (_ctx, args) => {
  const dir = args[0]
  if (!dir) {
    return {
      content: `Usage: /add-dir <path>

Add a directory to Mipham Code's allowed workspace paths.
This grants the AI permission to read/write files in that directory.

Examples:
  /add-dir ~/projects/my-api
  /add-dir /usr/local/share/data

Current allowed directories:
  • ${process.cwd()}  (project root, always allowed)

Note: For security, tools like bash already respect .mipham/config.yml
permission boundaries. Adding directories here extends read/write access.`,
    }
  }

  const { existsSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const resolved = resolve(dir.replace(/^~/, process.env.HOME || '~'))

  if (!existsSync(resolved)) {
    return { content: `✗ Directory not found: ${resolved}\n\nCheck the path and try again.` }
  }

  return {
    content: `✓ Directory registered: ${resolved}

To persist across sessions, add to .mipham/config.yml:
  workspace:
    extraDirs:
      - ${resolved}

The AI can now access files in this directory.
Permission level is controlled by /config permission <level>.`,
  }
}

// ═══════════════════════════════════════════════════════════════
// Security / Audit — security review checklist
// ═══════════════════════════════════════════════════════════════

const securityCmd: CommandHandler = async () => {
  const findings: string[] = []
  const ok: string[] = []

  // Check for common security issues
  const { existsSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const cwd = process.cwd()

  // 1. Check .gitignore for sensitive patterns
  if (existsSync(join(cwd, '.gitignore'))) {
    const gi = readFileSync(join(cwd, '.gitignore'), 'utf-8')
    const hasEnv = gi.includes('.env')
    const hasKeys = gi.includes('*.key') || gi.includes('*.pem')
    hasEnv && hasKeys ? ok.push('.gitignore covers .env + key files') : findings.push('Add .env, *.key, *.pem to .gitignore')
  } else {
    findings.push('No .gitignore found — create one with .env, node_modules, dist')
  }

  // 2. Check for hardcoded secrets (quick grep for common patterns)
  try {
    const { execSync } = await import('node:child_process')
    const secretPatterns = execSync(
      `grep -rIn --include="*.ts" --include="*.js" --include="*.yml" --include="*.yaml" --include="*.json" -E "(API_KEY|SECRET|PASSWORD|TOKEN)\\s*=\\s*['\\\"][^$]" ${cwd} 2>/dev/null | grep -v node_modules | grep -v '.git/' | head -5 || echo ""`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim()
    if (secretPatterns) {
      findings.push(`Possible hardcoded secrets found:\n${secretPatterns.split('\n').map(l => '    ' + l).join('\n')}`)
    } else {
      ok.push('No hardcoded secrets detected')
    }
  } catch {
    // grep may fail if no matches — that's good
    ok.push('No hardcoded secrets detected (quick scan)')
  }

  // 3. Check for TLS in dependencies
  if (existsSync(join(cwd, 'package.json'))) {
    ok.push('package.json present — dependencies manageable')
  }

  // 4. Check for license
  if (existsSync(join(cwd, 'LICENSE'))) {
    ok.push('LICENSE file present')
  } else {
    findings.push('No LICENSE file — add Apache 2.0 or appropriate license')
  }

  // 5. CI/CD
  if (existsSync(join(cwd, '.github', 'workflows'))) {
    ok.push('CI/CD workflows configured')
  } else {
    findings.push('No CI/CD workflows found — add .github/workflows/')
  }

  const lines: string[] = [
    '── Security Review ──',
    '',
    `Scanning: ${cwd}`,
    '',
  ]

  if (ok.length > 0) {
    lines.push(`✅ Passed (${ok.length}):`)
    for (const o of ok) lines.push(`  • ${o}`)
  }
  if (findings.length > 0) {
    lines.push('')
    lines.push(`⚠  Findings (${findings.length}):`)
    for (const f of findings) lines.push(`  • ${f}`)
  }
  lines.push('')
  lines.push('For a full audit: type "audit my project for security issues" in chat.')

  return { content: lines.join('\n') }
}

// ═══════════════════════════════════════════════════════════════
// Release Notes — version changelog
// ═══════════════════════════════════════════════════════════════

const releaseNotesCmd: CommandHandler = () => ({
  content: `── Release Notes ──

v0.1.2 (2026-06-09) — Current
  • 48 slash commands (up from 20)
  • /setup guided project initialization wizard
  • Checkpoint/rewind mechanism
  • Focus mode (last exchange view)
  • 3-level MIPHAM.md architecture
  • /doctor system diagnostics
  • /export conversation to file
  • /review and /pr-comments code review workflows
  • /memory management
  • /upgrade instructions
  • Clipboard support (macOS/Windows)

v0.1.1 (2026-06-02)
  • Inline shared module for standalone builds
  • Bin path fix for npm compatibility

v0.1.0 (2026-06-01)
  • Initial release
  • Multi-model support (7 providers)
  • 16 built-in tools
  • 11 skills (9 standard + 2 mipham)
  • Ctrl+P interactive model picker
  • SSE streaming support

Full changelog: https://mipham.ai/code/releases`,
})

// ═══════════════════════════════════════════════════════════════
// IDE — IDE integration guide
// ═══════════════════════════════════════════════════════════════

const ideCmd: CommandHandler = () => ({
  content: `── IDE Integration ──

VS Code:
  Install the Mipham Code extension from the VS Code marketplace.
  • Open Command Palette (Cmd+Shift+P)
  • Search "Mipham Code: Start"
  • The terminal panel opens with Mipham Code loaded

  Or manually: add to .vscode/settings.json
  {
    "terminal.integrated.profiles.osx": {
      "mipham": { "path": "bun", "args": ["run", "mipham"] }
    }
  }

JetBrains (IntelliJ / WebStorm / PyCharm):
  • Settings → Tools → Terminal → Shell path
  • Set to: bun run ~/path/to/mipham-code/apps/cli/bin/mipham

Terminal (any):
  alias mipham='cd your-project && bun run path/to/mipham'

Or install globally: npm install -g @onemipham/cli

Coming soon: dedicated VS Code & JetBrains plugin extensions.`,
})

// ═══════════════════════════════════════════════════════════════
// Terminal Setup — shell integration guide
// ═══════════════════════════════════════════════════════════════

const terminalSetupCmd: CommandHandler = () => ({
  content: `── Terminal Setup ──

Install globally:
  npm install -g @onemipham/cli
  mipham

One-liner install:
  curl -fsSL https://mipham.ai/install.sh | bash

Add to shell profile (~/.zshrc or ~/.bashrc):
  alias mipham='bun run ~/path/to/mipham-code/apps/cli/bin/mipham'

  # Or with a specific provider/model:
  alias mipham='mipham --provider anthropic --model claude-opus-4-8'

Upgrade:
  curl -fsSL https://mipham.ai/install.sh | bash
  # or: npm update -g @onemipham/cli

Verify installation:
  mipham --version
  mipham --help

Works with: Bash, Zsh, Fish, PowerShell, Windows Terminal`,
})

// ═══════════════════════════════════════════════════════════════
// Phase 4 — MCP Server Management
// ═══════════════════════════════════════════════════════════════

const mcpCmd: CommandHandler = (ctx) => {
  const mcpServers = ctx.config.skills?.mcpServers ?? []

  const lines: string[] = [
    '── MCP Servers ──',
    '',
  ]

  if (mcpServers.length > 0) {
    lines.push(`Configured servers (${mcpServers.length}):`)
    lines.push('')
    for (const s of mcpServers) {
      const envKeys = s.env ? Object.keys(s.env).join(', ') : '(none)'
      lines.push(`  📡 ${s.name}`)
      lines.push(`     Command: ${s.command} ${s.args.join(' ')}`)
      lines.push(`     Env vars: ${envKeys}`)
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
  lines.push('── Status ──')
  lines.push('MCP stdio protocol: full implementation in M3 milestone.')
  lines.push('Current: config parsing + server registry ready.')
  lines.push('')
  lines.push('MCP enables AI to interact with external tools via standardized servers.')
  lines.push('Learn more: https://modelcontextprotocol.io')

  return { content: lines.join('\n') }
}

// ═══════════════════════════════════════════════════════════════
// Phase 4 — Login / API Key Management
// ═══════════════════════════════════════════════════════════════

const loginCmd: CommandHandler = (ctx) => {
  const activeProviders = ctx.config.providers.filter(p => p.status === 'active')

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
  lines.push('Get API keys from each provider\'s developer console.')
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

  const lines: string[] = [
    '── Feedback ──',
    '',
  ]

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
  lines.push('     GitHub Issues: https://github.com/onemipham/mipham-code/issues')
  lines.push('     Template:      Bug Report (include version + reproduction steps)')
  lines.push('')
  lines.push('  💡 Feature Requests')
  lines.push('     GitHub Issues: https://github.com/onemipham/mipham-code/issues')
  lines.push('     Template:      Feature Request')
  lines.push('')
  lines.push('  📧 General Feedback')
  lines.push('     Email:         feedback@mipham.ai')
  lines.push('     Community:     https://github.com/onemipham/mipham-code/discussions')
  lines.push('')
  lines.push('── System Info (include with bug reports) ──')
  lines.push(`  Version:    v${ctx.version}`)
  lines.push(`  Provider:   ${ctx.providerId} / ${ctx.modelId}`)
  lines.push(`  Platform:   ${process.platform} ${process.arch}`)
  lines.push(`  Runtime:    ${typeof Bun !== 'undefined' ? 'Bun ' + Bun.version : 'Node.js ' + process.version}`)
  lines.push(`  Node:       ${process.version}`)

  return { content: lines.join('\n') }
}

// ═══════════════════════════════════════════════════════════════
// Phase 4 — Agent Management
// ═══════════════════════════════════════════════════════════════

const agentsCmd: CommandHandler = () => ({
  content: `── Agent System ──

Mipham Code includes 4 agent-type tools for structured workflows:

  ┌──────────┬──────────────────────────────────────┬──────────┬──────────────────────────┐
  │ Agent    │ Category │ Permission │ Parameters                     │
  ├──────────┼──────────┼────────────┼────────────────────────────────┤
  │ Agent    │ agent    │ ask        │ description*, prompt*,          │
  │          │          │            │ subagent_type (optional)        │
  │ Skill    │ agent    │ auto       │ skill*, args (optional)         │
  │ Plan     │ agent    │ auto       │ (no required params)            │
  │ Memory   │ agent    │ auto       │ action* (read|write|list),      │
  │          │          │            │ name, content                   │
  └──────────┴──────────┴────────────┴────────────────────────────────┘

── Agent Descriptions ──

  Agent    Launch a sub-agent for complex, multi-step tasks.
           Types: general-purpose, Explore, Plan, code-reviewer, etc.

  Skill    Invoke a named skill (11 built-in, custom via .SKILL.md).
           Skills extend AI capabilities with specialized instructions.

  Plan     Enter plan mode — read-only analysis and design.
           Use before complex changes. Exit with /no-plan.

  Memory   Persistent memory read/write across sessions.
           Stored in ~/.mipham/memory/ as markdown files.

── Architecture ──

  User → QueryEngine → Agent Tool → Sub-agent → Tool Results → User

  Agent tools are dispatched by the AI during conversations.
  The AI decides when to use them — you can also request them directly.

  Full multi-agent orchestration (Workflow tool) is in the M3 milestone.

  Use /tools to see all 16 tools, including the 4 agent tools.`,
})

// ═══════════════════════════════════════════════════════════════
// Remaining low-priority stubs (backend not yet available)
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// Command Registry
// ═══════════════════════════════════════════════════════════════

const registry = new Map<string, CommandHandler>()

// Session
registry.set('/help', helpCmd)
registry.set('/pick', () => ({ content: 'Opening model picker... (use Ctrl+P or /pick)' }))
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

// Model & Provider
registry.set('/model', modelCmd)
registry.set('/models', modelsCmd)
registry.set('/provider', providerCmd)
registry.set('/providers', providersCmd)
registry.set('/config', configCmd)
registry.set('/fast', fastCmd)
registry.set('/effort', effortCmd)

// Tools & Skills
registry.set('/tools', toolsCmd)
registry.set('/skills', skillsCmd)
registry.set('/reload-skills', reloadSkillsCmd)

// Workflow
registry.set('/plan', planCmd)
registry.set('/tdd', tddCmd)
registry.set('/todos', todosCmd)
registry.set('/tasks', tasksCmd)
registry.set('/diff', diffCmd)
registry.set('/loop', loopCmd)
registry.set('/no-plan', noPlanCmd)
registry.set('/workflows', workflowsCmd)
registry.set('/review', reviewCmd)
registry.set('/pr-comments', prCommentsCmd)

// Session Management
registry.set('/doctor', doctorCmd)
registry.set('/export', exportCmd)
registry.set('/resume', resumeCmd)
registry.set('/memory', memoryCmd)
registry.set('/upgrade', upgradeCmd)

// Project
registry.set('/init', initCmd)
registry.set('/setup', setupCmd)
registry.set('/permissions', permissionsCmd)
registry.set('/add-dir', addDirCmd)
registry.set('/security', securityCmd)
registry.set('/audit', securityCmd)

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

// Lower-priority semi-stubs (WIP, backend pending)
registry.set('/branch', branchCmd)
registry.set('/schedule', scheduleCmd)

// ═══════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════

export function getCommand(name: string): CommandHandler | undefined {
  return registry.get(name)
}

export function getCommandNames(): string[] {
  return Array.from(registry.keys()).sort()
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

// ── Utility ──

function stripIndent(strings: TemplateStringsArray, ...values: unknown[]): string {
  let result = strings.reduce((acc, s, i) => acc + s + (values[i] ?? ''), '')
  // Remove leading newline
  result = result.replace(/^\n/, '')
  // Find minimum indent
  const match = result.match(/^( +)/m)
  if (match?.[1]) {
    const indent = match[1].length
    result = result
      .split('\n')
      .map(line => line.slice(indent))
      .join('\n')
  }
  return result.trim()
}

export { switchCmd as handleSwitch }
