import { spawnSync } from 'node:child_process'
import { McpClient } from '../mcp/client'
import type { ToolCallResult } from '../mcp/types'
import type { HookConfig, HookContext, HookResult } from '../shared/index.ts'

/**
 * Execute a hook based on its type, returning a HookResult.
 *
 * Supported types:
 * - command: Execute a shell command. Exit code 0 = allow, 2 = block with stderr as reason.
 * - http: POST to a URL, response body becomes additionalContext.
 * - mcp_tool: Call the MCP tool the hook names; its answer is read as the hook's.
 * - code: No-op (handled inline by the handler function directly).
 */
export async function executeHook(
  cfg: HookConfig,
  ctx: HookContext,
  source?: string,
): Promise<HookResult> {
  switch (cfg.type) {
    case 'command':
      return executeCommand(cfg, ctx, source)
    case 'http':
      return executeHttp(cfg, ctx)
    case 'mcp_tool':
      return executeMcpTool(cfg, ctx)
    default:
      return { allowed: true }
  }
}

function substituteVars(template: string, ctx: HookContext): string {
  return template
    .replace(/\$TOOL_NAME/g, ctx.toolName || '')
    .replace(/\$INPUT/g, ctx.toolInput ? JSON.stringify(ctx.toolInput) : '')
    .replace(/\$SESSION_ID/g, ctx.sessionId)
}

/**
 * Build the Claude Code protocol stdin JSON for a hook script. Mirrors the
 * fields Claude Code passes (session_id / hook_event_name / cwd / tool_name /
 * tool_input / tool_response) so hand-written Claude hooks can migrate
 * unchanged.
 */
export function buildHookStdin(ctx: HookContext, cwd: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    session_id: ctx.sessionId,
    hook_event_name: ctx.event,
    cwd,
  }
  if (ctx.toolName) payload.tool_name = ctx.toolName
  if (ctx.toolInput) payload.tool_input = ctx.toolInput
  if (ctx.toolResult) payload.tool_response = ctx.toolResult
  return payload
}

/**
 * Parse a hook script's stdout JSON into a HookResult, following the Claude
 * Code output contract. Supports the modern `hookSpecificOutput` carrier
 * (permissionDecision / updatedInput / additionalContext) plus the legacy
 * root-level `decision` and `continue` fields. Non-JSON or empty stdout = allow.
 */
export function parseHookStdout(stdout: string | null | undefined, _ctx: HookContext): HookResult {
  if (!stdout) return { allowed: true }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>
  } catch {
    return { allowed: true }
  }

  const hso = parsed.hookSpecificOutput as Record<string, unknown> | undefined
  if (hso) {
    const decision = hso.permissionDecision as string | undefined
    const reason = hso.permissionDecisionReason as string | undefined
    const additionalContext = hso.additionalContext as string | undefined
    const updatedInput = hso.updatedInput as Record<string, unknown> | undefined

    if (decision === 'deny') {
      return { allowed: false, reason: reason ?? 'Denied by hook', additionalContext }
    }
    if (decision === 'allow') {
      return {
        allowed: true,
        permissionDecision: 'allow',
        modifiedInput: updatedInput,
        additionalContext,
      }
    }
    if (decision === 'ask') {
      return { allowed: true, permissionDecision: 'ask', additionalContext }
    }
    if (decision === 'defer') {
      return { allowed: true, permissionDecision: 'defer', additionalContext }
    }
    if (additionalContext) {
      return { allowed: true, additionalContext }
    }
  }

  // Legacy root-level decision: block / approve
  if (parsed.decision === 'block') {
    return { allowed: false, reason: (parsed.reason as string) ?? 'Blocked by hook' }
  }

  // Stop-style events: continue:false
  if (parsed.continue === false) {
    return { allowed: false, reason: (parsed.stopReason as string) ?? 'Stopped by hook' }
  }

  return { allowed: true }
}

