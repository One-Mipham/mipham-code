/**
 * Working Memory — 用「已验证的当前任务状态」接地记忆召回（借鉴 Recuris 的 W，仅借概念）。
 *
 * 问题（治「前存后忘」）：MemoryManager.recall 用 TF-IDF 去和「刚说的 query」比，
 * 历史越长，旧但相关的记忆越容易被埋掉。Recuris 的解法是把召回绑定到「当前还剩
 * 什么没做」（pending/in_progress），而不是只绑定到「刚说了什么」。
 *
 * 本模块只做一件事：把未完成任务渲染成紧凑的接地串，拼进 recall 的 query。
 * 纯只读、无状态推进（证据接地的状态推进留待 Phase 2）。
 */

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
