import type { ToolDefinition } from '../../shared/index.ts'
import { runWorkflow } from '../../workflow/runtime'
import type { QueryEngine } from '../../core/engine'

export const workflowTool: ToolDefinition = {
  name: 'Workflow',
  description:
    'Execute a multi-agent workflow script. The script uses agent(), parallel(), pipeline(), phase(), log(), args, budget primitives. Use for complex orchestrated tasks.',
  category: 'agent',
  permission: 'ask',
  parameters: {
    type: 'object',
    properties: {
      script: {
        type: 'string',
        description: 'JavaScript workflow script using agent/parallel/pipeline/phase/log/args/budget primitives',
      },
      args: {
        type: 'object',
        description: 'Arguments to pass to the workflow script as the `args` global',
      },
    },
    required: ['script'],
  },
  async execute(params, ctx) {
    const script = params.script as string
    const args = (params.args as Record<string, unknown>) || {}

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
      const { runId, result } = await runWorkflow(script, engineStub, args)
      return {
        success: true,
        content: `Workflow ${runId} completed.\n\nResult:\n${typeof result === 'string' ? result : JSON.stringify(result, null, 2)}`,
      }
    } catch (err) {
      return {
        success: false,
        content: '',
        error: `Workflow execution failed: ${String(err)}`,
      }
    }
  },
}
