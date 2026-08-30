/**
 * Working Memory — 用「已验证的当前任务状态」接地记忆召回（借鉴 Recuris 的 W，仅借概念）。
 *
 * 问题（治「前存后忘」）：MemoryManager.recall 用 TF-IDF 去和「刚说的 query」比，
 * 历史越长，旧但相关的记忆越容易被埋掉。Recuris 的解法是把召回绑定到「当前还剩
 * 什么没做」（pending/in_progress），而不是只绑定到「刚说了什么」。
 *
 * 本文件分两层：
 *  - Phase 1（纯只读）：`renderWorkingState(tasks)` 把「现有任务追踪」的未完成任务
 *    渲染成紧凑接地串，拼进 recall 的 query（状态接地召回）。
 *  - Phase 2（证据接地状态机）：`WorkingMemory` 类复现 Recuris「w_t → ρ → E_t → (a,o)
 *    → C → w_{t+1}」环——`done` 只能由 PostFlightChecker 的 `supported` 决策推进，
 *    `blocked` 由 `rejected` 置位；**没有「模型自称 done」的入口**（不信任模型叙事，
 *    只信任工具/env 观察）。
 */

import type { CheckerDecision } from './post-flight-checker'

export interface WorkingGoal {
  subject: string
  status: string
}

/** 渲染「当前仍未完成」的任务主题为紧凑接地串；无未完成任务返回空串。 */
export function renderWorkingState(tasks: ReadonlyArray<WorkingGoal>): string {
  const open = tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress')
  if (open.length === 0) return ''
  return open
    .map((t) => t.subject.trim())
    .filter(Boolean)
    .join('\n')
}

// ── Phase 2：证据接地状态机 ──

export type GoalStatus = 'pending' | 'done' | 'blocked'

export interface GoalState {
  id: string
  content: string
  status: GoalStatus
  /** 推进/置位时固化的证据（checkerId + reason），供审计「谁证明了这个状态」。 */
  evidence: string[]
}

/** 从现有任务追踪（Task 工具的 Task 列表）同步的最小结构，避免 import Task 造成循环依赖。 */
export interface TaskLike {
  id: string
  subject: string
  status: string
}

export class WorkingMemory {
  private goals = new Map<string, GoalState>()

  /** 注册一个待办目标（新目标默认 pending）。重复 id 只更新 content，不回退已验证的状态。 */
  setGoal(id: string, content: string): void {
    const existing = this.goals.get(id)
    if (existing) {
      existing.content = content
    } else {
      this.goals.set(id, { id, content, status: 'pending', evidence: [] })
    }
  }

  /**
   * 证据接地推进：`done` 只能由 checker `supported` 决策推进；`rejected` 置 `blocked`；
   * `no-checker` 不改状态（模型自称不算）。已 `done` 的目标不再回退。
   */
  observe(goalId: string, decision: CheckerDecision): void {
    const g = this.goals.get(goalId)
    if (!g || g.status === 'done') return
    if (decision.verdict === 'supported') {
      g.status = 'done'
      g.evidence.push(`supported:${decision.checkerId}`)
    } else if (decision.verdict === 'rejected') {
      g.status = 'blocked'
      g.evidence.push(`rejected:${decision.checkerId}:${decision.reason}`)
    }
    // no-checker：证据不足，状态不变
  }

  getGoal(id: string): GoalState | undefined {
    return this.goals.get(id)
  }

  /** 从现有任务追踪（Task 工具的 Task 列表）重建目标状态——TaskList 是唯一真源。
   *  pending/in_progress → pending；completed → done；failed → blocked；deleted 跳过。 */
  syncFromTasks(tasks: ReadonlyArray<TaskLike>): void {
    this.goals.clear()
    for (const t of tasks) {
      if (t.status === 'deleted') continue
      const status: GoalStatus =
        t.status === 'completed' ? 'done' : t.status === 'failed' ? 'blocked' : 'pending'
      this.goals.set(t.id, { id: t.id, content: t.subject, status, evidence: [] })
    }
  }

  /** 紧凑三态块（检索/系统提示用）；无任何目标时返回空串。 */
  renderWorkingState(): string {
    if (this.goals.size === 0) return ''
    const byStatus: Record<GoalStatus, string[]> = { pending: [], done: [], blocked: [] }
    for (const g of this.goals.values()) {
      byStatus[g.status].push(g.content.trim())
    }
    return (['pending', 'done', 'blocked'] as const)
      .map((s) => {
        const items = byStatus[s].filter(Boolean)
        return `[WORKING] ${s}: ${items.length > 0 ? items.join(', ') : '(none)'}`
      })
      .join('\n')
  }
}

// ── 证据账本（engine post-flight 后写入；Task 完成门读取） ──

export interface ToolEvidence {
  toolName: string
  decision: CheckerDecision
  at: number
}

/** 会话级证据账本（对齐 Task 工具的 module-level `tasks` Map，session 生命周期）。 */
const evidenceLog: ToolEvidence[] = []

/** 记录一次工具事后决策。no-checker 不产证据（忽略）。engine post-flight 后调用。 */
export function recordToolEvidence(toolName: string, decision: CheckerDecision): void {
  if (decision.verdict === 'no-checker') return
  evidenceLog.push({ toolName, decision, at: Date.now() })
}

/** 某时间点之后是否有 supported 决策（用于任务完成证据门）。 */
export function hasSupportedEvidenceSince(sinceAt: number): boolean {
  return evidenceLog.some((e) => e.decision.verdict === 'supported' && e.at >= sinceAt)
}

/** 测试用：清空证据账本（避免跨测试污染）。 */
export function clearEvidenceLog(): void {
  evidenceLog.length = 0
}
