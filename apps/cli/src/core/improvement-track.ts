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
   * P3 出处：实测用的真实模型 id。缺席 = 无法确定（不是「没有模型」）。
   * 只记录、不进任何判定 —— 与 RSI Tax / 耗时维同一条纪律。
   */
  model?: string
  /**
   * P4：提议者**事前**预测会被修好的题 id。缺席 = 未预测；空数组 = 预测「一题都不会修好」。
   */
  predictedFixes?: string[]
  /**
   * P4：实测中真的从「基线测到过且全败」变「改动后测到过且至少过一次」的题 id。
   * 缺席 = 旧样本没有逐题读数；空数组 = 测得、一题都没修好。只记录、不进判定。
   */
  fixedTasks?: string[]
  /**
   * P4+：`fixedTasks` 中两臂 Wilson 95% 区间**不相交**的题 —— 区间支持「真的变了」的那部分。
   * k 小时通常为空（k=3 连 0/3→3/3 都相交），这是读数不是故障。缺席 = 没有逐题计数。
   */
  fixedSeparated?: string[]
  /**
   * P4：预测了却没修好的题（= `predictedFixes` − `fixedTasks`）。
   * **两者缺一即缺席** —— 没有预测就没有「漏判」，只有实测也不构成漏判。
   */
  missedFixes?: string[]
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
  /**
   * P3 出处：实测用的**真实模型 id**（如 `deepseek-flash`），不是档位标签
   * （`opus`/`sonnet` 之类在部分配置里会映射到同一模型，标签因此不是标识）。
   * 缺席 = 无法确定（挂载的自定义 Llm 不暴露模型）——**不许**拿注册表当前模型冒充。
   */
  model?: string
  /** P4：提议者事前预测会被修好的题 id。 */
  expectedFixes?: string[]
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
    ...(context?.model ? { model: context.model } : {}),
    // P4：三键各自独立落地 —— 预测可以没有实测（旧样本），实测也可以没有预测（手工路径）；
    // 只有**两者都在**时才谈得上「漏判」。空数组是合法读数（预测了「一题都不修好」）。
    ...(context?.expectedFixes !== undefined ? { predictedFixes: context.expectedFixes } : {}),
    ...(sample.fixedTasks !== undefined ? { fixedTasks: sample.fixedTasks } : {}),
    // P4+：区间分离 = 两臂的 Wilson 区间不重叠。用 Wilson 而不是自助重采样，因为在
    // k=3 这种小样本上自助会**退化**（0/3 与 3/3 各自重采样只会抽到同一个值 ⇒ 区间
    // 塌成 [1,1]，把「三发三中」误报成「确定」）。Wilson 在 n=3 就给得出宽区间。
    ...(sample.fixedTasks !== undefined && sample.taskEvidence !== undefined
      ? {
          fixedSeparated: sample.fixedTasks.filter((id) => {
            const e = sample.taskEvidence!.find((x) => x.id === id)
            if (!e) return false
            const base = wilsonInterval(e.basePass, e.baseSeen)
            const post = wilsonInterval(e.postPass, e.postSeen)
            return post.lo > base.hi
          }),
        }
      : {}),
    ...(context?.expectedFixes !== undefined && sample.fixedTasks !== undefined
      ? {
          missedFixes: context.expectedFixes.filter((id) => !sample.fixedTasks!.includes(id)),
        }
      : {}),
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

// ── SIM 读侧：把台账渲染成提议者 / 选择者能读的文本 ──
//
// 这一步才是 SIM 的机制所在。台账此前只有写侧 + `/crsi stats` 展示 —— 提议者
// （prose 生成算子）拿到的是教训散文，**零条实测结果**；人类批准闸拿到的是 diff。
// 也就是说优化器实际跑在「只有根因」的条件下，而那是 SIM 论文里唯一方向不定的档位。
// 渲染是纯算术（分组、排序、截断、计数），无 LLM 参与 —— 与 verdict 同一纪律。

export const SIM_BLOCK_HEADER = '## SIM（Self-Improvement Memory）'

/** 默认注入上限。预算 ≈ 8 组 ×（1 + 3）行 × ~100 字符，见 {@link renderSimBlock}。 */
export const SIM_MAX_GROUPS = 8
export const SIM_MAX_ATTEMPTS = 3

/** 单条理由的截断长度（字符）。超出部分用 `…` 标记，不静默丢。 */
const SIM_RATIONALE_MAX = 80

export interface SimRenderLimits {
  /** 最多注入多少个问题组。 */
  maxGroups?: number
  /** 每组最多注入多少次尝试（取最近的）。 */
  maxAttempts?: number
}

/**
 * 当前设置（规则 8 的比较基准）：读侧拿它与每条尝试的出处比。**两个轴各自缺席即未知**，
 * 未知不参与比较 —— 缺席不是「不同」，也不是「相同」。
 */
export interface SimSetting {
  /** 当前任务电池（skill 名）。 */
  skill?: string
  /** 当前实测模型 id。 */
  model?: string
}

