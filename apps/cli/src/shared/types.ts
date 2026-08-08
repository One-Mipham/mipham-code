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
export type ToolCategory =
  'file' | 'exec' | 'agent' | 'network' | 'system' | 'artifact' | 'scheduling'

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
  backgroundAgentRegistry?: import('../agent/background-registry').BackgroundAgentRegistry
  permissionSystem?: import('../core/permission').PermissionSystem
  ruleEngine?: import('../core/rule-engine').ExperienceRuleEngine
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

// ── Task Notification Types ──
export interface TaskNotification {
  taskId: string
  status: 'started' | 'completed' | 'failed'
  description: string
  content?: string
  error?: string
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
  taskNotification?: TaskNotification
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
  /** Org-level permission restrictions (forbiddenModes, maxAllowedMode). */
  permissionRestrictions?: PermissionRestrictions
  providers: ProviderConfig[]
  skills?: { paths: string[]; mcpServers: McpServerConfig[] }
  marketplace?: {
    /** If set, only allow installs from matching repos (e.g. ["One-Mipham/*"]) */
    strictKnownMarketplaces?: string[]
    /** Block installs from matching repos (e.g. ["malicious-org/*"]) */
    blockedMarketplaces?: string[]
  }
  /** Phase 9 feature flags. All default to true. */
  features?: Partial<FeatureFlags>
  /** Phase 10 CRSI feature flags. All default to true. */
  crsi?: Partial<CrsiConfig>
}

export interface FeatureFlags {
  mcp: { oauthEnabled: boolean }
  context: { useRealTokenizer: boolean; adaptiveThresholds: boolean }
}

export interface CrsiConfig {
  /** Extract and inject experience rules into agent system prompts. */
  ruleInjection: boolean
  /** Intercept tool calls and auto-fix known failure patterns before execution. */
  preToolHook: boolean
  /** Analyze agent outcomes for recurring failure patterns. */
  autoPatternAnalysis: boolean
  /** Auto-degrade/disable low-effectiveness rules based on success-rate tracking. */
  autoRuleManagement: boolean
}

export interface McpServerConfig {
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  auth?: {
    type: 'oauth'
    authorizationUrl: string
    tokenUrl: string
    clientId: string
    scopes?: string[]
    redirectPort?: number
  }
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
/** Six explicit permission modes matching Claude Code's permission architecture */
export type PermissionMode =
  'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions'

/** Backward-compatible alias: PermissionMode plus legacy 'ask' and 'bypass' */
export type PermissionLevel = PermissionMode | 'ask' | 'bypass'

/** Org-level restrictions that cap or forbid specific permission modes. */
export interface PermissionRestrictions {
  /** Modes that may not be entered (cycle skips them). */
  forbiddenModes?: PermissionMode[]
  /** Ceiling — modes ranked higher (more permissive) than this are treated as forbidden. */
  maxAllowedMode?: PermissionMode
}

export interface PermissionConfig {
  mode: PermissionMode
  allow: string[]
  deny: string[]
  /** Optional org-level restrictions enforced on every mode transition. */
  restrictions?: PermissionRestrictions
}

export interface PermissionRuleEntry {
  pattern: string // e.g., "Bash(git:*)"
  level: 'allow' | 'deny' | 'ask'
  compiled: RegExp
}

export interface PermissionRule {
  toolName: string
  level: PermissionLevel
  pattern?: string
}

// ── Inference Hook (DLP) Types ──

/** Configuration for the PreInference DLP hook, loaded from config.yml. */
export interface InferenceHookConfig {
  /** DLP server endpoint (HTTPS). Empty = feature disabled. */
  endpoint: string
  /** HMAC signing secret (format: mis_<random>). */
  signing_secret: string
  /** Request timeout in milliseconds. Default 5000. */
  timeout: number
  /** Failure posture: 'fail-closed' blocks on error, 'fail-open' allows. */
  on_failure: 'fail-closed' | 'fail-open'
  /** Organization identifier (optional, sent in payload). */
  organization_id: string
  /** Additional custom headers to send with each request. */
  headers: Record<string, string>
}

/** Outgoing request to the DLP server. */
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

/** Response from the DLP server. */
export interface InferenceCheckResponse {
  verdict: 'allow' | 'deny'
  reason?: string
}

// ── Credential Masking Types ──

/** Full-file masking rule: entire file content replaced with sentinel. */
export interface CredentialFullMaskRule {
  path: string
  mode: 'full'
}

/** Per-extract-pattern configuration with optional field-based extraction. */
export interface CredentialExtractPattern {
  /** Regex pattern to match. When `field` is set, applied to field value only. */
  pattern: string
  /** Optional replacement string. Defaults to CREDENTIAL_SENTINEL. */
  replacement?: string
  /** 🆕 JSON key to extract before applying pattern. If unset, pattern runs against full content. */
  field?: string
}

/** Extract-based masking rule: only regex-matched tokens are replaced. */
export interface CredentialExtractRule {
  path: string
  mode: 'extract'
  extract: CredentialExtractPattern[]
  /** 🆕 Behavior when no extract pattern matches: 'mask' (replace all) or 'passthrough' (keep). Default: 'mask'. */
  onExtractNoMatch?: 'mask' | 'passthrough'
}

/** 🆕 JWT-aware masking rule: decode payload and mask specified claims. */
export interface JwtMaskingRule {
  path: string
  type: 'jwt'
  decode: 'jwt'
  /** Claim names to mask in the JWT payload (e.g. ["sub", "email"]). */
  maskClaims: string[]
}

/** 🆕 AWS credential pair masking rule: detect key pairs and optionally re-sign. */
export interface AwsMaskingRule {
  path: string
  type: 'aws'
  awsPairs: boolean
  sigv4: boolean
}

export type CredentialFileRule =
  CredentialFullMaskRule | CredentialExtractRule | JwtMaskingRule | AwsMaskingRule

/** Configuration for credential masking, loaded from config.yml. */
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

// ── Cross-Session Messaging Types ──

/** Controls how inbound cross-session messages are handled. */
export type CrossSessionInbound = 'allow' | 'ask' | 'deny'

/** 🆕 Configuration for cross-session messaging. */
export interface CrossSessionConfig {
  crossSessionInbound: CrossSessionInbound
  dialogExpiry: number // seconds
}

/** Session information exposed via ListAgents. */
export interface SessionInfo {
  id: string
  name: string
  machine: string
  pid: number
  startedAt: string
  cwd?: string
  provider?: string
  model?: string
}

// ── Background Agent Types ──

export interface BackgroundAgentConfig {
  auto_commit: boolean
  auto_push: boolean
  auto_worktree: boolean
  commit_coauthors: boolean
}
