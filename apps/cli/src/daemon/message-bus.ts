// apps/cli/src/daemon/message-bus.ts — Phase 3: Inter-Agent Message Bus
//
// MessageBus provides asynchronous message passing between agents:
//   - send()    — enqueue a message from one agent to another
//   - poll()    — retrieve and clear pending messages (discards TTL-expired)
//   - broadcastToSession() — send a message to all agents in a session
//
// Messages older than 5 minutes are automatically discarded on poll.
// Session-to-agent mapping is maintained externally via registerAgent/unregisterAgent.

interface BusMessage {
  sender: string
  content: string
  timestamp: number
}

export class MessageBus {
  private queues = new Map<string, BusMessage[]>()
  private sessionAgents = new Map<string, Set<string>>()
  private readonly ttlMs = 5 * 60 * 1000 // 5 minutes

  /**
   * Register an agent to a session so that broadcastToSession can reach it.
   */
  registerAgent(sessionId: string, agentId: string): void {
    if (!this.sessionAgents.has(sessionId)) {
      this.sessionAgents.set(sessionId, new Set())
    }
    this.sessionAgents.get(sessionId)!.add(agentId)
  }

  /**
   * Remove an agent from all session registrations and clear its message queue.
   */
  unregisterAgent(agentId: string): void {
    for (const [, agents] of this.sessionAgents) {
      agents.delete(agentId)
    }
    this.queues.delete(agentId)
  }

  /**
   * Enqueue a message from senderAgentId to receiverAgentId.
   */
  send(senderAgentId: string, receiverAgentId: string, content: string): void {
    if (!this.queues.has(receiverAgentId)) {
      this.queues.set(receiverAgentId, [])
    }
    this.queues.get(receiverAgentId)!.push({
      sender: senderAgentId,
      content,
      timestamp: Date.now(),
    })
  }

  /**
   * Retrieve and clear all pending messages for an agent.
   * Messages older than the TTL (5 min) are discarded.
   */
  poll(agentId: string): BusMessage[] {
    const queue = this.queues.get(agentId)
    if (!queue || queue.length === 0) return []

    const now = Date.now()
    const valid = queue.filter((msg) => now - msg.timestamp < this.ttlMs)

    this.queues.delete(agentId)
    return valid
  }

  /**
   * Send a message to every agent in a session except the one specified.
   * The sender is recorded as 'system'.
   */
  broadcastToSession(sessionId: string, content: string, excludeAgentId?: string): void {
    const agents = this.sessionAgents.get(sessionId)
    if (!agents) return
    for (const agentId of agents) {
      if (agentId !== excludeAgentId) {
        this.send('system', agentId, content)
      }
    }
  }
}
