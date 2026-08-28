/**
 * CRSI Self-Modification Seam — 给 CrsiSandbox 一个真实入口。
 *
 * CrsiSandbox 是一个「等输入的消费者」：它做 worktree → 改文件 → 跑测试 →
 * 人类批准 → merge，但此前没有任何东西产出它的输入 `CrsiModification`。
 *
 * 本模块补上「入口」这一端：
 *   - `runCrsiModification` 编排完整 5 阶段，是程序化 seam（未来的 producer 直接调它）。
 *   - `approvePending` / `rejectPending` 实现「人类批准/拒绝」的两阶段闸门。
 *
 * 注意：merge 只发生在显式 `approvePending` 之后——人类门保留。本模块
 * 不自动产出改动候选（producer 是独立的下一步）。
 */

import { randomUUID } from 'node:crypto'
import { CrsiSandbox, validateBlastRadius } from './crsi-sandbox'
import type { CrsiModificationResult } from './crsi-sandbox'
import { appendEvalScore, getLastEvalScore } from './eval-harness'
import { mechanismSentinel, type RewardFn } from './reward-fn'

export interface CrsiProposal {
  /** 人类可读的改动说明 */
  description: string
  /** 目标文件（相对仓库根，如 apps/cli/src/foo.ts） */
  filePath: string
  /** 改动后的完整文件内容 */
  newContent: string
  /** 改动前内容（用于安全性校验；空 = 宽松跳过） */
  originalContent?: string
  /** 触发此改动的 CRSI insight id */
  crsiInsightId?: string
  /**
   * 完整覆盖（blast radius）：此改动触及的**所有**代码路径（文件列表）。
   *
   * 源于 2026-08-26 教训：修「思考转储」只接实时指示器、漏历史行冲刷路径——
   * 局部正确、全局遗漏。自修改前必须摸清并声明全部受影响路径，否则 fail-closed 拒绝。
   */
  blastRadius?: string[]
}

// ── Pending proposal registry (两阶段闸门) ──
// 模块级单例：成功跑完测试的修改停在这里，等待人类 approve / reject。
let pendingSandbox: CrsiSandbox | null = null

/**
 * 编排完整 5 阶段：createWorktree → applyModification → runTests →（失败自动
 * rollback）→ getDiff。测试通过后暂存为 pending，返回 diff 供人类审阅。
 */
export async function runCrsiModification(
  proposal: CrsiProposal,
  sandbox: CrsiSandbox = new CrsiSandbox(),
  opts?: { rewardFn?: RewardFn },
): Promise<CrsiModificationResult> {
  // 完整覆盖闸：自修改必须声明 blastRadius，否则 fail-closed（在 worktree 之前，零副作用）。
  const blastRadiusError = validateBlastRadius(proposal)
  if (blastRadiusError) {
    return {
      modification: {
        id: 'crsi-mod-rejected-blast-radius',
        description: proposal.description,
        filePath: proposal.filePath,
        newContent: proposal.newContent,
        originalContent: proposal.originalContent ?? '',
        crsiInsightId: proposal.crsiInsightId,
        timestamp: new Date().toISOString(),
      },
      applied: false,
      phase: 'failed',
      error: blastRadiusError,
    }
  }

  sandbox.createWorktree()

  const applied = sandbox.applyModification({
    id: `crsi-mod-${randomUUID().slice(0, 8)}`,
    description: proposal.description,
    filePath: proposal.filePath,
    newContent: proposal.newContent,
    originalContent: proposal.originalContent ?? '',
    crsiInsightId: proposal.crsiInsightId,
    timestamp: new Date().toISOString(),
  })

  // apply 失败（受保护路径 / 路径穿越 / 内容不一致）——不跑测试，直接回滚。
  if (!applied.applied) {
    sandbox.rollback()
    applied.phase = 'failed' // rollback() 会把 phase 置为 'rolled-back'；恢复为 'failed'
    return applied
  }

  const testResult = sandbox.runTests()
  applied.testResult = testResult

  if (!testResult.passed) {
    sandbox.rollback()
    applied.phase = 'failed'
    return applied
  }

  // Reward gate：奖励分数不得低于上次记录（防跨合并退化）。
  // 默认机制哨兵；可插拔——调用方传 opts.rewardFn 换用其他奖励源（如任务表现）。
  const rewardFn = opts?.rewardFn ?? mechanismSentinel()
  const report = await rewardFn.evaluate()
  const last = getLastEvalScore(rewardFn.name)
  if (last !== null && report.score < last) {
    sandbox.rollback()
    applied.phase = 'failed'
    applied.error = `Reward regression (${rewardFn.name}): score ${report.score} < last ${last}`
    return applied
  }
  appendEvalScore(rewardFn.name, report)

  applied.phase = 'passed'
  applied.diff = sandbox.getDiff()
  pendingSandbox = sandbox
  return applied
}

/** 是否有待批准的修改。 */
export function hasPending(): boolean {
  return pendingSandbox !== null
}

/** 人类批准：merge 进仓库并清理 worktree。 */
export function approvePending(): { success: boolean; message: string } {
  if (!pendingSandbox) {
    return { success: false, message: '没有待批准的修改。先运行 /crsi modify。' }
  }
  const sandbox = pendingSandbox
  pendingSandbox = null
  const merged = sandbox.merge()
  sandbox.finalize()
  return merged
}

/** 人类拒绝：丢弃 worktree。 */
export function rejectPending(): { success: boolean; message: string } {
  if (!pendingSandbox) {
    return { success: false, message: '没有待批准的修改。先运行 /crsi modify。' }
  }
  const sandbox = pendingSandbox
  pendingSandbox = null
  return sandbox.rollback()
}
