/**
 * AgentMessageBus — inter-agent communication channel.
 *
 * Agents (main session + background sub-agents) can post and poll messages.
 * Messages are stored in-memory and keyed by recipient. Each message has a
 * read flag so recipients can distinguish new from seen messages.
 *
 * Usage:
 *   const bus = getMessageBus()
 *   const msgId = bus.post('main', 'bg-1', 'hello', 'How is it going?')
 *   const unread = bus.poll('bg-1')  // messages addressed TO bg-1
 */

export interface AgentMessage {
  id: string
  from: string
  to: string
  summary: string
  message: string
  timestamp: Date
  read: boolean
}

export class AgentMessageBus {
  private messages: AgentMessage[] = []
  private idCounter = 0

  /**
   * Post a message from one agent to another.
   * Returns the message ID.
   */
  post(from: string, to: string, summary: string, message: string): string {
    const id = `msg-${++this.idCounter}`
    this.messages.push({
      id,
      from,
      to,
      summary: summary.slice(0, 200),
      message,
      timestamp: new Date(),
      read: false,
    })
    return id
  }

  /**
   * Get all unread messages addressed to the given agent.
   * Does NOT mark them as read — use markRead() for that.
   */
  poll(agentId: string): AgentMessage[] {
    return this.messages.filter((m) => m.to === agentId && !m.read)
  }

  /**
   * Get all messages addressed to the given agent (read + unread).
   */
  list(agentId: string): AgentMessage[] {
    return this.messages.filter((m) => m.to === agentId)
  }

  /**
   * Mark a specific message as read by ID.
   * Returns true if the message was found and marked.
   */
  markRead(messageId: string): boolean {
    const msg = this.messages.find((m) => m.id === messageId)
    if (!msg) return false
    msg.read = true
    return true
  }

  /**
   * Mark all messages for a recipient as read.
   * Returns the count of messages marked.
   */
  markAllRead(agentId: string): number {
    let count = 0
    for (const msg of this.messages) {
      if (msg.to === agentId && !msg.read) {
        msg.read = true
        count++
      }
    }
    return count
  }

  /**
   * Get unread message count for an agent.
   */
  unreadCount(agentId: string): number {
    return this.messages.filter((m) => m.to === agentId && !m.read).length
  }

  /**
   * Prune messages older than maxAgeMs. Returns the number pruned.
   */
  prune(maxAgeMs: number = 60 * 60 * 1000): number {
    const now = Date.now()
    const before = this.messages.length
    this.messages = this.messages.filter(
      (m) => now - m.timestamp.getTime() < maxAgeMs,
    )
    return before - this.messages.length
  }
}

/** Singleton instance. */
let _instance: AgentMessageBus | null = null

export function getMessageBus(): AgentMessageBus {
  if (!_instance) {
    _instance = new AgentMessageBus()
  }
  return _instance
}
