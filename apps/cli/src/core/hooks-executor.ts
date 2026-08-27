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

function executeCommand(cfg: HookConfig, ctx: HookContext): HookResult {
  if (!cfg.command) return { allowed: true }

  try {
    const args = cfg.args ? cfg.args.map((a) => substituteVars(a, ctx)) : []

    // Use spawnSync with array args — no shell, no command injection
    const result = spawnSync(cfg.command, args, {
      timeout: 30_000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    // Exit code 0 = success, allow
    if (result.status === 0) {
      return { allowed: true }
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

    // Other non-zero exit: don't block, log the error as context
    return {
      allowed: true,
      additionalContext: `Hook warning (${cfg.command}): ${stderr.trim()}`,
    }
  } catch (err) {
    // spawnSync errors (e.g., command not found, timeout, signal)
    const message = (err as { message?: string }).message || String(err)

    // Timeout/signal: treat as non-blocking warning
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
