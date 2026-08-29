// apps/cli/src/agent/types.ts

import type { Message } from '../shared/index.ts'

export type SubAgentType = 'general' | 'explore' | 'plan' | 'code-review'

export interface AgentFrontmatter {
  name: string
  description: string
  tools?: string // comma-separated allowlist
  disallowedTools?: string
  model?: string // 'sonnet' | 'opus' | 'haiku' | 'inherit' | full model ID
  permissionMode?: 'default' | 'acceptEdits' | 'bypass' | 'plan' | 'bypassPermissions'
  maxTurns?: number
  skills?: string
  background?: boolean
  memory?: 'user' | 'project' | 'local' // agent memory scope
}

export interface AgentDefinition {
  name: string
  description: string
  systemPrompt: string // markdown body after frontmatter
  tools?: string
  disallowedTools?: string
  model: string
  permissionMode: string
  maxTurns?: number
  skills?: string[]
  /** Force background (true) or sync (false) execution. Unset inherits the tool default. */
  background?: boolean
  source: 'builtin' | 'project' | 'user'
  filePath?: string
  memory?: 'user' | 'project' | 'local' // agent memory scope
}

export interface SubAgentOptions {
  type?: SubAgentType
  agentDef?: AgentDefinition
  systemPrompt?: string
  allowedTools?: string[]
  modelOverride?: string
  /** Maximum tool-calling turns (default: 5) to prevent infinite loops. */
  maxTurns?: number
  /** When true, execute in background and return immediately with a task ID. */
  runInBackground?: boolean
  /** Optional callback for streaming progress chunks during background execution. */
  onProgress?: (chunk: string) => void
  /** Optional callback reporting cumulative token usage (input + output) from the API stream. */
  onTokenUsage?: (totalTokens: number) => void
  /** When set, tool executions use this path as cwd (git worktree isolation). */
  worktreePath?: string
  /** Seed the sub-agent with a parent conversation prefix (e.g., fork inheritance). */
  inheritContext?: { messages: Message[] }
  /** CRSI: when false, skip pattern analysis after agent execution. Default true. */
  autoPatternAnalysis?: boolean
}
