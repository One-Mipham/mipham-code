// ── Provider Types ──
export type ProtocolType = 'openai-compatible' | 'anthropic' | 'custom'

export interface ModelInfo {
  id: string
  name: string
  providerId: string
  contextWindow: number
  maxOutput: number
  vision: boolean
  status: 'active' | 'upcoming' | 'deprecated'
}

export interface ProviderConfig {
  id: string
  name: string
  protocol: ProtocolType
  baseUrl?: string
  apiKey: string
  models: ModelInfo[]
  status?: 'active' | 'upcoming'
}

// ── Message Types ──
export interface TextContent {
  type: 'text'
  text: string
}
export interface ImageContent {
  type: 'image_url'
  image_url: { url: string }
}
export interface ToolUseContent {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}
export interface ToolResultContent {
  type: 'tool_result'
  tool_use_id: string
  content: string
}
export type ContentBlock = TextContent | ImageContent | ToolUseContent | ToolResultContent

export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentBlock[]
}

// ── Tool Types ──
export type ToolPermission = 'auto' | 'ask' | 'bypass'
export type ToolCategory = 'file' | 'exec' | 'agent' | 'network' | 'system' | 'artifact'

export interface ToolContext {
  cwd: string
  sessionId: string
  provider: string
  model: string
  skillsLoader?: import('../skills/loader').SkillsLoader
  registry?: import('../providers/registry').ProviderRegistry
  toolRegistry?: Map<string, ToolDefinition>
  artifactServer?: import('../artifacts/server').ArtifactServer
  agentRegistry?: import('../agent/agent-registry').AgentRegistry
}

// ── Artifact Types ──
export interface ArtifactEntry {
  name: string
  path: string
  url: string
  size: number
  type: 'html' | 'svg'
  createdAt: string
  sessionId: string
  versions?: string[] // version tags e.g. ['v1', 'v2']
  versionCount?: number
}

export interface ArtifactManifest {
  version: 1
  artifacts: ArtifactEntry[]
  port?: number
}

export interface ToolResult {
  success: boolean
  content: string
  error?: string
}

export interface ToolDefinition {
  name: string
  description: string
  category: ToolCategory
  permission: ToolPermission
  parameters: Record<string, unknown>
  execute: (params: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
}

// ── Stream Types ──
export interface StreamChunk {
  type: 'text' | 'tool_use' | 'tool_result' | 'stop' | 'error'
  content?: string
  toolUse?: ToolUseContent
  tool_use_id?: string
  error?: string
}

// ── Config Types ──
export interface MiphamConfig {
  version: string
  defaultProvider: string
  defaultModel: string
  permission: ToolPermission
  providers: ProviderConfig[]
  skills?: { paths: string[]; mcpServers: McpServerConfig[] }
}

export interface McpServerConfig {
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
}

// ── Skill Types ──
export interface SkillDefinition {
  name: string
  description: string
  version: string
  type: 'standard' | 'mipham'
  tools?: ToolDefinition[]
  hooks?: HookDefinition[]
  prompts?: Record<string, string>
}

// ── Hook Types ──
export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Notification'
  | 'Stop'
  | 'UserPromptSubmit'
  | 'PreCompact'
  | 'PostCompact'
  | 'ConfigChange'

export type HookType = 'command' | 'http' | 'code' | 'mcp_tool'

export interface HookConfig {
  type: HookType
  command?: string
  args?: string[]
  url?: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  mcpServer?: string
  mcpTool?: string
  continueOnBlock?: boolean
}

export interface HookDefinition {
  event: HookEvent
  toolName?: string
  handler: (context: HookContext) => Promise<HookResult>
}

export interface HookContext {
  event: HookEvent
  toolName?: string
  toolInput?: Record<string, unknown>
  toolResult?: ToolResult
  sessionId: string
  userPrompt?: string
  configKey?: string
  configValue?: unknown
}

export interface HookResult {
  allowed: boolean
  reason?: string
  modifiedInput?: Record<string, unknown>
  decision?: 'allow' | 'block'
  permissionDecision?: 'allow' | 'deny' | 'ask' | 'defer'
  additionalContext?: string
  updatedOutput?: string
}

// ── Instruction Types ──
export interface InstructionFile {
  path: string
  level: 'group' | 'company' | 'project' | 'directory' | 'user'
  privacy: 'public' | 'project' | 'private'
  language: string
  content: string
  frontmatter: Record<string, unknown>
}

// ── Permission Types ──
export type PermissionLevel = 'auto' | 'ask' | 'bypass'

export interface PermissionRule {
  toolName: string
  level: PermissionLevel
  pattern?: string
}
