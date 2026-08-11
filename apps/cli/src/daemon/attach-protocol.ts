// apps/cli/src/daemon/attach-protocol.ts
// Client → Daemon: prompt, interrupt
// Daemon → Client: text, tool_use, tool_result, usage, task_notification, done, error, session_state

export interface ClientPromptMessage {
  type: 'prompt'
  sessionId: string
  prompt: string
}
export interface ClientInterruptMessage {
  type: 'interrupt'
  sessionId: string
}
export type ClientMessage = ClientPromptMessage | ClientInterruptMessage

export interface ServerTextMessage {
  type: 'text'
  sessionId: string
  content: string
}
export interface ServerToolUseMessage {
  type: 'tool_use'
  sessionId: string
  toolName: string
  toolInput: Record<string, unknown>
  toolId: string
}
export interface ServerToolResultMessage {
  type: 'tool_result'
  sessionId: string
  toolId: string
  content: string
  isError?: boolean
}
export interface ServerUsageMessage {
  type: 'usage'
  sessionId: string
  inputTokens: number
  outputTokens: number
}
export interface ServerTaskNotificationMessage {
  type: 'task_notification'
  sessionId: string
  taskId: string
  status: string
}
export interface ServerDoneMessage {
  type: 'done'
  sessionId: string
  stopReason: string
}
export interface ServerErrorMessage {
  type: 'error'
  sessionId: string
  message: string
}
export interface ServerSessionStateMessage {
  type: 'session_state'
  sessionId: string
  messages: unknown[]
  provider: string
  model: string
  turnCount: number
}

export type ServerMessage =
  | ServerTextMessage
  | ServerToolUseMessage
  | ServerToolResultMessage
  | ServerUsageMessage
  | ServerTaskNotificationMessage
  | ServerDoneMessage
  | ServerErrorMessage
  | ServerSessionStateMessage
