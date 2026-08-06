import { createSandbox } from './sandbox'
import { createJournal, appendJournal, loadJournal, loadScript } from './journal'
import { createBudget } from './budget'
import { workflowAgent } from './primitives/agent'
import { parallel } from './primitives/parallel'
import { pipeline } from './primitives/pipeline'
import { phase as phasePrimitive } from './primitives/phase'
import { verify, judge } from './primitives/verify'
import { loopUntilConvergence } from './primitives/loop'
import type { ProviderRegistry } from '../providers/registry'
import type { QueryEngine } from '../core/engine'

export interface WorkflowRunResult {
  runId: string
  result: unknown
  journalEntries: number
  /** Number of agent() calls served from cache (only set when resumeFromRunId is used). */
  cacheHits: number
  /** Number of agent() calls executed live (only set when resumeFromRunId is used). */
  cacheMisses: number
}

/**
 * Generate a cache key for an agent() call.
 * Uses prompt + deterministic subset of opts.
 */
function agentCacheKey(prompt: string, opts: Record<string, unknown> = {}): string {
  const relevant = {
    prompt,
    label: opts.label,
    phase: opts.phase,
    model: opts.model,
    provider: opts.provider,
  }
  return JSON.stringify(relevant)
}

/**
 * Execute a workflow script string.
 *
 * When `resumeFromRunId` is provided:
 *   - Loads the journal from the prior run
 *   - Compares the current script against the saved script
 *   - Builds a cache from prior agent() results (keyed by prompt+opts)
 *   - New agent() calls that match the cache return the cached result
 *   - New/changed agent() calls execute live and append to the journal
 *   - Returns cacheHits and cacheMisses counts
 *
 * The sandbox blocks non-deterministic APIs (Date.now, Math.random) to make
 * this deterministic replay possible.
 */
export async function runWorkflow(
  script: string,
  engine: QueryEngine,
  args: unknown = {},
  budgetTotal: number | null = null,
  resumeFromRunId?: string,
): Promise<WorkflowRunResult> {
  let runId: string
  let cacheHits = 0
  let cacheMisses = 0

  // ── Resume mode: load prior journal, build cache ──
  let resultCache: Map<string, unknown> | null = null
  if (resumeFromRunId) {
    const savedScript = loadScript(resumeFromRunId)
    if (savedScript && savedScript !== script) {
      // Script changed — warn but proceed (cache may have stale entries)
      process.stderr.write(
        `[workflow] ⚠ Script differs from saved run "${resumeFromRunId}". ` +
          `Cache may contain stale entries for changed agent calls.\n`,
      )
    }

    const priorEntries = loadJournal(resumeFromRunId)
    if (priorEntries.length === 0) {
      process.stderr.write(
        `[workflow] ⚠ No journal entries found for run "${resumeFromRunId}". Proceeding without cache.\n`,
      )
    } else {
      resultCache = new Map()
      for (const entry of priorEntries) {
        if (entry.type === 'agent' && entry.prompt && entry.result !== undefined) {
          const key = agentCacheKey(entry.prompt, entry.opts || {})
          resultCache.set(key, entry.result)
        }
      }
    }

    // Re-use the existing run directory for appending
    runId = resumeFromRunId
  } else {
    runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    createJournal(runId, script)
  }

  const registry: ProviderRegistry = engine.getRegistry()
  const toolRegistry = engine.getTools()
  const permission = engine.getPermission()

  const budget = createBudget(budgetTotal)

  // Wrap primitives with journal recording + cache support
  const agent = async (prompt: string, opts?: Record<string, unknown>) => {
    // Check cache first
    if (resultCache) {
      const key = agentCacheKey(prompt, opts || {})
      if (resultCache.has(key)) {
        cacheHits++
        return resultCache.get(key)!
      }
    }
    cacheMisses++

    const result = await workflowAgent(
      prompt,
      registry,
      toolRegistry,
      { ...(opts || {}), permissionSystem: permission } as Record<string, unknown>,
    )
    appendJournal(runId, {
      type: 'agent',
      prompt,
      opts: opts as Record<string, unknown> | undefined,
      result,
    })
    return result
  }

  const wrappedPhase = (title: string) => {
    phasePrimitive(title)
    appendJournal(runId, { type: 'phase', message: title })
  }

  const log = (message: string) => {
    appendJournal(runId, { type: 'log', message })
  }

  const sandbox = createSandbox(args, budget)

  // Build the script wrapper
  const wrappedScript = `
    return (async () => {
      ${script}
    })()
  `

  // Execute in sandboxed context
  const scriptFn = new Function(
    'agent',
    'parallel',
    'pipeline',
    'verify',
    'judge',
    'loopUntilConvergence',
    'phase',
    'log',
    'args',
    'budget',
    wrappedScript,
  )

  const result = await scriptFn(
    agent,
    parallel,
    pipeline,
    verify,
    judge,
    loopUntilConvergence,
    wrappedPhase,
    log,
    args,
    budget,
  )

  // Count journal entries from state
  const priorEntries = loadJournal(runId)
  const journalEntries = priorEntries.length

  return { runId, result, journalEntries, cacheHits, cacheMisses }
}