/**
 * Why the hook subprocess failed to run to completion, or `null` if it did exit.
 *
 * `spawnSync` does **not** throw for a failed spawn or a timeout — it reports them
 * on the result, and all three shapes arrive with **empty stderr**: `error.code`
 * is `ETIMEDOUT` for the timeout, `ENOENT` when the command does not exist, and an
 * externally killed child comes back as `status: null` + `signal` with no `error`
 * at all. Empty stderr is what made them one string with a benign non-zero exit
 * that printed nothing — `Hook warning (<cmd>): ` with the reason left blank.
 *
 * A fourth shape is **not** a failure of the run at all: `EPIPE` on the write that
 * hands the child its stdin payload, which is what happens whenever the child
 * exits without reading it (measured: `status` survives — `exit 0` → 0, `exit 3`
 * → 3 — and `signal` stays null). Hook commands routinely ignore stdin, and whether
 * that write loses its race is a property of the scheduler, not of the hook: it
 * never occurred on the dev machine and reddened CI on a faster one. Read as the
 * cause, it **replaced** the child's real result — `Hook warning (<cmd>): boom`
 * and `killed by SIGTERM` both came back as `Hook error (<cmd>): EPIPE`. So EPIPE
 * is exempt from the two decisions below, and speaks only when nothing else can.
 *
 * Named here rather than in the caller's `catch`, which cannot see any of them:
 * it runs only when `spawnSync` itself throws.
 */
function spawnFailureCause(
  result: { status?: number | null; signal?: string | null; error?: unknown },
  timeoutSeconds: number,
): string | null {
  const err = result.error as { code?: string; message?: string } | undefined
  const hasExit = typeof result.status === 'number'
  const writeFailed = err?.code === 'EPIPE'

  if (err && !writeFailed) {
    if (err.code === 'ETIMEDOUT') return `timed out after ${timeoutSeconds}s`
    return err.message
      ? `${err.code ?? 'spawn failed'}: ${err.message}`
      : (err.code ?? 'spawn failed')
  }

  if (result.signal && !hasExit) {
    return `killed by ${result.signal}`
  }

  // No branch for "EPIPE and nothing else": a failed write presupposes a child that
  // was spawned and reaped, so `status` or `signal` is always present alongside it
  // (`exit 0`/`exit 3` → 0/3, `kill -TERM $$` → SIGTERM). Unreachable error
  // handling is what the exemption above is meant to avoid, not to add.
  return null
}

/**
 * The handle a failure message points the operator at: the command, and — when the
 * hook came from a plugin rather than from the operator's own settings — who
 * declared it.
 *
 * The command alone does not answer "which plugin do I look at". A plugin hook is
 * typically `sh`, `node`, or a path under the plugin's root; none of those is a
 * name the operator can search for. Two arguments rather than a pre-joined string
 * because the parentheses and the `from` clause have to stay one decision: a
 * caller that built half the label would be free to print `from "undefined"`.
 */
function failingLabel(command: string | undefined, source?: string): string {
  return `(${command})${source ? ` from "${source}"` : ''}`
}

async function executeCommand(
  cfg: HookConfig,
  ctx: HookContext,
  source?: string,
): Promise<HookResult> {
  if (!cfg.command) return { allowed: true }

  try {
    const args = cfg.args ? cfg.args.map((a) => substituteVars(a, ctx)) : []

    // A hook command is a child of this process, so a bare `spawnSync` would hand
    // it the whole environment — every provider key and bot secret included. Bash
    // has been masking these since E1; hooks were the remaining door, so they use
    // the same policy. Resolved at **user level** — the same choice E1 made for
    // every spawn it could not scope to one session's project section
    // (`tools/index.ts:45-48`). Scoping it to `ctx.cwd` now that this file has one
    // would be a masking-policy change, not a plumbing fix, so it is not made here.
    const { loadUserCredentialMaskingConfig } = await import('../config/loader')
    const { filterEnv } = await import('./credential-masker')
    const masking = loadUserCredentialMaskingConfig()
    const env =
      masking.enabled && masking.env_filter.enabled
        ? filterEnv(process.env as Record<string, string | undefined>, masking)
        : undefined

    // Which workspace the hook is *for* is the session's business, not this
    // process's — the daemon runs many sessions and its own cwd belongs to none of
    // them. `HookEngine` stamps `ctx.cwd`; the fallback covers a context built by
    // hand, and is exactly right for the one-shot CLI.
    const cwd = ctx.cwd ?? process.cwd()

    // Use spawnSync with array args — no shell, no command injection.
    // Pass the Claude-protocol stdin JSON so scripts can read structured context.
    const input = JSON.stringify(buildHookStdin(ctx, cwd))
    const result = spawnSync(cfg.command, args, {
      timeout: (cfg.timeout ?? 60) * 1000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      input,
      // Both halves of "where is this hook": the directory it runs in, and the
      // `cwd` it reads off stdin. Fixing only one leaves the hook told it is
      // somewhere it is not.
      cwd,
      // `undefined` = inherit, which is what node does by default; passing it
      // explicitly keeps the two branches visible at one site.
      env,
    })

    // Exit code 0 = success — parse the stdout JSON for structured decisions.
    if (result.status === 0) {
      return parseHookStdout(result.stdout, ctx)
    }

    // Non-zero exit: check for block signal (exit code 2)
    // 截断 stderr 防 MB 级 hook 输出溢出会话（对齐 HTTP hook 的 slice(0,2000)）。
    const stderr = (result.stderr?.toString() || '').slice(0, 2000)

    if (result.status === 2) {
      return {
        allowed: false,
        reason: stderr.trim() || 'Blocked by hook',
        additionalContext: cfg.continueOnBlock ? stderr.trim() : undefined,
      }
    }

    const failure = spawnFailureCause(result, cfg.timeout ?? 60)
    if (failure) {
      return {
        allowed: true,
        additionalContext: `Hook error ${failingLabel(cfg.command, source)}: ${failure}`,
      }
    }

    // Other non-zero exit: don't block, log the error as context
    return {
      allowed: true,
      additionalContext: `Hook warning ${failingLabel(cfg.command, source)}: ${stderr.trim()}`,
    }
  } catch (err) {
    // Only reached when `spawnSync` itself throws — masking-policy load, env
    // filter, or an option it rejects outright. Its comment used to name timeouts
    // and missing commands, neither of which can arrive here.
    const message = (err as { message?: string }).message || String(err)

    return {
      allowed: true,
      additionalContext: `Hook error ${failingLabel(cfg.command, source)}: ${message}`,
    }
  }
}

