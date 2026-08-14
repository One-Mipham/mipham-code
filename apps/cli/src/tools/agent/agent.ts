import type { ToolDefinition } from '../../shared/index.ts'
import { SubAgent } from '../../agent/sub-agent'
import type { SubAgentType } from '../../agent/types'
import { getBackgroundAgentRegistry } from '../../agent/background-registry'

const VALID_TYPES: SubAgentType[] = ['general', 'explore', 'plan', 'code-review']

/**
 * Resolve whether a sub-agent should run in the background.
 * Precedence: explicit `run_in_background` param > agent frontmatter
 * `background` field > default (background, Claude Code 2.1.232 parity).
 */
export function resolveRunInBackground(
  runInBackground: boolean | undefined,
  agentDef?: { background?: boolean },
): boolean {
  return runInBackground ?? agentDef?.background ?? true
}

export const agentTool: ToolDefinition = {
  name: 'Agent',
  description:
    'Launch a sub-agent to handle complex, multi-step tasks independently. ' +
    'Available types: general (default), explore (code search), plan (design), code-review. ' +
    'Runs in the background by default — returns a task ID immediately; results are ' +
    'retrievable via the Task tool (output action) or Agent View. ' +
    'Set run_in_background: false to run synchronously.',
  category: 'agent',
  permission: 'ask',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short description of the task' },
      prompt: { type: 'string', description: 'The task for the agent to perform' },
      subagent_type: {
        type: 'string',
        description: 'Type: general (default), explore (code search), plan (design), code-review',
      },
      run_in_background: {
        type: 'boolean',
        description:
          'When false, execute synchronously and return the result directly. Default: true (background).',
      },
    },
    required: ['description', 'prompt'],
  },
  async execute(params, ctx) {
    const description = params.description as string
    const prompt = params.prompt as string
    const agentType = (params.subagent_type as SubAgentType) || 'general'

    if (!VALID_TYPES.includes(agentType)) {
      return {
        success: false,
        content: '',
        error: `Invalid subagent_type "${agentType}". Valid types: ${VALID_TYPES.join(', ')}`,
      }
    }

    const registry = ctx.registry
    const toolRegistry = ctx.toolRegistry
    if (!registry || !toolRegistry) {
      return {
        success: false,
        content: '',
        error:
          'Sub-agent execution requires an active provider and tool registry. Connect a provider API key first.',
      }
    }

    // Resolve agent definition from registry (custom > builtin)
    const agentDef = ctx.agentRegistry?.resolve(agentType)
    const runInBackground = resolveRunInBackground(
      params.run_in_background as boolean | undefined,
      agentDef,
    )

    try {
      const sub = new SubAgent(
        registry,
        toolRegistry,
        ctx.permissionSystem,
        undefined,
        ctx.ruleEngine,
      )
      const result = await sub.execute(prompt, description, {
        type: agentType,
        agentDef,
        runInBackground,
      })

      // If background execution, also register in the task system for Task tool integration
      if (runInBackground) {
        const bgMatch = result.match(/\[background-task:(.+?)\]/)
        if (bgMatch) {
          const bgTaskId = bgMatch[1]!
          const bgRegistry = getBackgroundAgentRegistry()
          const bgTask = bgRegistry.get(bgTaskId)

          return {
            success: true,
            content:
              `── Background Agent Started ──\n\n` +
              `Task ID:   ${bgTaskId}\n` +
              `Type:      ${agentType}\n` +
              `Task:      ${description}\n` +
              `Status:    ${bgTask?.status || 'running'}\n\n` +
              `The agent is running in the background. You can continue working.\n` +
              `Use Task output taskId="${bgTaskId}" to check results.\n` +
              `Use Task stop taskId="${bgTaskId}" to cancel.\n` +
              `Use /agents to view in Agent View dashboard.`,
          }
        }
      }

      return { success: true, content: result }
    } catch (err) {
      return { success: false, content: '', error: String(err) }
    }
  },
}
