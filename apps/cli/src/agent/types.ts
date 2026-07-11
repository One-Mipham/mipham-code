// apps/cli/src/agent/types.ts

export type SubAgentType = 'general' | 'explore' | 'plan' | 'code-review'

export interface AgentFrontmatter {
  name: string
  description: string
  tools?: string // comma-separated allowlist
  disallowedTools?: string
  model?: string // 'sonnet' | 'opus' | 'haiku' | 'inherit' | full model ID
  permissionMode?: 'default' | 'acceptEdits' | 'auto' | 'bypass' | 'plan'
  maxTurns?: number
  skills?: string
  background?: boolean
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
  background: boolean
  source: 'builtin' | 'project' | 'user'
  filePath?: string
}

export interface SubAgentOptions {
  type?: SubAgentType
  agentDef?: AgentDefinition
  systemPrompt?: string
  maxContextMessages?: number
  allowedTools?: string[]
  modelOverride?: string
}