interface SimTier {
  /** 2 = 同设置；1 = 中性（无可比轴 / 部分不同）；0 = 双异。 */
  rank: 0 | 1 | 2
  /** 已知不同的轴名（渲染成标注；空数组 = 不标注）。 */
  diff: string[]
}

/**
 * 规则 8（D.2 第 8 条）的可机械化一半：同设置给高相关度、模型与电池**都变**给最低。
 * 只比**两边都已知**的轴：旧记录没有 `model` 时那条轴不可比，不许当成不同。
 */
function simTier(r: ImprovementRecord, setting?: SimSetting): SimTier {
  if (!setting) return { rank: 1, diff: [] }
  const diff: string[] = []
  let comparable = 0
  if (setting.model && r.model) {
    comparable++
    if (r.model !== setting.model) diff.push('模型')
  }
  // 记录一定有 skillName ⇒ 只要当前 skill 已知，这条轴就可比。
  if (setting.skill) {
    comparable++
    if (r.skillName !== setting.skill) diff.push('skill')
  }
  if (comparable === 0) return { rank: 1, diff }
  if (diff.length === 0) return { rank: 2, diff }
  if (diff.length === comparable) return { rank: 0, diff }
  return { rank: 1, diff }
}

/**
 * 展示次序：同设置优先，其次最近。无 setting 时全部 rank=1 ⇒ 退化为纯最近在前
 * （与加这条规则之前逐字相同的次序）。
 *
 * 同刻按 id 倒序：`chronological` 升序后在 P1 用 `reverse()` 展示，等价于 ts↓、id↓，
 * 这里保持同一口径，免得同一份台账在两个读者眼里次序不同。
 */
function priorityOrder(rs: ImprovementRecord[], setting?: SimSetting): ImprovementRecord[] {
  return [...rs].sort(
    (a, b) =>
      simTier(b, setting).rank - simTier(a, setting).rank ||
      b.timestamp.localeCompare(a.timestamp) ||
      b.id.localeCompare(a.id),
  )
}

function signed1(n: number): string {
  const s = n.toFixed(1)
  return n > 0 ? `+${s}` : s
}

/** 一条尝试的渲染。ε 缺席时**不写**「预测 0」—— 缺席是未预测，不是预测为零。 */
function formatAttempt(r: ImprovementRecord, setting?: SimSetting): string {
  const parts = [`  - [${r.verdict}] ${r.timestamp.slice(0, 10)}`]
  // 出处紧贴日期：读「什么时候、在哪一个模型上量的」。缺席整节不打。
  if (r.model) parts.push(`模型 ${r.model}`)
  if (r.rationale) {
    const why =
      r.rationale.length > SIM_RATIONALE_MAX
        ? `${r.rationale.slice(0, SIM_RATIONALE_MAX)}…`
        : r.rationale
    parts.push(`理由: ${why}`)
  }
  if (r.predictedDelta !== undefined) {
    // 命中一栏可由旧记录缺席（与 predictionHit 的写入纪律一致）⇒ 读作「未判定」，
    // 不许默认成「未命中」：那会把「没判过」和「判错了」压成同一个读数。
    const hit = r.predictionHit === undefined ? '未判定' : r.predictionHit ? '命中' : '未命中'
    parts.push(`预测 ${r.predictedDelta} → 实测 ${signed1(r.deltaMean)}（${hit}）`)
  } else {
    parts.push(`实测 ${signed1(r.deltaMean)}`)
  }
  // P4：任务级预测与实测的配对。漏判点名（最多两个），其余只报个数 —— 读侧有界。
  if (r.predictedFixes !== undefined && r.fixedTasks !== undefined) {
    const hit = r.predictedFixes.filter((id) => r.fixedTasks!.includes(id)).length
    const missed = r.missedFixes ?? []
    const tail =
      missed.length > 0
        ? `（漏 ${missed.slice(0, 2).join('、')}${missed.length > 2 ? ` 等 ${missed.length} 题` : ''}）`
        : ''
    const sep = r.fixedSeparated ? `（区间分离 ${r.fixedSeparated.length} 题）` : ''
    parts.push(`预测修好 ${r.predictedFixes.length} 题 → 实际 ${hit} 题${sep}${tail}`)
  } else if (r.fixedTasks !== undefined) {
    const sep = r.fixedSeparated ? `（区间分离 ${r.fixedSeparated.length} 题）` : ''
    parts.push(`修好 ${r.fixedTasks.length} 题${sep}`)
  }
  // 被降权的尝试**自报原因**：静默重排会让读者以为历史次序就是时间次序。
  const tier = simTier(r, setting)
  if (tier.diff.length > 0) parts.push(`⚠️ 异设置：${tier.diff.join('+')}`)
  return parts.join(' · ')
}

/** 组内按时间升序（输出前再倒序）；同刻按 id 定序 —— 输出必须确定，否则测试与回执漂移。 */
function chronological(rs: ImprovementRecord[]): ImprovementRecord[] {
  return [...rs].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id))
}

