import { join } from 'node:path'
import { SubAgent } from '../../agent/sub-agent'
import type { ProviderRegistry } from '../../providers/registry'
import type { Llm } from '../../providers/llm'
import type { ToolDefinition } from '../../shared/index.ts'
import type { PermissionSystem } from '../../core/permission'
import { worktreeRoot } from '../../core/paths.ts'
import { internalGitEnv } from '../../shared/git-env'
import { validateJSONSchema, formatValidationErrors } from '../schema-validator'

/** Upper bound for `git worktree add` — a hung fetch must not hang the run. */
const WORKTREE_ADD_TIMEOUT_MS = 60_000

/**
 * Effective model for a workflow agent.
 *
 * Precedence: an explicit per-call `model` (the script named one) wins; else the
 * environment default `MIPHAM_WORKFLOW_AGENT_MODEL`; else none (the session model
 * routing the registry already holds). Read *here* on purpose — the env is scoped
 * to workflow agents only, so a SubAgent spawned by the engine or `/bg` is
 * unaffected. Read per call so a test can set it without re-importing.
 */
export function resolveWorkflowAgentModel(model?: string): string | undefined {
  if (model !== undefined) return model
  const raw = process.env.MIPHAM_WORKFLOW_AGENT_MODEL
  return raw && raw.trim() !== '' ? raw.trim() : undefined
}

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
 *   1. A git worktree is created at .mipham/worktrees/wf-<slug>
 *   2. The sub-agent runs with its cwd set to the worktree path
 *   3. Changes are auto-committed (best-effort)
 *   4. The worktree is cleaned up after execution
 */
export async function workflowAgent(
  prompt: string,
  registry: ProviderRegistry,
  toolRegistry: Map<string, ToolDefinition>,
  opts: WorkflowAgentOpts = {},
  llm?: Llm,
): Promise<unknown> {
  const maxRetries = opts.maxRetries ?? 2
  // The model actually applied this call — per-call `opts.model` else the
  // `MIPHAM_WORKFLOW_AGENT_MODEL` default. Used both for the temporary provider
  // switch below and for the sub-agent's own `modelOverride` (they must agree,
  // or the switch would route one model while the sub-agent asked for another).
  const effectiveModel = resolveWorkflowAgentModel(opts.model)

  // ── Worktree isolation setup ──
  let worktreePath: string | undefined
  let worktreeBranch: string | undefined

  if (opts.isolation === 'worktree') {
    const slug = `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    worktreeBranch = `worktree/${slug}`
    worktreePath = join(worktreeRoot(process.cwd()), slug)

    const proc = Bun.spawn(['git', 'worktree', 'add', '-b', worktreeBranch, worktreePath, 'HEAD'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: internalGitEnv(),
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const exitCode = await Promise.race([
      proc.exited,
      new Promise<number>((resolve) => {
        timer = setTimeout(() => resolve(-1), WORKTREE_ADD_TIMEOUT_MS)
      }),
    ])
    clearTimeout(timer)
    if (exitCode === -1) {
      proc.kill()
      throw new Error(`Worktree creation timed out after ${WORKTREE_ADD_TIMEOUT_MS / 1000}s`)
    }
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

  const sub = new SubAgent(registry, toolRegistry, opts.permissionSystem, undefined, undefined, llm)

  // ── Execute with optional schema validation + retry ──
  let result: unknown = ''
  let lastResult = ''
  let lastErrors: string[] = []

  /** Set only when we actually switched — and then it is the way back. */
  let restore: (() => void) | undefined

  try {
    // ── Provider override, scoped to this call ──
    // 「临时」必须是真的。registry 的 active 是**会话级**的：`SubAgent` 在
    // `runExecution` 里读 `registry.getActiveModel()`、`registry.chat` 按 active 路由，
    // 引擎的页脚与 `/model` 面板读的也是它 —— 覆盖不还原，等于一个 workflow 里的一次
    // `agent(…, { provider: 'x' })` 把整台机器的会话换到 x 上。
    //
    // 切在这里而不是函数开头：上面那段建 worktree 会抛（`git worktree add` 非 0 即
    // throw），抛在切走之前就不该已经切走。
    if (opts.provider || effectiveModel) {
      const prevProviderId = registry.getActive().config.id
      const prevModelId = registry.getActiveModel()
      // `opts.provider` 缺席时只换模型 —— provider 保持这一次调用开始时的那一个。
      registry.switchProvider(opts.provider ?? prevProviderId, effectiveModel)
      restore = () => registry.switchProvider(prevProviderId, prevModelId)
    }

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
        modelOverride: effectiveModel,
        effort: opts.effort,
        allowedTools: undefined, // use all tools by default
        worktreePath,
        // The prompt is computed by the script, not typed by the user — say so,
        // so text the script relayed from a file or another agent cannot pass
        // as the user's own opening instruction.
        promptOrigin: 'script',
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
    // 还原排在 finally 的**第一件**：下面的 worktree 清理要 spawn git、还可能抛，
    // 排在它之后就等于「清理顺利时才还原」—— 而那正是最不需要还原的场合。
    restore?.()

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

      // Remove worktree and branch.
      //
      // Every step here used to be fire-and-forget: a `worktree remove` that
      // failed left the registration behind, the `branch -D` then failed too
      // ("used by worktree at …"), and the run reported clean either way. So
      // check both exits and say what is left — an unchanged agent worktree
      // that nobody removes is state the next run has to trip over.
      const leftovers: string[] = []
      try {
        const rmProc = Bun.spawn(['git', 'worktree', 'remove', '--force', worktreePath], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
        let removed = (await rmProc.exited) === 0
        if (!removed) {
          // A worktree whose directory is already gone leaves only a stale
          // registration; prune clears it so the branch delete can proceed.
          const pruneProc = Bun.spawn(['git', 'worktree', 'prune'], {
            stdout: 'pipe',
            stderr: 'pipe',
          })
          await pruneProc.exited
          const retry = Bun.spawn(['git', 'worktree', 'remove', '--force', worktreePath], {
            stdout: 'pipe',
            stderr: 'pipe',
          })
          removed = (await retry.exited) === 0
        }
        if (!removed) leftovers.push(`worktree ${worktreePath}`)

        if (worktreeBranch) {
          const brProc = Bun.spawn(['git', 'branch', '-D', worktreeBranch], {
            stdout: 'pipe',
            stderr: 'pipe',
          })
          if ((await brProc.exited) !== 0) leftovers.push(`branch ${worktreeBranch}`)
        }
      } catch (err) {
        leftovers.push(`${worktreePath} (${err instanceof Error ? err.message : String(err)})`)
      }
      if (leftovers.length > 0) {
        process.stderr.write(
          `⚠️  workflow: could not clean up ${leftovers.join(' and ')} — ` +
            `the run finished, but this state needs manual removal.\n`,
        )
      }
    }
  }
}
