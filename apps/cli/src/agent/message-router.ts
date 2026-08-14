import { getMessageBus } from './message-bus'
import { getFileInboxTransport } from './cross-session/file-inbox'
import { discoverSessions, createSessionInfo } from './cross-session/discovery'
import type { AgentMessage } from './message-bus'
import type { SessionInfo } from '../shared/types'

export interface RouteResult {
  success: boolean
  routedTo: 'bus' | 'inbox' | 'unknown'
  error?: string
  messageId?: string
}

export interface SessionResolution {
  session?: SessionInfo
  error?: string
}

/**
 * Resolve a recipient among live sessions by bare name — session ID first,
 * then session name. A name must uniquely match exactly one session; ambiguity
 * and non-matches are reported as errors.
 */
export function resolveRecipientSession(sessions: SessionInfo[], to: string): SessionResolution {
  const byId = sessions.find((s) => s.id === to)
  if (byId) return { session: byId }

  const byName = sessions.filter((s) => s.name === to)
  if (byName.length === 1) return { session: byName[0] }
  if (byName.length > 1) {
    return {
      error:
        `Ambiguous session name "${to}" matches ${byName.length} live sessions. ` +
        `Use a session ID to disambiguate (ListAgents).`,
    }
  }

  return {
    error: `No active session found matching "${to}". Use ListAgents to discover available sessions.`,
  }
}

export interface MentionParse {
  name: string
  message: string
}

/**
 * Parse a user-input `@name message` mention. Returns null when the input does
 * not start with an @mention. The message may be empty — callers decide whether
 * an empty body is valid. Used by the input bar to route a direct cross-session
 * message without going through the AI.
 */
export function parseMention(input: string): MentionParse | null {
  const trimmed = input.trim()
  const m = /^@(\S+)(?:\s+([\s\S]+))?$/.exec(trimmed)
  if (!m) return null
  return { name: m[1]!, message: (m[2] ?? '').trim() }
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

    // Cross-session routing (by session ID or bare name)
    const sessions = discoverSessions()
    const resolution = resolveRecipientSession(sessions, to)

    if (resolution.error) {
      return { success: false, routedTo: 'unknown', error: resolution.error }
    }
    const targetSession = resolution.session!

    // Get sender info — resolve the human-readable name when the sender is a
    // registered session, else fall back to the raw id (e.g. non-session senders).
    const senderName = discoverSessions().find((s) => s.id === from)?.name ?? from
    const senderSession = createSessionInfo(from, senderName)

    try {
      const transport = getFileInboxTransport()
      const msg: AgentMessage = {
        id: `xmsg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        from,
        to: targetSession.id,
        summary: summary.slice(0, 200),
        message,
        timestamp: new Date(),
        read: false,
        type: 'message',
      }

      const delivered = await transport.send(senderSession, targetSession.id, msg)
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