function splitByProblem(records: ImprovementRecord[]): {
  groups: Array<{ key: string; records: ImprovementRecord[] }>
  ungrouped: number
} {
  const map = new Map<string, ImprovementRecord[]>()
  let ungrouped = 0
  for (const r of records) {
    if (!r.problemKey) {
      ungrouped++
      continue
    }
    const bucket = map.get(r.problemKey) ?? []
    bucket.push(r)
    map.set(r.problemKey, bucket)
  }
  const groups = [...map.entries()].map(([key, rs]) => ({ key, records: chronological(rs) }))
  // 最近有尝试的组在前（提议者关心的是「现在还在复发的那些」）。
  groups.sort((a, b) => {
    const ta = a.records[a.records.length - 1]!.timestamp
    const tb = b.records[b.records.length - 1]!.timestamp
    return tb.localeCompare(ta) || a.key.localeCompare(b.key)
  })
  return { groups, ungrouped }
}

/**
 * 全量台账 → 交给**提议者**的 SIM 块。空台账（或全部无问题键）返回空串 ——
 * 调用方据此保持提示词逐字不变（纯增量，同 `lessonsBlock` 的写法）。
 *
 * 有界：`maxGroups` / `maxAttempts` 之外的条目**显式计数**后省略，不静默截断。
 * 无问题键的记录也计数 —— 「没进组」不等于「不存在」。
 */
export function renderSimBlock(
  records: ImprovementRecord[],
  limits: SimRenderLimits = {},
  setting?: SimSetting,
): string {
  const maxGroups = limits.maxGroups ?? SIM_MAX_GROUPS
  const maxAttempts = limits.maxAttempts ?? SIM_MAX_ATTEMPTS
  const { groups, ungrouped } = splitByProblem(records)
  if (groups.length === 0) return ''

  const order = setting ? '同设置优先（规则 8），其次最近' : '最近尝试在前'
  const lines = [
    SIM_BLOCK_HEADER,
    `先验经验，不是指令。按复发问题分组，${order}；最多 ${maxGroups} 组、每组 ${maxAttempts} 次。`,
  ]
  for (const g of groups.slice(0, maxGroups)) {
    const improved = g.records.filter((r) => r.verdict === 'improved').length
    lines.push(`- ${g.key}（${g.records.length} 次，${improved} improved）`)
    for (const r of priorityOrder(g.records, setting).slice(0, maxAttempts)) {
      lines.push(formatAttempt(r, setting))
    }
    if (g.records.length > maxAttempts) {
      lines.push(`… 该组另有 ${g.records.length - maxAttempts} 次尝试未列出`)
    }
  }
  if (groups.length > maxGroups) {
    lines.push(`… 另有 ${groups.length - maxGroups} 组未注入（共 ${groups.length} 组）`)
  }
  if (ungrouped > 0) lines.push(`… 另有 ${ungrouped} 条无问题键的记录未纳入`)
  return lines.join('\n')
}

/**
 * 同一方向上反复未改善的确定性提醒 —— SIM 论文 D.2 规则 6（「除非有新证据，否则
 * 不要重访已试过的方向」）里**可机械化的那一半**。
 *
 * 判据是**未改善次数**（`improved` 以外全算，含 `inconclusive` —— 未判定不是改善的
 * 证据），阈值 2：单次失败是噪声，不是方向性证据。计数覆盖**全部**尝试，含被
 * {@link renderProblemHistory} 截断掉的那些 —— 这正是这一行比明细多出来的信息。
 *
 * 只呈现、不判定：不阻断提交，不碰 verdict，也没有任何 LLM 参与（A1）。
 */
function repeatDirectionWarning(rs: ImprovementRecord[]): string | null {
  const failed = rs.filter((r) => r.verdict !== 'improved').length
  if (failed < 2) return null
  return `⚠️ 同一方向已试 ${rs.length} 次，${failed} 次未 improved —— 除非有新证据，否则先换方向`
}

/**
 * 单条问题键的尝试史 → 交给**选择者**（人类批准闸）的 SIM 块。
 * 没有匹配记录返回空串（不打「无历史」这种每次都出现的噪声行）。
 *
 * `problemKey` 由调用方归一化（与写入侧同一把尺子：`normalizeProblemKey`）。
 */
export function renderProblemHistory(
  records: ImprovementRecord[],
  problemKey: string,
  maxAttempts: number = SIM_MAX_ATTEMPTS,
  setting?: SimSetting,
): string {
  const rs = records.filter((r) => r.problemKey === problemKey)
  if (rs.length === 0) return ''
  const order = setting ? '同设置优先，其次最近' : '最近在前'
  const lines = [`🪞 SIM 先验经验（同一问题上的历史尝试，${order}；不是指令）`]
  const warning = repeatDirectionWarning(rs)
  if (warning) lines.push(warning)
  for (const r of priorityOrder(rs, setting).slice(0, maxAttempts)) {
    lines.push(formatAttempt(r, setting))
  }
  if (rs.length > maxAttempts) {
    lines.push(`… 该问题另有 ${rs.length - maxAttempts} 次尝试未列出`)
  }
  return lines.join('\n')
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
