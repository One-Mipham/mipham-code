import { spawnSync } from 'node:child_process'
import type { HookConfig, HookContext, HookResult } from '../shared/index.ts'

/**
 * Execute a hook based on its type, returning a HookResult.
 *
 * Supported types:
 * - command: Execute a shell command. Exit code 0 = allow, 2 = block with stderr as reason.
 * - http: POST to a URL, response body becomes additionalContext.
 * - mcp_tool: Call an MCP tool (delegates to MCP client -- stub for now).
 * - code: No-op (handled inline by the handler function directly).
 */
export async function executeHook(cfg: HookConfig, ctx: HookContext): Promise<HookResult> {
  switch (cfg.type) {
    case 'command':
      return executeCommand(cfg, ctx)
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
 * Named here rather than in the caller's `catch`, which cannot see any of them:
 * it runs only when `spawnSync` itself throws.
 */
function spawnFailureCause(
  result: { status?: number | null; signal?: string | null; error?: unknown },
  timeoutSeconds: number,
): string | null {
  const err = result.error as { code?: string; message?: string } | undefined
  if (err) {
    if (err.code === 'ETIMEDOUT') return `timed out after ${timeoutSeconds}s`
    return err.message
      ? `${err.code ?? 'spawn failed'}: ${err.message}`
      : (err.code ?? 'spawn failed')
  }
  if (result.signal && (result.status === null || result.status === undefined)) {
    return `killed by ${result.signal}`
  }
  return null
}

async function executeCommand(cfg: HookConfig, ctx: HookContext): Promise<HookResult> {
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
        additionalContext: `Hook error (${cfg.command}): ${failure}`,
      }
    }

    // Other non-zero exit: don't block, log the error as context
    return {
      allowed: true,
      additionalContext: `Hook warning (${cfg.command}): ${stderr.trim()}`,
    }
  } catch (err) {
    // Only reached when `spawnSync` itself throws — masking-policy load, env
    // filter, or an option it rejects outright. Its comment used to name timeouts
    // and missing commands, neither of which can arrive here.
    const message = (err as { message?: string }).message || String(err)

    return {
      allowed: true,
      additionalContext: `Hook error (${cfg.command}): ${message}`,
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

async function executeMcpTool(_cfg: HookConfig, _ctx: HookContext): Promise<HookResult> {
  // Stub: MCP tool hook execution requires MCP client integration.
  // For now, return allow to not block execution.
  return { allowed: true }
}