async function executeHttp(cfg: HookConfig, ctx: HookContext): Promise<HookResult> {
  if (!cfg.url) return { allowed: true }

  try {
    const response = await fetch(cfg.url, {
      method: cfg.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.headers || {}),
      },
      body: JSON.stringify({
        event: ctx.event,
        toolName: ctx.toolName,
        sessionId: ctx.sessionId,
      }),
      signal: AbortSignal.timeout(10_000),
    })

    const body = await response.text()

    if (!response.ok) {
      return {
        allowed: false,
        reason: `HTTP hook returned ${response.status}: ${body.slice(0, 200)}`,
      }
    }

    return {
      allowed: true,
      additionalContext: body.slice(0, 2000) || undefined,
    }
  } catch (err) {
    // HTTP hook failures should not block
    return {
      allowed: true,
      additionalContext: `HTTP hook error (${cfg.url}): ${String(err)}`,
    }
  }
}

/**
 * An `mcp_tool` hook: call the tool the hook names, and read its answer as the
 * hook's own.
 *
 * The answer is read by the same contract a command hook's stdout follows — a
 * structured decision decides, plain prose is context — so a tool that guards a
 * tool call can block it the way a script would. An `isError` result is *not* a
 * decision: it means the call did not speak, and an unreachable server reports
 * the same way, so its message is reported rather than read as a verdict.
 */
async function executeMcpTool(cfg: HookConfig, ctx: HookContext): Promise<HookResult> {
  if (!cfg.mcpServer || !cfg.mcpTool) return { allowed: true }

  const client = McpClient.getInstance()

  // Startup connects servers without blocking; this hook can arrive first.
  if (!(await client.waitUntilReady(cfg.mcpServer))) {
    return {
      allowed: true,
      additionalContext: `MCP hook (${cfg.mcpServer}/${cfg.mcpTool}): server "${cfg.mcpServer}" was still connecting — the tool was not called.`,
    }
  }

  const result = await client.callTool(cfg.mcpServer, cfg.mcpTool, {
    event: ctx.event,
    toolName: ctx.toolName,
    toolInput: ctx.toolInput,
    sessionId: ctx.sessionId,
  })
  const body = mcpResultText(result)

  if (result.isError) {
    return {
      allowed: true,
      additionalContext: `MCP hook error (${cfg.mcpServer}/${cfg.mcpTool}): ${body.slice(0, 2000)}`,
    }
  }

  const parsed = parseHookStdout(body, ctx)
  const decided =
    !parsed.allowed ||
    parsed.additionalContext !== undefined ||
    parsed.permissionDecision !== undefined ||
    parsed.modifiedInput !== undefined

  // Nothing in the hook contract matched, so the tool answered in prose: that
  // answer is the context this hook contributes, not a silent no-op.
  return decided ? parsed : { allowed: true, additionalContext: body.slice(0, 2000) || undefined }
}

/** The text an MCP tool call returned; non-text parts carry no message for a hook. */
function mcpResultText(result: ToolCallResult): string {
  return result.content
    .map((part) => part.text ?? '')
    .filter(Boolean)
    .join('\n')
}
