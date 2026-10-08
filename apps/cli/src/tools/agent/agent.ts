import type { ToolDefinition } from '../../shared/index.ts'
import { SubAgent } from '../../agent/sub-agent'
import type { SubAgentType } from '../../agent/types'
import { getBackgroundAgentRegistry } from '../../agent/background-registry'

const VALID_TYPES: SubAgentType[] = ['general', 'explore', 'plan', 'code-review']

/** Same domain as the session-level `/effort` command (`ui/commands.ts`). */
const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * Resolve whether a sub-agent should run in the background.
 *
 * Precedence: explicit `run_in_background` param > nested-call rule > agent
 * frontmatter `background` field > default (background, Claude Code 2.1.232 parity).
 *
 * `nested` is true when the caller is itself a sub-agent. `[background-task:<id>]`
 * is a *handle*, not an answer: the child's result goes to the background registry
 * and the hook/experience logs, and nothing ever hands it back to the agent that
 * asked. So one level down, the ordinary fan-out shape — "ask a child, then use its
 * answer" — cannot work at all: the caller sees a placeholder where its input
 * should be. A *default* of background turns that from an option into a hole, which
 * is why the default flips here. An explicit `run_in_background: true` is still
 * honoured, in both directions: that is a request, not a default chosen on the
 * caller's behalf.
 */
export function resolveRunInBackground(
  runInBackground: boolean | undefined,
  agentDef?: { background?: boolean },
  nested = false,
): boolean {
  if (runInBackground !== undefined) return runInBackground
  if (nested) return false
  return agentDef?.background ?? true
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
  // Dispatch is not a separately-gated act. The child is built with the caller's
  // own `permissionSystem` (below: `new SubAgent(..., ctx.permissionSystem, ...)`)
  // and re-runs the same gate on every tool call it makes (`sub-agent.ts`
  // `permission: subPermission`), so `'ask'` here was a **duplicate** gate — and
  // this CLI has no interactive approval prompt, which makes `ask` a hard refusal.
  // The observable result was that `default` (manual) mode could not dispatch a
  // single agent: the advertised fan-out had no landing point on the branch
  // production runs. `'self'` matches `Git` / `Task` / `SendMessage`: the spawn is
  // free, and the child still cannot do anything the caller could not.
  permission: 'self',
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
      effort: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'xhigh', 'max'],
        description:
          'Reasoning effort for this sub-agent, same levels as /effort. Higher levels get a longer ' +
          'streaming idle budget so a long thinking pass is not mistaken for a stalled connection. ' +
          'Omit to inherit the provider default.',
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

    // Reject rather than pass through: an unrecognized level silently lands on
    // the 1× timeout, i.e. it behaves exactly like omitting the parameter while
    // reading as though it took effect.
    const effort = params.effort as string | undefined
    if (effort !== undefined && !VALID_EFFORTS.includes(effort)) {
      return {
        success: false,
        content: '',
        error: `Invalid effort "${effort}". Valid levels: ${VALID_EFFORTS.join(', ')}`,
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
      ctx.isSubAgent === true,
    )

    try {
      const sub = new SubAgent(
        registry,
        toolRegistry,
        ctx.permissionSystem,
        undefined,
        ctx.ruleEngine,
        ctx.llm,
      )
      const result = await sub.execute(prompt, description, {
        type: agentType,
        agentDef,
        runInBackground,
        effort,
        // Hand the caller's services down: the sub-agent keeps running the same
        // skills/agents/artifacts, and only the fields it owns are overridden.
        toolContext: ctx,
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
