import { getMessageBus } from './message-bus'
import { getFileInboxTransport } from './cross-session/file-inbox'
import { discoverSessions, createSessionInfo } from './cross-session/discovery'
import type { AgentMessage } from './message-bus'

export interface RouteResult {
  success: boolean
  routedTo: 'bus' | 'inbox' | 'unknown'
  error?: string
  messageId?: string
}

/**
 * MessageRouter decides how to deliver a message based on the recipient.
 *
 * - "main" or background task IDs → in-memory AgentMessageBus (same process)
 * - Session IDs matching discoverable sessions → file inbox (cross-session)
 * - Unknown → error
 */
export class MessageRouter {
  /**
   * Route a message to the appropriate transport.
   */
  async route(from: string, to: string, summary: string, message: string): Promise<RouteResult> {
    // Same-process routing: "main" or background task IDs
    if (to === 'main' || to.startsWith('bg-') || to.startsWith('sub-agent-')) {
      try {
        const bus = getMessageBus()
        const msgId = bus.post(from, to, summary, message)
        return { success: true, routedTo: 'bus', messageId: msgId }
      } catch (err) {
        return { success: false, routedTo: 'bus', error: String(err) }
      }
    }

    // Cross-session routing
    const sessions = discoverSessions()
    const targetSession = sessions.find((s) => s.id === to)

    if (!targetSession) {
      return {
        success: false,
        routedTo: 'unknown',
        error: `No active session found with ID "${to}". Use ListAgents to discover available sessions.`,
      }
    }

    // Get sender info
    const senderSession = createSessionInfo(from, from)

    try {
      const transport = getFileInboxTransport()
      const msg: AgentMessage = {
        id: `xmsg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        from,
        to,
        summary: summary.slice(0, 200),
        message,
        timestamp: new Date(),
        read: false,
        type: 'message',
      }

      const delivered = await transport.send(senderSession, to, msg)
      if (!delivered) {
        return { success: false, routedTo: 'inbox', error: 'Failed to write message to inbox.' }
      }

      return { success: true, routedTo: 'inbox', messageId: msg.id }
    } catch (err) {
      return { success: false, routedTo: 'inbox', error: String(err) }
    }
  }
}

let _router: MessageRouter | null = null

export function getMessageRouter(): MessageRouter {
  if (!_router) {
    _router = new MessageRouter()
  }
  return _router
}
