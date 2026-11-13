import type { InferenceHookConfig } from '../shared/index.ts'
import type { ToolGateDeps } from '../core/tool-gate'

/**
 * Services the engine hands to every sub-agent it can reach.
 *
 * The five production construction sites (`tools/agent/agent.ts`,
 * `skills/fork-executor.ts`, `workflow/primitives/agent.ts`, and the two in
 * `ui/commands.ts`) each used to decide for themselves what a sub-agent got.
 * They all decided to pass `undefined`: the hook engine never reached a
 * sub-agent, and the constitution / SIS / CRSI chain was never called there at
 * all. Carrying the bundle on `ToolContext` and on the workflow runtime's
 * engine stub makes the engine the single producer instead of leaving five
 * copies of the same decision to drift.
 */
export interface SubAgentServices {
  /** Pre-execution gates — same chain the engine's own tool loop runs. */
  gate: ToolGateDeps
  /** PreInference DLP config. Absent means the organization did not enable it. */
  inferenceHook?: InferenceHookConfig
}
