// apps/cli/src/daemon/goal-manager.ts — Phase 4: Goal service layer
// Thin delegation over DaemonDatabase goal methods.
// Pattern matches AgentManager (Phase 3) and SessionManager (Phase 1).

import type { DaemonDatabase } from './database'
import type { DaemonGoal } from './types'

export class GoalManager {
  private db: DaemonDatabase

  constructor(db: DaemonDatabase) {
    this.db = db
  }

  createGoal(
    sessionId: string,
    description: string,
    progress?: { current: number; total: number },
  ): number {
    const now = new Date().toISOString()
    return this.db.createGoal({
      sessionId,
      description,
      status: 'active',
      progress: progress ?? null,
      createdAt: now,
      updatedAt: now,
    })
  }

  getGoals(sessionId: string): DaemonGoal[] {
    return this.db.getGoals(sessionId)
  }

  updateGoal(
    id: number,
    updates: Partial<Pick<DaemonGoal, 'status' | 'description' | 'progress'>>,
  ): void {
    this.db.updateGoal(id, updates)
  }

  completeGoal(id: number): void {
    this.db.updateGoal(id, { status: 'completed' })
  }

  pauseGoal(id: number): void {
    this.db.updateGoal(id, { status: 'paused' })
  }

  clearGoal(id: number): void {
    this.db.updateGoal(id, { status: 'cleared' })
  }
}
