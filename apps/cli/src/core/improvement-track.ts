// CRSI 改进轨：噪声自适应改进判定 + 台账 + pending verdict 闸。
// A1 不破：verdict / minEffect / 改进率全是确定性算术（均值/标准差/阈值/Wilson），无 LLM 裁判。
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { atomicWriteFileSync } from '../shared/atomic-write'
import type { SkillDeltaSample } from './task-performance'
import { miphamHome } from './paths.ts'

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
  /**
   * B2 代价维：与分数数组逐项对齐的前/后耗时。**只记录，不进任何门禁** ——
   * `verdict` / `deltaMean` / `minEffect` 一律不看这两个字段。
   * 缺席（而非空数组）= 该记录早于代价维落地，或该样本未记代价。
   */
  baselineDurations?: number[]
  postDurations?: number[]
  /**
   * 空模型闸（null-model ablation）：空程序也能通过的题数 / 总题数。
   * 两个字段同生同灭；缺席 = 旧记录或未测。
   */
  nullModelPassed?: number
  nullModelTotal?: number
  /** 闸的结论：failed = 有题空程序也能过 ⇒ `improved` 不可归因。 */
  nullModelGate?: 'passed' | 'failed'
  /**
   * SIM（Self-Improvement Memory）：这条编辑针对的**复发问题**分组键。
   * 同一 harness 问题被反复修时，记录才能按问题聚在一起，而不是按时间摊平。
   * 缺席 = 旧记录 / 该调用点没有失败信号。
   */
  problemKey?: string
  /** SIM：为什么做这次编辑（人可读的一句）。缺席语义同 problemKey。 */
  rationale?: string
  /**
   * RSI Tax：与分数数组逐项对齐的前/后测量 token。**只记录，不进任何门禁**
   * （与耗时维同一条纪律）。两个数组同生同灭；缺席 = 未测，不是免费。
   */
  baselineTokens?: number[]
  postTokens?: number[]
}

export interface ImprovementRecord extends ImprovementReport {
  id: string
  timestamp: string
}

// ── 纯函数 ──

/**
 * 噪声自适应最小效应量。`floor` 缺省为 `MIN_EFFECT_FLOOR` —— 既有调用点不变。
 * 试用期传自己的地板（两题步长），因为 4 题池上单题翻转只有 25 分，按 20 分地板判
 * 退化会让「一次恰好翻转」触发回退提示。
 */
export function computeMinEffect(noise: number, floor: number = MIN_EFFECT_FLOOR): number {
  return Math.max(floor, NOISE_K * noise)
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

export interface ImprovementContext {
  problemKey?: string
  rationale?: string
}

export function buildImprovementReport(
  sample: SkillDeltaSample,
  changeSet: string[],
  predicted?: number,
  context?: ImprovementContext,
): ImprovementReport {
  const deltaMean = mean(sample.postScores) - mean(sample.baselineScores)
  const noise = stdDev(sample.baselineScores)
  const minEffect = computeMinEffect(noise)
  const rawVerdict = classifyDelta(deltaMean, minEffect)

  // 空模型闸：只拦「假赢」。空程序能通过的题不测模型，故 improved 不可归因；
  // regressed 照旧 —— 它说的是「变差了」，与题是不是真空题无关。
  const nullModelMeasured =
    sample.nullModelPassed !== undefined && sample.nullModelTotal !== undefined
  const nullModelGate = nullModelMeasured
    ? sample.nullModelPassed! > 0
      ? ('failed' as const)
      : ('passed' as const)
    : undefined
  const verdict =
    nullModelGate === 'failed' && rawVerdict === 'improved' ? 'inconclusive' : rawVerdict

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
    // 两个字段同生同灭：缺席预测必须**键不存在**，而不是 predictionHit: false。
    // 理由**不是**「predictionHit: false 会被算进分母」—— 分母只认 `predictedDelta !== undefined`
    //（只写 `predictionHit: false` 而不写 `predictedDelta` 会被整条忽略）。真正的风险是**反过来的半条**：
    // 有 `predictedDelta` 而无 `predictionHit` ⇒ 该条进了分母，却永远不可能被算成命中
    //（分子只认 `predictionHit === true`），等于一条静默的「未命中」。
    ...(predicted !== undefined
      ? { predictedDelta: predicted, predictionHit: predictionHit(predicted, deltaMean) }
      : {}),
    // 代价维：**两条同生同灭**，与上面 ε 那条同理 —— 只写一半（有 baselineDurations
    // 而无 postDurations）会让「代价」这件事在记录里既非有也非无，读侧无从判断。
    ...(sample.baselineDurations !== undefined && sample.postDurations !== undefined
      ? { baselineDurations: sample.baselineDurations, postDurations: sample.postDurations }
      : {}),
    // 三个键同生同灭：只写一半会让「测过且通过」与「没测」在记录里同形。
    ...(nullModelMeasured
      ? {
          nullModelPassed: sample.nullModelPassed!,
          nullModelTotal: sample.nullModelTotal!,
          nullModelGate,
        }
      : {}),
    // SIM 两键各自独立：有理由而没有分组键（或反过来）都是有意义的状态，
    // 强行绑定只会让调用方为了写一个而编另一个。
    ...(context?.problemKey ? { problemKey: context.problemKey } : {}),
    ...(context?.rationale ? { rationale: context.rationale } : {}),
    // RSI Tax 与耗时维同一纪律：两条同生同灭，缺席即未测。
    ...(sample.baselineTokens !== undefined && sample.postTokens !== undefined
      ? { baselineTokens: sample.baselineTokens, postTokens: sample.postTokens }
      : {}),
  }
}

