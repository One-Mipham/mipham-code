// ── CLI 内部类型（引用活服务，不可共享）──
// 纯数据类型（Message/StreamChunk/ToolResult/配置/常量等）见 @mipham/shared —— 唯一真源。
export * from '@mipham/shared/types'
import type { HookDefinition, ToolCategory, ToolPermission, ToolResult } from '@mipham/shared'

export interface ToolContext {
  cwd: string
  sessionId: string
  provider: string
  model: string
  skillsLoader?: import('../skills/seam').Skills
  registry?: import('../providers/registry').ProviderRegistry
  toolRegistry?: Map<string, ToolDefinition>
  artifactServer?: import('../artifacts/server').ArtifactServer
  agentRegistry?: import('../agent/agent-registry').AgentRegistry
  backgroundAgentRegistry?: import('../agent/background-registry').BackgroundAgentRegistry
  permissionSystem?: import('../core/permission').PermissionSystem
  ruleEngine?: import('../core/rule-engine').ExperienceRuleEngine
  llm?: import('../providers/llm').Llm
  /** Files read this session — used by Write tool to check read-before-write */
  readFiles?: Set<string>
}

export interface ToolDefinition {
  name: string
  description: string
  category: ToolCategory
  permission: ToolPermission
  parameters: Record<string, unknown>
  execute: (params: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
}

export interface SkillDefinition {
  name: string
  description: string
  version: string
  type: 'standard' | 'mipham'
  tools?: ToolDefinition[]
  hooks?: HookDefinition[]
  prompts?: Record<string, string>
  /** Frontmatter: 'fork' means execute in isolated subagent, undefined means inline */
  context?: string
  /** Model override for fork execution */
  model?: string
  /** Tool whitelist for fork mode */
  allowedTools?: string[]
  /** When true, the skill is NOT shown in system-reminder for AI auto-triggering */
  disableModelInvocation?: boolean
  /** When true, users can invoke this skill directly via /<name> */
  userInvocable?: boolean
  /** The markdown body content of the skill file (instructions for the AI to follow). */
  body?: string
}
