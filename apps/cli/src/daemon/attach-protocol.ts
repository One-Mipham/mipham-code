// apps/cli/src/daemon/attach-protocol.ts
// Client → Daemon: prompt, interrupt, set_mode
// Daemon → Client: text, tool_use, tool_result, usage, task_notification, done, error,
//                  session_state, mode

import type { PermissionMode } from '../shared/types'

export interface ClientPromptMessage {
  type: 'prompt'
  sessionId: string
  prompt: string
}
export interface ClientInterruptMessage {
  type: 'interrupt'
  sessionId: string
}
export interface ClientSetModeMessage {
  type: 'set_mode'
  sessionId: string
  /**
   * 请求的档位。daemon 会先过白名单、再走组织级限制的钳制，然后回播**生效**的那一档。
   *
   * `sessionId` 与 `prompt` / `interrupt` 一样是协议对称用的：daemon 一概以
   * `ws.data.sessionId` 为准（否则一个 attach 就能改**别的**会话的闸门）。
   */
  mode: PermissionMode
}
export type ClientMessage = ClientPromptMessage | ClientInterruptMessage | ClientSetModeMessage

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
  /** 本会话当前**生效**的档位 —— 新 attach 的客户端据此初始化页脚，而不是猜 `default`。 */
  mode: PermissionMode
}
/**
 * 回播生效档位。两个触发点：客户端发来 `set_mode`（含被拒的请求 —— 那时回播的是
 * **当前**档），以及 `set_mode` 施加后。带的是 `PermissionSystem.getMode()` 的读数，
 * 即**钳制之后**的值：报请求值就是那条老缺陷的形状 —— 说放行、实际审批。
 */
export interface ServerModeMessage {
  type: 'mode'
  sessionId: string
  mode: PermissionMode
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
  | ServerModeMessage
