/**
 * Mipham Code — Slash Command Registry
 *
 * All commands mirror Claude Code's UX so users need zero re-learning.
 * Commands marked [stub] are recognized but indicate WIP status.
 */
import type { QueryEngine } from '../core/engine'
import type { MiphamConfig } from '@mipham/shared'

export interface CommandContext {
  engine: QueryEngine
  config: MiphamConfig
  providerId: string
  modelId: string
  version: string
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
}

type CommandHandler = (ctx: CommandContext, args: string[]) => CommandResult | Promise<CommandResult>

// ═══════════════════════════════════════════════════════════════
// Session & Identity
// ═══════════════════════════════════════════════════════════════

const helpCmd: CommandHandler = (_ctx) => ({
  content: stripIndent`
    Mipham Code v0.1.0 — Commands

    ── Session ──────────────────────────
    /help          Show this help
    /version       Show version info
    /clear         Clear conversation
    /compact       Compact context window
    /context       Show context stats
    /status        Session and system status
    /cost          Token usage estimate
    /export        Export conversation  [stub]
    /doctor        System diagnostics   [stub]
    /resume        Resume a session     [stub]

    ── Model & Provider ────────────────
    /pick          Open model picker (or Ctrl+P)
    /model         Show current model
    /models        List all available models
    /provider      Show current provider
    /providers     List configured providers
    /switch <p> <m> Switch provider and model
    /config        View configuration
    /theme         Change theme          [stub]

    ── Tools & Skills ──────────────────
    /tools         List available tools (16 total)
    /skills        List loaded skills (10 built-in)
    /mcp           MCP server status     [stub]

    ── Workflow ────────────────────────
    /plan          Enter plan mode (read-only)
    /no-plan       Exit plan mode        [stub]
    /tdd           TDD mode              [stub]
    /todos         Task management
    /review        Code review           [stub]
    /pr-comments   PR review comments    [stub]
    /workflows     Workflow management   [stub]

    ── Project ─────────────────────────
    /init          Initialize .mipham config
    /add-dir       Add directory         [stub]
    /permissions   Permission settings   [stub]
    /security      Security review       [stub]
    /audit         Same as /security     [stub]

    ── Account ─────────────────────────
    /login         Sign in               [stub]
    /logout        Sign out              [stub]
    /feedback      Send feedback         [stub]
    /release-notes Release notes         [stub]
    /upgrade       Upgrade Mipham Code   [stub]
    /ide           IDE integration       [stub]
    /terminal-setup Terminal setup       [stub]
    /agents        Agent management      [stub]
    /memory        Memory management     [stub]

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
    Skills:   10 built-in (8 standard + 2 mipham)
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
    ── Standard Skills (9) ──
    code-review                  Code review automation
    compassionate-communication  Warm, respectful, user-centered interaction
    doc-generator                Generate technical docs from code
    github-ops                   GitHub PR/issues/releases management
    memory                       Persistent memory read/write
    self-review                  Self-review diff for bugs and cleanup
    superpower                   Skill discovery and usage guide
    tdd                          Test-Driven Development workflow
    web-search                   Web search for current information

    ── Mipham Exclusive (2) ──
    om-security        Security analysis (injection, PII, adversarial)
    om-model-optimize  Model optimization (context, caching, tokens)

    11 skills loaded. Use Skill tool to invoke.
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
// Stub commands — recognized, WIP
// ═══════════════════════════════════════════════════════════════

function stubCmd(name: string, description: string): CommandHandler {
  return () => ({
    content: `[stub] /${name} — ${description}\nComing in a future release.`,
  })
}

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

// Model & Provider
registry.set('/model', modelCmd)
registry.set('/models', modelsCmd)
registry.set('/provider', providerCmd)
registry.set('/providers', providersCmd)
registry.set('/config', configCmd)

// Tools & Skills
registry.set('/tools', toolsCmd)
registry.set('/skills', skillsCmd)

// Workflow
registry.set('/plan', planCmd)
registry.set('/tdd', tddCmd)
registry.set('/todos', todosCmd)

// Project
registry.set('/init', initCmd)

// Stubs (recognized, WIP)
registry.set('/no-plan', stubCmd('no-plan', 'Exit plan mode'))
registry.set('/export', stubCmd('export', 'Export conversation to file'))
registry.set('/doctor', stubCmd('doctor', 'System diagnostics'))
registry.set('/resume', stubCmd('resume', 'Resume a previous session'))
registry.set('/theme', stubCmd('theme', 'Change display theme'))
registry.set('/mcp', stubCmd('mcp', 'MCP server management'))
registry.set('/review', stubCmd('review', 'Code review workflow'))
registry.set('/pr-comments', stubCmd('pr-comments', 'PR review comments'))
registry.set('/workflows', stubCmd('workflows', 'Workflow management'))
registry.set('/add-dir', stubCmd('add-dir', 'Add directory permissions'))
registry.set('/permissions', stubCmd('permissions', 'Permission settings'))
registry.set('/security', stubCmd('security', 'Security review (/audit)'))
registry.set('/audit', stubCmd('audit', 'Security review (/security)'))
registry.set('/login', stubCmd('login', 'Sign in to MiphamAI'))
registry.set('/logout', stubCmd('logout', 'Sign out'))
registry.set('/feedback', stubCmd('feedback', 'Send feedback'))
registry.set('/release-notes', stubCmd('release-notes', 'View release notes'))
registry.set('/upgrade', stubCmd('upgrade', 'Upgrade Mipham Code'))
registry.set('/ide', stubCmd('ide', 'IDE integration settings'))
registry.set('/terminal-setup', stubCmd('terminal-setup', 'Terminal integration'))
registry.set('/agents', stubCmd('agents', 'Agent management'))
registry.set('/memory', stubCmd('memory', 'Memory management'))

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

// Handle /switch specially — it takes args
const origSwitch = registry.get('/switch')
registry.delete('/switch')
export { switchCmd as handleSwitch }
