// apps/cli/src/daemon/agent-manager.ts
// AgentManager — service layer wrapping the agents DB table from Phase 1.
// Delegates persistence to DaemonDatabase; adds ID generation on create.
// Pattern matches SessionManager from Phase 1.
//
// Phase 3: Added lifecycle event callbacks for WebSocket broadcast.

import type { DaemonDatabase } from './database'
import type { DaemonAgent, AgentKind } from './types'

export interface AgentLifecycleEvent {
  type: 'created' | 'completed' | 'failed'
  agent: DaemonAgent
}

type AgentLifecycleCallback = (event: AgentLifecycleEvent) => void

export class AgentManager {
  private db: DaemonDatabase
  private lifecycleCallbacks: AgentLifecycleCallback[] = []

  constructor(db: DaemonDatabase) {
    this.db = db
  }

  createAgent(
    sessionId: string,
    agentType: string,
    description: string,
    kind: AgentKind = 'interactive',
    parentId: string | null = null,
  ): DaemonAgent {
    const id = `agent-${crypto.randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    const agent = this.db.createAgent({
      id,
      sessionId,
      parentId,
      agentType,
      description,
      status: 'running',
      kind,
      worktree: null,
      branch: null,
      prUrl: null,
      createdAt: now,
      completedAt: null,
      result: null,
      error: null,
    })
    this.emit({ type: 'created', agent })
    return agent
  }

  getAgent(id: string): DaemonAgent | null {
    return this.db.getAgent(id)
  }

  listAgents(sessionId?: string): DaemonAgent[] {
    return this.db.listAgents(sessionId)
  }

  listRunningAgents(): DaemonAgent[] {
    return this.listAgents().filter((a) => a.status === 'running')
  }

  completeAgent(id: string, result: string): void {
    this.db.updateAgentStatus(id, 'completed', result)
    const updated = this.db.getAgent(id)
    if (updated) {
      this.emit({ type: 'completed', agent: updated })
    }
  }

  failAgent(id: string, error: string): void {
    this.db.updateAgentStatus(id, 'failed', undefined, error)
    const updated = this.db.getAgent(id)
    if (updated) {
      this.emit({ type: 'failed', agent: updated })
    }
  }

  stopAgent(id: string): DaemonAgent | null {
    const agent = this.db.getAgent(id)
    if (!agent) return null
    if (agent.status !== 'running') return agent

    this.db.updateAgentStatus(id, 'completed')
    const updated = this.db.getAgent(id)
    if (updated) {
      this.emit({ type: 'completed', agent: updated })
    }
    return updated
  }

  /** Subscribe to agent lifecycle events (created / completed / failed). */
  onLifecycleEvent(callback: AgentLifecycleCallback): void {
    this.lifecycleCallbacks.push(callback)
  }

  private emit(event: AgentLifecycleEvent): void {
    for (const cb of this.lifecycleCallbacks) {
      try {
        cb(event)
      } catch {
        // Callback errors must not propagate
      }
    }
  }
}
