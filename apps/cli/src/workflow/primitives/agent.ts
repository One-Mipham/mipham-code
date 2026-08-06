import { SubAgent } from '../../agent/sub-agent'
import type { ProviderRegistry } from '../../providers/registry'
import type { ToolDefinition } from '../../shared/index.ts'
import type { PermissionSystem } from '../../core/permission'
import { validateJSONSchema, formatValidationErrors } from '../schema-validator'

export interface WorkflowAgentOpts {
  label?: string
  phase?: string
  schema?: object
  model?: string
  provider?: string
  effort?: 'low' | 'medium' | 'high' | 'max'
  /** Maximum retries on schema validation failure (default: 2). */
  maxRetries?: number
  /** Permission system for sub-agent tool execution (optional). */
  permissionSystem?: PermissionSystem
  /** Run the agent in an isolated git worktree (optional). */
  isolation?: 'worktree'
}

/**
 * Workflow agent() primitive — creates a SubAgent with optional
 * provider/model override, structured output schema validation,
 * and git worktree isolation.
 *
 * When `schema` is provided:
 *   1. The sub-agent is prompted to return valid JSON matching the schema.
 *   2. The result is JSON.parsed and validated against the schema.
 *   3. On validation failure, the sub-agent is retried with error feedback.
 *   4. Returns the validated object, or { raw, validationErrors } on final failure.
 *
 * When `isolation: 'worktree'` is set:
 *   1. A git worktree is created at .claude/worktrees/wf-<slug>
 *   2. The sub-agent runs with its cwd set to the worktree path
 *   3. Changes are auto-committed (best-effort)
 *   4. The worktree is cleaned up after execution
 */
export async function workflowAgent(
  prompt: string,
  registry: ProviderRegistry,
  toolRegistry: Map<string, ToolDefinition>,
  opts: WorkflowAgentOpts = {},
): Promise<unknown> {
  // If provider override, switch temporarily
  if (opts.provider) {
    registry.switchProvider(opts.provider, opts.model)
  } else if (opts.model) {
    registry.switchProvider(registry.getActive().config.id, opts.model)
  }

  const maxRetries = opts.maxRetries ?? 2

  // ── Worktree isolation setup ──
  let worktreePath: string | undefined
  let worktreeBranch: string | undefined

  if (opts.isolation === 'worktree') {
    const slug = `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    worktreeBranch = `worktree/${slug}`
    worktreePath = `.claude/worktrees/${slug}`

    const proc = Bun.spawn(['git', 'worktree', 'add', '-b', worktreeBranch, worktreePath, 'HEAD'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      throw new Error(`Worktree creation failed: ${stderr.slice(0, 500)}`)
    }
  }

  // Build the prompt — if schema is requested, instruct the model to return JSON
  let effectivePrompt = prompt
  if (opts.schema) {
    const schemaDesc = JSON.stringify(opts.schema, null, 2)
    effectivePrompt =
      `${prompt}\n\n` +
      `IMPORTANT: Your response MUST be valid JSON matching this schema:\n` +
      `\`\`\`json\n${schemaDesc}\n\`\`\`\n` +
      `Return ONLY the JSON object, no other text. Do not wrap in markdown code fences.`
  }

  const sub = new SubAgent(registry, toolRegistry, opts.permissionSystem)

  // ── Execute with optional schema validation + retry ──
  let result: unknown = ''
  let lastResult = ''
  let lastErrors: string[] = []

  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const retryPrompt =
        attempt === 0
          ? effectivePrompt
          : `${effectivePrompt}\n\n` +
            `[RETRY #${attempt}] Your previous response did NOT match the required schema.\n` +
            `Validation errors:\n${lastErrors.map((e) => `  • ${e}`).join('\n')}\n\n` +
            `Please fix the errors and return a valid JSON object matching the schema exactly.`

      const textResult = await sub.execute(retryPrompt, opts.label || 'workflow-agent', {
        type: 'general',
        modelOverride: opts.model,
        allowedTools: undefined, // use all tools by default
        worktreePath,
      })

      lastResult = textResult

      // No schema — return raw result
      if (!opts.schema) {
        result = textResult
        return result
      }

      // Try to parse and validate
      try {
        // Extract JSON from potential markdown fences
        let jsonStr = textResult.trim()
        const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
        if (fenceMatch) {
          jsonStr = fenceMatch[1]!.trim()
        }

        const parsed = JSON.parse(jsonStr)
        const errors = validateJSONSchema(parsed, opts.schema as Record<string, unknown>)

        if (errors.length === 0) {
          // Valid! Return the parsed object
          result = parsed
          return result
        }

        // Not valid — collect errors for retry
        lastErrors = [formatValidationErrors(errors)]
      } catch (err) {
        // JSON parse error
        lastErrors = [`JSON parse error: ${String(err)}. Ensure your response is valid JSON only.`]
      }
    }

    // All retries exhausted — return raw result with validation errors
    try {
      const parsed = JSON.parse(lastResult)
      result = { raw: lastResult, parsed, validationErrors: lastErrors }
    } catch {
      result = { raw: lastResult, validationErrors: lastErrors }
    }

    return result
  } finally {
    // ── Cleanup worktree ──
    if (worktreePath) {
      // Best-effort: auto-commit any changes
      try {
        const addProc = Bun.spawn(['git', '-C', worktreePath, 'add', '-A'], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
        await addProc.exited

        const statusProc = Bun.spawn(['git', '-C', worktreePath, 'status', '--porcelain'], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const status = await new Response(statusProc.stdout).text()
        if (status.trim()) {
          const commitMsg = opts.label ? `workflow: ${opts.label}` : 'workflow: agent changes'
          const commitProc = Bun.spawn(['git', '-C', worktreePath, 'commit', '-m', commitMsg], {
            stdout: 'pipe',
            stderr: 'pipe',
          })
          await commitProc.exited
        }
      } catch {
        /* best-effort */
      }

      // Remove worktree and branch
      try {
        const rmProc = Bun.spawn(['git', 'worktree', 'remove', '--force', worktreePath], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
        await rmProc.exited
        if (worktreeBranch) {
          const brProc = Bun.spawn(['git', 'branch', '-D', worktreeBranch], {
            stdout: 'pipe',
            stderr: 'pipe',
          })
          await brProc.exited
        }
      } catch {
        /* best-effort */
      }
    }
  }
}
