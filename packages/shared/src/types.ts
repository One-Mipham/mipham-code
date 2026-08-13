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
export interface ThinkingContent {
  type: 'thinking'
  thinking: string
}
export type ContentBlock =
  TextContent | ImageContent | ToolUseContent | ToolResultContent | ThinkingContent

export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentBlock[]
  /** DeepSeek reasoning tokens — must be passed back to the API in multi-turn conversations. */
  reasoning_content?: string
}

// ── Tool Types ──
export type ToolPermission = 'auto' | 'ask' | 'bypass'
export type ToolCategory = 'file' | 'exec' | 'agent' | 'network' | 'system'

export interface ToolContext {
  cwd: string
  sessionId: string
  provider: string
  model: string
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
  type:
    | 'text'
    | 'tool_use'
    | 'tool_result'
    | 'thinking'
    | 'stop'
    | 'error'
    | 'warning'
    | 'task_notification'
    | 'usage'
  content?: string
  toolUse?: ToolUseContent
  tool_use_id?: string
  error?: string
  /** DeepSeek reasoning tokens accumulated during this stream. */
  reasoning_content?: string
  /** Anthropic thinking block content (DeepSeek Anthropic endpoint). */
  thinking?: string
  /** Background task notification payload (type: 'task_notification'). */
  taskNotification?: {
    taskId: string
    status: 'started' | 'completed' | 'failed'
    description: string
    content?: string
    error?: string
  }
  /** API-reported input token count (type: 'usage'). */
  inputTokens?: number
  /** API-reported output token count (type: 'usage'). */
  outputTokens?: number
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
  | 'PostToolUseFailure'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Notification'
  | 'Stop'
  | 'UserPromptSubmit'
  | 'PreCompact'
  | 'PostCompact'
  | 'ConfigChange'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreInference'

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
  /** PreInference: full conversation messages for DLP inspection. */
  messages?: Array<{ role: string; content: string }>
  /** PreInference: recent tool calls and their results. */
  toolCalls?: Array<{
    name: string
    input: Record<string, unknown>
    resultPreview: string
  }>
  /** PreInference: current provider ID. */
  provider?: string
  /** PreInference: current model ID. */
  model?: string
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

// ── Inference Hook (DLP) Types ──

export interface InferenceHookConfig {
  endpoint: string
  signing_secret: string
  timeout: number
  on_failure: 'fail-closed' | 'fail-open'
  organization_id: string
  headers: Record<string, string>
}

export interface InferenceCheckRequest {
  type: 'inference_check'
  id: string
  created_at: string
  data: {
    type: 'pre_inference'
    session_id: string
    organization_id?: string
    provider: string
    model: string
    messages: Array<{ role: string; content: string }>
    tool_calls: Array<{
      name: string
      input: Record<string, unknown>
      result_preview: string
    }>
  }
}

export interface InferenceCheckResponse {
  verdict: 'allow' | 'deny'
  reason?: string
}

// ── Credential Masking Types ──

export interface CredentialFullMaskRule {
  path: string
  mode: 'full'
}

export interface CredentialExtractRule {
  path: string
  mode: 'extract'
  extract: Array<{
    pattern: string
    replacement?: string
  }>
}

export type CredentialFileRule = CredentialFullMaskRule | CredentialExtractRule

export interface CredentialMaskingConfig {
  enabled: boolean
  files: CredentialFileRule[]
  output_scrubbing: {
    enabled: boolean
    patterns: string[]
  }
  env_filter: {
    enabled: boolean
    patterns: string[]
  }
}
