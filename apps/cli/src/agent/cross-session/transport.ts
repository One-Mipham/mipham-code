import type { AgentMessage } from '../message-bus'
import type { SessionInfo } from '../../shared/types'

/**
 * Transport layer for cross-session messaging.
 * Implementations can use filesystem, unix sockets, TCP, etc.
 */
export interface CrossSessionTransport {
  /** Send a message to a destination session's inbox. Returns true on success. */
  send(from: SessionInfo, toSessionId: string, msg: AgentMessage): Promise<boolean>

  /** Poll for unread messages addressed to the given session. */
  poll(sessionId: string): Promise<AgentMessage[]>

  /** List all discoverable active sessions. */
  listSessions(): Promise<SessionInfo[]>
}