/** 问题分组键的规范化：去空白/大小写差异，截断到 120 字符（防止把整段散文当键）。 */
export function normalizeProblemKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120)
}

export interface ProblemGroup {
  key: string
  total: number
  improved: number
  meanDelta: number
}

/**
 * 按 `problemKey` 聚合台账（SIM 的读侧）。没有分组键的旧记录不进入任何组，
 * 它们仍在总台账里 —— 分组是视图，不是过滤器。
 */
export function groupImprovementsByProblem(records: ImprovementRecord[]): ProblemGroup[] {
  const groups = new Map<string, ImprovementRecord[]>()
  for (const r of records) {
    if (!r.problemKey) continue
    const bucket = groups.get(r.problemKey) ?? []
    bucket.push(r)
    groups.set(r.problemKey, bucket)
  }
  return [...groups.entries()]
    .map(([key, rs]) => ({
      key,
      total: rs.length,
      improved: rs.filter((r) => r.verdict === 'improved').length,
      meanDelta: mean(rs.map((r) => r.deltaMean)),
    }))
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key))
}

/** RSI Tax 的台账汇总：只统计带 token 量的记录。 */
export function measurementTaxSummary(records: ImprovementRecord[]): {
  records: number
  totalTokens: number
  meanTokens: number
} {
  const measured = records.filter(
    (r) => r.baselineTokens !== undefined && r.postTokens !== undefined,
  )
  const totalTokens = measured.reduce(
    (sum, r) => sum + [...r.baselineTokens!, ...r.postTokens!].reduce((a, b) => a + b, 0),
    0,
  )
  return {
    records: measured.length,
    totalTokens,
    meanTokens: measured.length > 0 ? Math.round(totalTokens / measured.length) : 0,
  }
}

/** RSI Tax 的只读展示；缺席 → null（调用方整行不打印）。 */
export function formatRsiTaxLine(report: ImprovementReport): string | null {
  const { baselineTokens: before_, postTokens: after_ } = report
  if (before_ === undefined || after_ === undefined) return null
  const before = before_.reduce((a, b) => a + b, 0)
  const after = after_.reduce((a, b) => a + b, 0)
  return `💸 验证 token（RSI Tax）: 前 ${before.toLocaleString()} → 后 ${after.toLocaleString()}（合计 ${(before + after).toLocaleString()}）`
}

/** 空模型闸失败时给出一行可见读数；闸通过则不出声（不占显示行）。 */
export function formatNullModelLine(report: ImprovementReport): string | null {
  if (report.nullModelGate !== 'failed' || report.nullModelPassed === undefined) return null
  const total = report.nullModelTotal ?? 0
  return `🕳️ 空模型闸: 空程序已通过 ${report.nullModelPassed}/${total} 题 —— 这些题测的不是模型，改进判定已降级`
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

/**
 * 代价维的只读展示（B2）：前/后均值一行。两个耗时数组缺席 → null，调用方据此整行不打印。
 *
 * **刻意不下结论**：倍数只是描述，不是判据。把「代价过高」变成 verdict 的一部分需要
 * 样本量支撑，而当前 k 默认 3、`minEffect` 已经要 `max(20, 2×噪声)` —— 再塞一个维度
 * 只会把统计问题变得更糟。所以这里只回答「花了多少」，不回答「值不值」。
 *
 * 基线均值为 0 时**不给倍数**：那个比值是 ∞（或 0/0 的 NaN），打出来是假读数。
 */
export function formatCostLine(report: ImprovementReport): string | null {
  const { baselineDurations: before_, postDurations: after_ } = report
  if (before_ === undefined || after_ === undefined) return null
  const before = Math.round(mean(before_))
  const after = Math.round(mean(after_))
  const line = `⏱️ 代价: 均值 ${before}ms → ${after}ms`
  return before > 0 ? `${line}（×${(after / before).toFixed(1)}）` : line
}

// ── 台账 ──

export function improvementPath(): string {
  return miphamHome('crsi', 'improvements.jsonl')
}

export function appendImprovement(record: ImprovementRecord): void {
  const file = improvementPath()
  mkdirSync(miphamHome('crsi'), { recursive: true })
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
  return miphamHome('crsi', 'pending-verdict.json')
}

export function setPendingVerdict(v: ImprovementVerdict | null): void {
  const file = pendingVerdictPath()
  if (v === null) {
    rmSync(file, { force: true }) // 原子清除（unlink 原子）
    return
  }
  mkdirSync(miphamHome('crsi'), { recursive: true })
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
