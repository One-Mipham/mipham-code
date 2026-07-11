import { createSandbox } from './sandbox'
import { createJournal, appendJournal } from './journal'
import { createBudget } from './budget'
import { workflowAgent } from './primitives/agent'
import { parallel } from './primitives/parallel'
import { pipeline } from './primitives/pipeline'
import { phase as phasePrimitive } from './primitives/phase'
import type { ProviderRegistry } from '../providers/registry'
import type { QueryEngine } from '../core/engine'

export interface WorkflowRunResult {
  runId: string
  result: unknown
  journalEntries: number
}

/**
 * Execute a workflow script string.
 *
 * The script is evaluated in a sandboxed context with the workflow
 * primitives (agent, parallel, pipeline, phase, args, budget) injected.
 */
export async function runWorkflow(
  script: string,
  engine: QueryEngine,
  args: unknown = {},
  budgetTotal: number | null = null,
): Promise<WorkflowRunResult> {
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  createJournal(runId, script)

  const registry: ProviderRegistry = engine.getRegistry()
  const toolRegistry = engine.getTools()

  const budget = createBudget(budgetTotal)

  // Wrap primitives with journal recording
  const agent = async (prompt: string, opts?: Record<string, unknown>) => {
    const result = await workflowAgent(
      prompt,
      registry,
      toolRegistry,
      opts as Record<string, unknown>,
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
    'phase',
    'log',
    'args',
    'budget',
    wrappedScript,
  )

  const result = await scriptFn(agent, parallel, pipeline, wrappedPhase, log, args, budget)

  return { runId, result, journalEntries: 0 }
}
