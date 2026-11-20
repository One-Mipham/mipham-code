/**
 * 试用期（probation）：合并之后、裁定之前。
 *
 * `/crsi modify --approve` 是终态 —— 合并后变坏只能靠人事后发现。本模块给
 * **有一次任务表现测量**的合并开一个观察窗：后续同口径重测满 N 次时出裁定；
 * 判为退化**只打印** `git revert <sha>`，**不执行**（破坏性 git 由人敲）。
 *
 * 边界（刻意）：没有随机信号就没有观察窗 —— `core/*.ts` 的合并不开窗，
 * 由 `/crsi stats` 明说「没有可用仪器」，而不是静默跳过。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { atomicWriteFileSync } from '../shared/atomic-write'
import { miphamHome } from './paths.ts'
import { classifyDelta, computeMinEffect, type ImprovementVerdict } from './improvement-track'

/** 观察窗长度：同一 skill、同一 gate 池、k≥3 的重测次数。 */
export const PROBATION_WINDOW = 3

export interface ProbationRecord {
  id: string
  filePath: string
  skillName: string
  commitHash: string
  /** 合并时的 k 个 post 臂采样（不是标量：噪声要用它估）。 */
  baselineScores: number[]
  /** 观察窗内每次同口径重测。 */
  checks: number[]
  /** 组内 gate 题数 —— 地板 = 两题步长 = `2 × (100 / poolSize)`。 */
  poolSize: number
  /** 窗口未满时**缺席**（与 `inconclusive` 不同形）。 */
  verdict?: ImprovementVerdict
  /**
   * 这次合并没有任何随机仪器可用（例如改了 `core/*.ts`）。
   * 登记它是为了**说出来** —— 静默跳过会让「没有仪器」和「没有合并」同形。
   */
  noInstrument?: true
  timestamp: string
}

export function probationPath(): string {
  return miphamHome('crsi', 'probation.jsonl')
}

export function readProbations(): ProbationRecord[] {
  const file = probationPath()
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ProbationRecord]
      } catch {
        return [] // 残留坏行跳过，不抛（与引入台账同口径）
      }
    })
}

function writeProbations(records: ProbationRecord[]): void {
  mkdirSync(miphamHome('crsi'), { recursive: true })
  atomicWriteFileSync(
    probationPath(),
    records.map((r) => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : ''),
  )
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}

function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  const variance = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)
  return Math.sqrt(variance)
}

/** 地板 = 两题步长（4 题池即 50）：单题翻转不判退化。 */
export function probationMinEffect(baseline: number[], checks: number[], poolSize: number): number {
  const noise = Math.max(stdDev(baseline), stdDev(checks))
  return computeMinEffect(noise, 2 * (100 / Math.max(1, poolSize)))
}

export function openProbation(
  rec: Omit<ProbationRecord, 'id' | 'checks' | 'verdict' | 'timestamp'>,
): void {
  const records = readProbations()
  records.push({
    ...rec,
    id: randomUUID(),
    checks: [],
    timestamp: new Date().toISOString(),
  })
  writeProbations(records)
}

/**
 * 登记一次「没有随机仪器」的合并。它没有基线、永远不会结算 —— 存在的唯一目的
 * 是让 `/crsi stats` 说得出这句话，而不是让这次合并从台账里消失。
 */
export function recordNoInstrument(rec: { filePath: string; commitHash: string }): void {
  const records = readProbations()
  records.push({
    id: randomUUID(),
    filePath: rec.filePath,
    skillName: rec.filePath,
    commitHash: rec.commitHash,
    baselineScores: [],
    checks: [],
    poolSize: 0,
    noInstrument: true,
    timestamp: new Date().toISOString(),
  })
  writeProbations(records)
}

/**
 * 给最近一条未结的该 skill 记录追加一次读数。窗口满 N 次时写 verdict。
 * 没有未结窗口 ⇒ `null`（不是抛错：调用方可能对任何 bench 结果都调一次）。
 */
export function settleProbation(skillName: string, score: number): ProbationRecord | null {
  const records = readProbations()
  let idx = -1
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!
    if (!r.noInstrument && r.skillName === skillName && r.verdict === undefined) {
      idx = i
      break
    }
  }
  if (idx < 0) return null

  const rec = records[idx]!
  const checks = [...rec.checks, score]
  const updated: ProbationRecord = { ...rec, checks }
  if (checks.length >= PROBATION_WINDOW) {
    const minEffect = probationMinEffect(rec.baselineScores, checks, rec.poolSize)
    updated.verdict = classifyDelta(mean(checks) - mean(rec.baselineScores), minEffect)
  }
  records[idx] = updated
  writeProbations(records)
  return updated
}

/** `/crsi stats` 的试用期段。空数组 = 没有试用期记录，不打任何行。 */
export function formatProbationLines(): string[] {
  const records = readProbations()
  if (records.length === 0) return []
  const lines = ['', '### 试用期（probation）', '']
  for (const r of records) {
    if (r.noInstrument) {
      lines.push(`- ${r.filePath}: no stochastic instrument for this merge`)
      continue
    }
    const base = mean(r.baselineScores).toFixed(1)
    if (r.verdict === undefined) {
      lines.push(
        `- ${r.skillName}: ${r.checks.length}/${PROBATION_WINDOW}（基线 ${base}）—— 观察中`,
      )
      continue
    }
    lines.push(`- ${r.skillName}: ${r.verdict}（基线 ${base}，${r.checks.length} 次重测）`)
    if (r.verdict === 'regressed') {
      // 只打印。破坏性 git 操作由人执行 —— 本模块不调用任何 git 命令。
      lines.push(`  - 建议回退：\`git revert ${r.commitHash}\``)
    }
  }
  return lines
}
