/**
 * 单价表 —— 把会话的四个计费 token 桶换算成钱。
 *
 * **本模块不内置任何单价。** 单价随供应商、套餐、网关和折扣漂移，写死在仓库里
 * 就会在每一次调价后静默说谎；而「估算费用」最容易犯的错，正是把编出来的数字
 * 说得像账单。故单价由用户在自己的 `~/.mipham/pricing.json` 里声明，本模块只做
 * 读取、校验与算术；没有对应条目时回答 `'no-price'`，绝不猜。
 *
 * 文件形状（providerId → modelId → 单价）：
 *
 * ```json
 * {
 *   "providers": {
 *     "deepseek": {
 *       "deepseek-flash": {
 *         "currency": "USD",
 *         "inputPerM": 0.28,
 *         "outputPerM": 0.42,
 *         "cacheReadPerM": 0.028,
 *         "cacheWritePerM": 0.35,
 *         "asOf": "2026-11-01",
 *         "source": "https://…"
 *       }
 *     }
 *   }
 * }
 * ```
 */

import { readFileSync } from 'node:fs'
import { miphamHome } from '../core/paths'

export interface PriceEntry {
  /** 计价币种。不做汇率换算 —— 混币种时由显示层原样标注。 */
  currency: 'USD' | 'CNY'
  /** 每 1M 未缓存输入 token 的价格。 */
  inputPerM: number
  /** 每 1M 输出 token 的价格。 */
  outputPerM: number
  /** 每 1M 缓存读 token 的价格。用到缓存却缺这项 ⇒ 无法估算，不是按 0 算。 */
  cacheReadPerM?: number
  /** 每 1M 缓存写 token 的价格。同上。 */
  cacheWritePerM?: number
  /** 这些单价取自哪一天（ISO 日期），显示时原样带出。 */
  asOf?: string
  /** 单价来源（URL/说明），留给人工复核。 */
  source?: string
}

export interface PriceBook {
  providers: Record<string, Record<string, PriceEntry>>
}

export interface PriceBookLoad {
  book: PriceBook
  /** 文件存在但读不出/解析失败/校验不过时的原因；undefined = 没配置或配置正常。 */
  error?: string
}

export interface TokenBuckets {
  /** 未缓存输入。 */
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export type CostResult =
  | { kind: 'ok'; amount: number; currency: PriceEntry['currency']; asOf?: string }
  /** 没有该 provider/model 的条目。 */
  | { kind: 'no-price' }
  /** 用到了某个桶，但条目里没有它的单价 —— 缺哪项报哪项。 */
  | { kind: 'incomplete'; missing: string[] }

const EMPTY: PriceBook = { providers: {} }

const isFiniteNonNegative = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0

/**
 * 读用户价格表。没有文件是**正常状态**（未配置），不是错误；文件坏了才是错误，
 * 且必须与「未配置」区分开 —— 两者都会得到空表，但一个要告诉用户去修。
 */
export function loadPriceBook(filePath = miphamHome('pricing.json')): PriceBookLoad {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { book: EMPTY }
    return { book: EMPTY, error: `${filePath}: ${(err as Error).message}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { book: EMPTY, error: `${filePath}: ${(err as Error).message}` }
  }

  const problem = validate(parsed)
  if (problem) return { book: EMPTY, error: `${filePath}: ${problem}` }
  return { book: parsed as PriceBook }
}

/** 校验整份文件；返回第一处问题（带路径），没有则 undefined。 */
function validate(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return '根节点必须是对象'
  const providers = (value as { providers?: unknown }).providers
  if (typeof providers !== 'object' || providers === null) return '缺少 providers 对象'

  for (const [providerId, models] of Object.entries(providers as Record<string, unknown>)) {
    if (typeof models !== 'object' || models === null) return `providers.${providerId} 必须是对象`
    for (const [modelId, entry] of Object.entries(models as Record<string, unknown>)) {
      const path = `providers.${providerId}.${modelId}`
      if (typeof entry !== 'object' || entry === null) return `${path} 必须是对象`
      const e = entry as Record<string, unknown>
      if (e.currency !== 'USD' && e.currency !== 'CNY') return `${path}.currency 必须是 USD 或 CNY`
      if (!isFiniteNonNegative(e.inputPerM)) return `${path}.inputPerM 必须是 ≥0 的数字`
      if (!isFiniteNonNegative(e.outputPerM)) return `${path}.outputPerM 必须是 ≥0 的数字`
      if (e.cacheReadPerM !== undefined && !isFiniteNonNegative(e.cacheReadPerM))
        return `${path}.cacheReadPerM 必须是 ≥0 的数字`
      if (e.cacheWritePerM !== undefined && !isFiniteNonNegative(e.cacheWritePerM))
        return `${path}.cacheWritePerM 必须是 ≥0 的数字`
      if (e.asOf !== undefined && typeof e.asOf !== 'string') return `${path}.asOf 必须是字符串`
      if (e.source !== undefined && typeof e.source !== 'string')
        return `${path}.source 必须是字符串`
    }
  }
  return undefined
}

/**
 * 按四个桶分别计价并求和。
 *
 * 用到缓存却没有缓存单价时返回 `'incomplete'` 而不是拿输入价顶替 —— 顶替出来的
 * 「估算」与真实账单的偏差正好落在缓存命中最多的会话上，而那正是缓存价存在的理由。
 */
export function estimateCost(
  book: PriceBook,
  providerId: string,
  modelId: string,
  usage: TokenBuckets,
): CostResult {
  const entry = book.providers[providerId]?.[modelId]
  if (!entry) return { kind: 'no-price' }

  const missing: string[] = []
  if (usage.cacheReadTokens > 0 && entry.cacheReadPerM === undefined) missing.push('cacheReadPerM')
  if (usage.cacheWriteTokens > 0 && entry.cacheWritePerM === undefined)
    missing.push('cacheWritePerM')
  if (missing.length > 0) return { kind: 'incomplete', missing }

  const raw =
    (usage.inputTokens / 1_000_000) * entry.inputPerM +
    (usage.outputTokens / 1_000_000) * entry.outputPerM +
    (usage.cacheReadTokens / 1_000_000) * (entry.cacheReadPerM ?? 0) +
    (usage.cacheWriteTokens / 1_000_000) * (entry.cacheWritePerM ?? 0)
  // 1e-9 的粒度（十亿分之一货币单位）足以覆盖最便宜的 token 价，同时把浮点尾巴
  // 挡在显示层之外 —— 否则 0.5+0.2+0.1+0.3 会以 1.0999999999999999 出现在用户面前。
  const amount = Math.round(raw * 1e9) / 1e9

  return {
    kind: 'ok',
    amount,
    currency: entry.currency,
    ...(entry.asOf !== undefined ? { asOf: entry.asOf } : {}),
  }
}
