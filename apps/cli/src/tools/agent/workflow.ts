import type { ToolDefinition } from '../../shared/index.ts'
import { runWorkflow } from '../../workflow/runtime'
import type { QueryEngine } from '../../core/engine'

export const workflowTool: ToolDefinition = {
  name: 'Workflow',
  description:
    'Execute a workflow script that orchestrates multiple subagents deterministically. ' +
    'Workflows run in the background — this tool returns immediately with a task ID, ' +
    'and a <task-notification> arrives when the workflow completes. Use /workflows to watch live progress.\n\n' +
    'A workflow structures work across many agents — to be comprehensive (decompose and cover in parallel), ' +
    'to be confident (independent perspectives and adversarial checks before committing), ' +
    'or to take on scale one context cannot hold (migrations, audits, broad sweeps). ' +
    'The script is where you encode that structure: what fans out, what verifies, what synthesizes.\n\n' +
    'ONLY call this tool when the task benefits from multi-agent orchestration. ' +
    'For a simple single-agent lookup or edit, use the Agent tool or direct tools instead.\n\n' +
    '## Primitives\n\n' +
    '- agent(prompt: string, opts?: {label?, phase?, schema?, model?, effort?, isolation?}): Promise<any> — spawn a subagent. ' +
    'Without schema, returns final text as string. With schema (JSON Schema), returns validated object — retries on mismatch.\n' +
    '- parallel(thunks: Array<() => Promise<any>>): Promise<any[]> — BARRIER: runs all thunks concurrently, waits for all. ' +
    'Failed thunks resolve to null. Use filter(Boolean) before consuming results.\n' +
    '- pipeline(items: T[], ...stages): Promise<any[]> — NO barrier: each item flows through all stages independently. ' +
    'Item A can be in stage 3 while item B is still in stage 1. DEFAULT choice for multi-stage work.\n' +
    '- verify(finding, opts): Promise<VerifyResult> — adversarial/perspective/consensus quality gate. ' +
    'Spawns skeptics or lens-based judges, applies threshold, returns {survives, votes, score}.\n' +
    '- judge(attempts, opts): Promise<JudgeResult> — judge panel: N attempts scored by M judges across K criteria. ' +
    'Returns winner with optional synthesis grafting runner-up ideas.\n' +
    '- loopUntilConvergence(opts): Promise<LoopUntilConvergenceResult> — convergent discovery loop. ' +
    'Fans out finders repeatedly, deduplicates against seen-set (NOT confirmed-set), ' +
    'stops after N consecutive dry rounds or maxRounds. Optionally verifies each finding.\n' +
    '- phase(title: string): void — start a new progress group\n' +
    '- log(message: string): void — emit progress message\n' +
    '- args: any — verbatim args passed to Workflow tool\n' +
    '- budget: {total, spent(), remaining()} — token budget tracking\n\n' +
    '## Topology Selection Guide\n\n' +
    'DEFAULT TO pipeline(). Only reach for a barrier (parallel between stages) when you genuinely ' +
    'need ALL prior-stage results together.\n\n' +
    'A barrier is correct ONLY when stage N needs cross-item context from all of stage N-1: ' +
    'dedup/merge across the full result set, early-exit if total count is zero, cross-finding comparison.\n\n' +
    'A barrier is NOT justified by: flatten/map/filter (do it inside a pipeline stage), ' +
    'conceptually separate stages, cleaner code — barrier latency is real and measurable.\n\n' +
    '- Diamond (fan-out → reduce → synthesize): market scans, audits, research\n' +
    '- Pipeline (no barrier): each item flows independently — DEFAULT\n' +
    '- Loop-until-convergence: unknown-size discovery (bugs, vulnerabilities, edge cases)\n' +
    '- Judge panel: multiple competing approaches, pick best + graft runner-ups\n' +
    '- Verifier-on-edge: quality gates before results reach downstream\n\n' +
    '## Critical Rules\n\n' +
    '- EDGE LOGIC IS FREE: flatten, dedupe, filter in plain JavaScript — NOT agent calls. ' +
    'results.flatMap(...) and a Set are deterministic, instant, zero tokens.\n' +
    '- seen-set dedup for loops, NOT confirmed-set — rejected findings would otherwise revive every round.\n' +
    '- Each node should have bounded input, validated output (schema), and one clear purpose.\n' +
    '- Model tiering: use cheaper models for repetitive extraction/classification nodes, ' +
    'expensive models for synthesis/judgment nodes.\n\n' +
    '## Script Format\n\n' +
    'Every script MUST begin with: export const meta = { name, description, phases: [{title, detail}] }\n' +
    'The meta object must be a PURE LITERAL — no variables, function calls, or template interpolation.\n' +
    'Use the SAME phase titles in meta.phases as in phase() calls.',
  category: 'agent',
  permission: 'ask',
  parameters: {
    type: 'object',
    properties: {
      script: {
        type: 'string',
        description:
          'JavaScript workflow script using agent/parallel/pipeline/phase/log/args/budget primitives',
      },
      args: {
        type: 'object',
        description: 'Arguments to pass to the workflow script as the `args` global',
      },
      resumeFromRunId: {
        type: 'string',
        description:
          'Run ID of a prior Workflow invocation to resume from. ' +
          'Completed agent() calls with unchanged (prompt, opts) return cached results; ' +
          'only edited or new calls re-run.',
      },
    },
    required: ['script'],
  },
  async execute(params, ctx) {
    const script = params.script as string
    const args = (params.args as Record<string, unknown>) || {}
    const resumeFromRunId = params.resumeFromRunId as string | undefined

    if (!ctx.registry || !ctx.toolRegistry) {
      return {
        success: false,
        content: '',
        error: 'Workflow execution requires an active provider and tool registry.',
      }
    }

    // Build a minimal engine-like interface for runWorkflow
    const engineStub = {
      getRegistry: () => ctx.registry!,
      getTools: () => ctx.toolRegistry!,
    } as QueryEngine

    try {
      const { runId, result, cacheHits, cacheMisses } = await runWorkflow(
        script,
        engineStub,
        args,
        null,
        resumeFromRunId,
      )

      // Persist last-run state for /workflow save
      try {
        const { existsSync, mkdirSync, writeFileSync } = await import('node:fs')
        const { join } = await import('node:path')
        const workflowsDir = join(process.cwd(), '.claude', 'workflows')
        if (!existsSync(workflowsDir)) {
          mkdirSync(workflowsDir, { recursive: true })
        }
        writeFileSync(
          join(workflowsDir, '.last-run.json'),
          JSON.stringify({ runId, script, timestamp: new Date().toISOString() }),
          'utf-8',
        )
      } catch {
        // best-effort — don't fail the workflow if state persistence fails
      }

      let content = `Workflow ${runId} completed.\n\n`
      if (resumeFromRunId) {
        content += `Cache: ${cacheHits} hits · ${cacheMisses} live\n\n`
      }
      content += `Result:\n${typeof result === 'string' ? result : JSON.stringify(result, null, 2)}`

      return { success: true, content }
    } catch (err) {
      return {
        success: false,
        content: '',
        error: `Workflow execution failed: ${String(err)}`,
      }
    }
  },
}
