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
  /** Uncached prompt input only — cached tokens ride the two buckets below. */
  inputTokens: number
  outputTokens: number
  /** Prompt-cache reads, billed separately. Absent when the provider reported none. */
  cacheReadTokens?: number
  /** Prompt-cache writes, billed separately. Absent when the provider reported none. */
  cacheWriteTokens?: number
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
/**
 * 会话读数（daemon → 客户端）。`attach` 的本地 `getContext()` 是个薄桩，
 * `/status`、`/cost`、`/doctor` 这类只读命令要用到的 token / 窗口 / checkpoint
 * 数都在 daemon 手里 —— 由这一帧送过来，客户端据此作答，而不是显示一排 0。
 *
 * 每个字段都按「daemon 可能没送」处理：两端版本独立，缺字段或类型不对时客户端
 * 保持原值（不拿 NaN 去渲染）。
 */
export interface ServerStatsMessage {
  type: 'stats'
  sessionId: string
  /** 引擎上下文当前的估算 token 数。 */
  estimatedTokens: number
  /** 模型上下文窗口。 */
  maxTokens: number
  /** 触发压缩的阈值（token）。 */
  compactionThreshold: number
  /** 引擎上下文里的消息数。 */
  messageCount: number
  /** 本会话已保存的 checkpoint 数。 */
  checkpointCount: number
  /** 当前由 provider prompt cache 提供的 token 数。 */
  cachedTokens: number
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
  | ServerStatsMessage
