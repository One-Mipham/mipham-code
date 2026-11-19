/**
 * ELITE（2611.21056）的整合算子：多提案 → 一个兼容后代。
 *
 * 论文的观察是：直接「选一个探索出的孩子继续」会丢掉其它孩子里的互补机制。
 * 它改为从**同一父本**并行提出多个聚焦改进，检查它们互补 / 冗余 / 冲突，
 * 再把**兼容子集**重新实现为一个连贯的后代。
 *
 * 本模块只做确定性部分：以 `originalContent` 为共同父本做 3-way merge
 * （`git merge-file -p`，不调 LLM、不判定好坏）。
 *   - 能干净合并 ⇒ 互补，收进后代；
 *   - 与已有提案字节相同 ⇒ 冗余，只留一份；
 *   - 改同一段且内容不同 ⇒ 冲突，**单列并默认拒绝**（不静默丢弃机制）。
 *
 * 冲突默认 fail-closed：`--drop-conflicts` 是调用方显式选择「只整合兼容子集」，
 * 与论文的 compatible subset 对应；没有这个开关时，丢掉一个机制必须是人的决定。
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface IntegrationProposal {
  /** 展示名（通常是提案文件路径）。 */
  name: string
  /** 该提案给出的**完整文件内容**（与 `runCrsiModification` 同一形状）。 */
  content: string
}

export interface IntegrationConflict {
  name: string
  /** `git merge-file` 报告的冲突块数。 */
  conflictCount: number
}

export interface IntegrationResult {
  /** 无冲突且至少合并了一个提案。 */
  ok: boolean
  /** 兼容子集的合并结果；一个都没合并成时为 null。 */
  content: string | null
  /** 成功合并的提案名（按输入顺序）。 */
  merged: string[]
  /** 与父本或先前提案字节相同的提案名（保留第一份）。 */
  redundant: string[]
  /** 与已合并内容改同一段的提案。 */
  conflicts: IntegrationConflict[]
  /** 环境/参数错误（与「提案冲突」区分：那是提案的属性，这是没能比较）。 */
  error?: string
}

/** `git merge-file -p` 的退出码 = 冲突块数；0 = 干净合并。 */
function mergeFile(
  currentPath: string,
  basePath: string,
  otherPath: string,
): { merged: true; output: string } | { merged: false; conflictCount: number } {
  try {
    return {
      merged: true,
      output: execFileSync('git', ['merge-file', '-p', currentPath, basePath, otherPath], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    }
  } catch (err) {
    const status = (err as { status?: unknown }).status
    // 正整数 = 冲突块数（git 的契约），不是「命令坏了」。
    if (typeof status === 'number' && status > 0) {
      return { merged: false, conflictCount: status }
    }
    throw err
  }
}

export function integrateProposals(
  originalContent: string,
  proposals: IntegrationProposal[],
): IntegrationResult {
  const base: IntegrationResult = {
    ok: false,
    content: null,
    merged: [],
    redundant: [],
    conflicts: [],
  }
  if (proposals.length < 2) {
    return { ...base, error: '至少需要两个提案才能整合' }
  }

  const dir = mkdtempSync(join(tmpdir(), 'mipham-crsi-integrate-'))
  try {
    const basePath = join(dir, 'base.txt')
    const currentPath = join(dir, 'current.txt')
    writeFileSync(basePath, originalContent)
    writeFileSync(currentPath, originalContent)
    let current = originalContent
    const seen = new Set<string>([originalContent])
    const merged: string[] = []
    const redundant: string[] = []
    const conflicts: IntegrationConflict[] = []

    proposals.forEach((proposal, index) => {
      if (seen.has(proposal.content)) {
        // 与父本相同（没改）或与先前提案相同（同一机制说了两遍）——只留一份。
        redundant.push(proposal.name)
        return
      }
      seen.add(proposal.content)
      const otherPath = join(dir, `proposal-${index}.txt`)
      writeFileSync(otherPath, proposal.content)
      let outcome: ReturnType<typeof mergeFile>
      try {
        outcome = mergeFile(currentPath, basePath, otherPath)
      } catch (err) {
        // git 不可用/不可执行：与「提案冲突」不同类，必须报出来而不是读成冲突。
        throw new Error(
          `整合需要 git merge-file，但它没能运行：${err instanceof Error ? err.message : String(err)}`,
        )
      }
      if (!outcome.merged) {
        conflicts.push({ name: proposal.name, conflictCount: outcome.conflictCount })
        return
      }
      current = outcome.output
      writeFileSync(currentPath, current)
      merged.push(proposal.name)
    })

    return {
      ok: conflicts.length === 0 && merged.length > 0,
      content: merged.length > 0 ? current : null,
      merged,
      redundant,
      conflicts,
    }
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 整合摘要的一行读数（只描述，不判定）。 */
export function formatIntegrationSummary(result: IntegrationResult): string {
  const parts = [`兼容 ${result.merged.length}`]
  if (result.redundant.length > 0) parts.push(`冗余 ${result.redundant.length}（只留一份）`)
  if (result.conflicts.length > 0) parts.push(`冲突 ${result.conflicts.length}`)
  return parts.join(' · ')
}
