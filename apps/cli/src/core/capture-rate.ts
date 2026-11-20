/**
 * 捕获率：`(on − off) / (100 − off)` —— 自动改进捕获了「满分上界」的百分之几。
 *
 * 纯算术，无 LLM、无 I/O：题与样本由调用方给。设计约束见
 * `docs/superpowers/specs/2026-11-20-crsi-eval-governance-design.md` §4.2：
 *   - headroom `100 − off` 不为正的题 **剔除**（分母不许注水）；
 *   - 任一侧无合格样本的题 **配对剔除**（不拿半份样本凑数）；
 *   - 题全被剔除 ⇒ **没有率**（`null`），不是 0，也不是 1。
 */

export interface ArmValue {
  taskId: string
  /** 该题在该臂上的 0–100 读数；`null` = 没有合格样本。 */
  value: number | null
}

export interface CaptureInput {
  off: ArmValue[]
  on: ArmValue[]
  /** 组内题数 M（含被剔除的），用于报告 "over N of M tasks"。 */
  total: number
}

export interface CaptureResult {
  numerator: number
  denominator: number
  rate: number | null
  tasksUsed: number
  tasksTotal: number
  noHeadroom: string[]
  dropped: string[]
  ci: { lo: number; hi: number } | null
}

/** 每题每臂的 0–100 读数。合格样本不足 k 次 ⇒ `null`（配对剔除的一半）。 */
export function perTaskValue(
  results: { id: string; passed: boolean; truncated?: boolean; uncertain?: boolean }[],
  k: number,
): Map<string, number | null> {
  const acc = new Map<string, { pass: number; usable: number }>()
  for (const r of results) {
    const entry = acc.get(r.id) ?? { pass: 0, usable: 0 }
    if (!r.truncated && !r.uncertain) {
      entry.usable++
      if (r.passed) entry.pass++
    }
    acc.set(r.id, entry)
  }
  const out = new Map<string, number | null>()
  for (const [id, entry] of acc) {
    out.set(id, entry.usable === k ? (entry.pass / entry.usable) * 100 : null)
  }
  return out
}

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a += 0x6d2b79f5
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

export function computeCapture(
  input: CaptureInput,
  opts?: { resamples?: number; seed?: number },
): CaptureResult {
  const onById = new Map(input.on.map((v) => [v.taskId, v.value]))
  const noHeadroom: string[] = []
  const dropped: string[] = []
  const pairs: { off: number; on: number }[] = []

  for (const o of input.off) {
    const onValue = onById.get(o.taskId) ?? null
    if (o.value === null || onValue === null) {
      dropped.push(o.taskId)
      continue
    }
    if (100 - o.value <= 0) {
      noHeadroom.push(o.taskId)
      continue
    }
    pairs.push({ off: o.value, on: onValue })
  }

  let numerator = 0
  let denominator = 0
  for (const p of pairs) {
    numerator += p.on - p.off
    denominator += 100 - p.off
  }

  if (denominator === 0) {
    return {
      numerator,
      denominator,
      rate: null,
      tasksUsed: 0,
      tasksTotal: input.total,
      noHeadroom,
      dropped,
      ci: null,
    }
  }

  const rate = numerator / denominator
  const resamples = opts?.resamples ?? 1000
  const random = mulberry32(opts?.seed ?? 42)
  const rates: number[] = []
  for (let i = 0; i < resamples; i++) {
    let num = 0
    let den = 0
    for (let j = 0; j < pairs.length; j++) {
      const pick = pairs[Math.floor(random() * pairs.length)]!
      // 每次重采样内**重新判定 headroom**：off=100 的那题被抽到时不计。
      if (100 - pick.off <= 0) continue
      num += pick.on - pick.off
      den += 100 - pick.off
    }
    if (den > 0) rates.push(num / den)
  }

  let ci: { lo: number; hi: number } | null = null
  if (rates.length >= 2) {
    rates.sort((a, b) => a - b)
    ci = { lo: quantile(rates, 0.025), hi: quantile(rates, 0.975) }
  }

  return {
    numerator,
    denominator,
    rate,
    tasksUsed: pairs.length,
    tasksTotal: input.total,
    noHeadroom,
    dropped,
    ci,
  }
}
