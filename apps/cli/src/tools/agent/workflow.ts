import type { ToolDefinition } from '../../shared/index.ts'
import { runWorkflow } from '../../workflow/runtime'
import type { QueryEngine } from '../../core/engine'

export const workflowTool: ToolDefinition = {
  name: 'Workflow',
  description:
    'Execute a multi-agent workflow script. The script uses agent(), parallel(), pipeline(), phase(), log(), args, budget primitives. ' +
    'Pass resumeFromRunId to resume a prior run — cached agent() calls are replayed from the journal, ' +
    'and only new/changed calls execute live.',
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
