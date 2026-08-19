// apps/cli/src/daemon/heartbeat.ts — 心跳式通知（保守版 KAIROS「订阅与推送」）
//
// 借鉴 Claude Code KAIROS 的「主动感知」思路，但严格约束为「只通知、不自主行动」：
//   - 定时扫描 pending 的 goal（active）与 schedule（enabled）
//   - 有 pending 时推送一条摘要（默认走 Feishu），无 pending 时静默
//   - 绝不替用户执行任何动作——「主动感知可以，自主行动必须有闸门」（CRSI 受约束哲学）
//
// 纯函数（collectPendingItems / buildHeartbeatMessage / heartbeatTick）便于测试；
// startHeartbeat 只做 setInterval + unref 的薄接线。

import type { DaemonGoal, DaemonSchedule } from './types'

/** 默认心跳间隔：30 分钟（提醒型通知，不宜过频）。 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30 * 60_000

export interface PendingItems {
  goalCount: number
  scheduleCount: number
  summaries: string[]
}

/** 收集待办项：active 的 goal + enabled 的 schedule。纯函数。 */
export function collectPendingItems(
  goals: DaemonGoal[],
  schedules: DaemonSchedule[],
): PendingItems {
  const activeGoals = goals.filter((g) => g.status === 'active')
  const enabledSchedules = schedules.filter((s) => s.enabled)

  const summaries: string[] = []
  for (const g of activeGoals) summaries.push(`🎯 ${g.description}`)
  for (const s of enabledSchedules) summaries.push(`⏰ [${s.cronExpr}] ${s.prompt}`)

  return {
    goalCount: activeGoals.length,
    scheduleCount: enabledSchedules.length,
    summaries,
  }
}

const MAX_SUMMARY_ITEMS = 10

/** 把待办渲染成通知文案；无可待办时返回 null（不打扰）。纯函数。 */
export function buildHeartbeatMessage(pending: PendingItems): string | null {
  if (pending.goalCount === 0 && pending.scheduleCount === 0) return null

  const lines = [
    `💓 Mipham 心跳提醒：${pending.goalCount} 个待办 goal，${pending.scheduleCount} 个定时任务`,
    '',
    ...pending.summaries.slice(0, MAX_SUMMARY_ITEMS),
  ]
  if (pending.summaries.length > MAX_SUMMARY_ITEMS) {
    lines.push(`… 另外 ${pending.summaries.length - MAX_SUMMARY_ITEMS} 项`)
  }
  return lines.join('\n')
}

export interface HeartbeatSource {
  listGoals(): DaemonGoal[]
  listSchedules(): DaemonSchedule[]
}

/** 单次心跳：收集待办，有则推送。抽出来便于直接测试。 */
export function heartbeatTick(source: HeartbeatSource, push: (message: string) => void): void {
  const pending = collectPendingItems(source.listGoals(), source.listSchedules())
  const message = buildHeartbeatMessage(pending)
  if (message) push(message)
}

export interface HeartbeatDeps {
  source: HeartbeatSource
  push: (message: string) => void
  intervalMs?: number
}

/** 启动心跳定时器（unref 不阻止进程退出），返回 stop 函数。 */
export function startHeartbeat(deps: HeartbeatDeps): () => void {
  const intervalMs = deps.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  const id = setInterval(() => heartbeatTick(deps.source, deps.push), intervalMs)
  // Bun 的 Timer 有 unref；假定时器/其它运行时不保证——用可选调用容错。
  ;(id as { unref?: () => void }).unref?.()
  return () => clearInterval(id)
}
