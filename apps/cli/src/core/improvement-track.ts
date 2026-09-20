// CRSI 改进轨：噪声自适应改进判定 + 台账 + pending verdict 闸。
// A1 不破：verdict / minEffect / 改进率全是确定性算术（均值/标准差/阈值/Wilson），无 LLM 裁判。
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { atomicWriteFileSync } from '../shared/atomic-write'
import type { SkillDeltaSample } from './task-performance'

export type ImprovementVerdict = 'improved' | 'regressed' | 'inconclusive'

export const MIN_EFFECT_FLOOR = 20
export const NOISE_K = 2
export const FALSE_POSITIVE_BASELINE = 0.05

export interface ImprovementReport {
  skillName: string
  changeSet: string[]
  causal: boolean
  baselineScores: number[]
  postScores: number[]
  deltaMean: number
  noise: number
  minEffect: number
  verdict: ImprovementVerdict
  /** ε：提交者事前写下的预期提升点数。缺席 = 该记录没有预登记。 */
  predictedDelta?: number
  /** 预测是否命中。与 predictedDelta 同时出现、同时缺席（JSON 序列化会丢掉 undefined 键）。 */
  predictionHit?: boolean
}

export interface ImprovementRecord extends ImprovementReport {
  id: string
  timestamp: string
}

// ── 纯函数 ──

export function computeMinEffect(noise: number): number {
  return Math.max(MIN_EFFECT_FLOOR, NOISE_K * noise)
}

export function classifyDelta(deltaMean: number, minEffect: number): ImprovementVerdict {
  if (deltaMean <= -minEffect) return 'regressed'
  if (deltaMean >= minEffect) return 'improved'
  return 'inconclusive'
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

export function buildImprovementReport(
  sample: SkillDeltaSample,
  changeSet: string[],
  predicted?: number,
): ImprovementReport {
  const deltaMean = mean(sample.postScores) - mean(sample.baselineScores)
  const noise = stdDev(sample.baselineScores)
  const minEffect = computeMinEffect(noise)
  const verdict = classifyDelta(deltaMean, minEffect)
  return {
    skillName: sample.skillName,
    changeSet,
    causal: changeSet.length === 1,
    baselineScores: sample.baselineScores,
    postScores: sample.postScores,
    deltaMean,
    noise,
    minEffect,
    verdict,
    // 两个字段同生同灭：缺席预测必须**键不存在**，而不是 predictionHit: false ——
    // 后者会让「我们没预测」被算进 predictionHitRate 的分母。
    ...(predicted !== undefined
      ? { predictedDelta: predicted, predictionHit: predictionHit(predicted, deltaMean) }
      : {}),
  }
}

/** Wilson score 区间（z 默认 1.96 = 95%）。n=0 → {0,0}。 */
export function wilsonInterval(
  improved: number,
  total: number,
  z = 1.96,
): { lo: number; hi: number } {
  if (total === 0) return { lo: 0, hi: 0 }
  const p = improved / total
  const n = total
  const denom = 1 + (z * z) / n
  const center = (p + (z * z) / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom
  return { lo: center - half, hi: center + half }
}

export function improvementRate(records: ImprovementRecord[]): {
  total: number
  improved: number
  rate: number
  lo: number
  hi: number
} {
  const total = records.length
  const improved = records.filter((r) => r.verdict === 'improved').length
  const { lo, hi } = wilsonInterval(improved, total)
  return { total, improved, rate: total === 0 ? 0 : improved / total, lo, hi }
}

/** 循环有效性：改进率 Wilson 95% CI 下界 > 假阳性基线（默认 5%）。 */
export function improvementSignalStrong(records: ImprovementRecord[]): boolean {
  const { lo } = improvementRate(records)
  return records.length > 0 && lo > FALSE_POSITIVE_BASELINE
}

/**
 * 预测命中：事前写下的点数被实际达到。缺席预测（undefined）不计入。
 *
 * 刻意**不叠加 `minEffect`** —— ε 是提交者自己写下的数，判据就是「达到没达到」；
 * 再套一层统计阈值会让两个数打架，且使「命中」不可复算。
 */
export function predictionHit(predicted: number | undefined, deltaMean: number): boolean {
  return predicted !== undefined && deltaMean >= predicted
}

/**
 * ε 命中率。分母 = **有预测的记录数**（判据取 `predictedDelta !== undefined`），
 * 复用既有 wilsonInterval。无预测的记录既不入分子也不入分母。
 */
export function predictionHitRate(records: ImprovementRecord[]): {
  total: number
  hits: number
  rate: number
  lo: number
  hi: number
} {
  const judged = records.filter((r) => r.predictedDelta !== undefined)
  const total = judged.length
  const hits = judged.filter((r) => r.predictionHit === true).length
  const { lo, hi } = wilsonInterval(hits, total)
  return { total, hits, rate: total === 0 ? 0 : hits / total, lo, hi }
}

// ── 台账 ──

export function improvementPath(): string {
  return join(homedir(), '.mipham', 'crsi', 'improvements.jsonl')
}

export function appendImprovement(record: ImprovementRecord): void {
  const file = improvementPath()
  mkdirSync(join(homedir(), '.mipham', 'crsi'), { recursive: true })
  // 原子激活（④）：整账本读-改-写 + temp 文件 rename（见 shared/atomic-write），读者要么见旧要么见新。
  // 非原子的 appendFileSync 写中途崩溃会留撕裂行，readImprovements 会 JSON.parse 抛错。
  const existing = readImprovements()
  existing.push(record)
  atomicWriteFileSync(file, existing.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

export function readImprovements(): ImprovementRecord[] {
  const file = improvementPath()
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ImprovementRecord]
      } catch {
        return [] // 残留撕裂/坏行跳过，不抛（原子激活的容错侧）
      }
    })
}

// ── pending verdict 闸（倒退才拦） ──
// 原子激活（④）：pending verdict 是「激活指针」，持久化为不可变 manifest + 原子替换
// （temp+rename，见 shared/atomic-write），替代易失内存变量（进程重启即丢、无 manifest）。

export function pendingVerdictPath(): string {
  return join(homedir(), '.mipham', 'crsi', 'pending-verdict.json')
}

export function setPendingVerdict(v: ImprovementVerdict | null): void {
  const file = pendingVerdictPath()
  if (v === null) {
    rmSync(file, { force: true }) // 原子清除（unlink 原子）
    return
  }
  mkdirSync(join(homedir(), '.mipham', 'crsi'), { recursive: true })
  atomicWriteFileSync(file, JSON.stringify({ verdict: v, timestamp: new Date().toISOString() }))
}

export function getPendingVerdict(): ImprovementVerdict | null {
  const file = pendingVerdictPath()
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { verdict: ImprovementVerdict }
    return parsed.verdict
  } catch {
    return null // manifest 损坏 → 视为无 pending（与旧 `?? 'inconclusive'` 的 fail-open 一致）
  }
}

export function shouldBlockApproval(v: ImprovementVerdict): boolean {
  return v === 'regressed'
}
