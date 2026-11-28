import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  estimateCost,
  loadPriceBook,
  type PriceBook,
  type TokenBuckets,
} from '../../src/providers/pricing'

// `vitest.setup.ts` 把 homedir 全局 mock 到 `${tmpdir()}/mipham-test-home` ——
// 价格文件就落在那里的 `.mipham/pricing.json`。只删这一个文件：那个目录是
// 多个测试文件共用的 home，整目录 rm 会顺带删掉别的用例的记忆文件。
const PRICING_FILE = join(homedir(), '.mipham', 'pricing.json')

beforeEach(() => {
  mkdirSync(join(homedir(), '.mipham'), { recursive: true })
  rmSync(PRICING_FILE, { force: true })
})

afterEach(() => {
  rmSync(PRICING_FILE, { force: true })
})

const buckets = (overrides: Partial<TokenBuckets> = {}): TokenBuckets => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...overrides,
})

const book = (providers: PriceBook['providers']): PriceBook => ({ providers })

const FULL = book({
  demo: {
    'model-a': {
      currency: 'USD',
      inputPerM: 0.5,
      outputPerM: 2,
      cacheReadPerM: 0.05,
      cacheWritePerM: 0.6,
    },
  },
})

describe('estimateCost', () => {
  it('按四个桶分别计价并求和', () => {
    // 会让这条失败的改动：只算 input/output，或漏掉 /1e6 的换算。
    const result = estimateCost(
      FULL,
      'demo',
      'model-a',
      buckets({
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 2_000_000,
        cacheWriteTokens: 500_000,
      }),
    )

    // 1M×0.5 + 0.1M×2 + 2M×0.05 + 0.5M×0.6 = 0.5 + 0.2 + 0.1 + 0.3
    expect(result).toEqual({ kind: 'ok', amount: 1.1, currency: 'USD' })
  })

  it('没有该 provider/model 的条目 → no-price，不是 0', () => {
    expect(estimateCost(FULL, 'demo', 'model-b', buckets({ outputTokens: 10 }))).toEqual({
      kind: 'no-price',
    })
    expect(estimateCost(FULL, 'other', 'model-a', buckets({ outputTokens: 10 }))).toEqual({
      kind: 'no-price',
    })
  })

  it('用了缓存但没配缓存单价 → incomplete，并点名缺哪个', () => {
    // 「未配置」不等于「免费」：拿 inputPerM 顶替缓存价就是编数字。
    const partial = book({
      demo: {
        'model-a': { currency: 'USD', inputPerM: 1, outputPerM: 1 },
      },
    })

    expect(
      estimateCost(
        partial,
        'demo',
        'model-a',
        buckets({ cacheReadTokens: 5, cacheWriteTokens: 7 }),
      ),
    ).toEqual({ kind: 'incomplete', missing: ['cacheReadPerM', 'cacheWritePerM'] })
  })

  it('没用到缓存时，缺缓存单价不影响估算', () => {
    const partial = book({
      demo: {
        'model-a': { currency: 'USD', inputPerM: 1, outputPerM: 1 },
      },
    })

    expect(estimateCost(partial, 'demo', 'model-a', buckets({ inputTokens: 1_000_000 }))).toEqual({
      kind: 'ok',
      amount: 1,
      currency: 'USD',
    })
  })

  it('保留条目的 asOf，供显示时标明价格日期', () => {
    const dated = book({
      demo: {
        'model-a': {
          currency: 'CNY',
          inputPerM: 2,
          outputPerM: 4,
          asOf: '2026-11-01',
        },
      },
    })

    expect(estimateCost(dated, 'demo', 'model-a', buckets({ outputTokens: 1_000_000 }))).toEqual({
      kind: 'ok',
      amount: 4,
      currency: 'CNY',
      asOf: '2026-11-01',
    })
  })
})

describe('loadPriceBook', () => {
  const writePricing = (body: unknown) => {
    writeFileSync(PRICING_FILE, JSON.stringify(body))
  }

  it('文件不存在 → 空表且无错误（未配置不是故障）', () => {
    expect(loadPriceBook()).toEqual({ book: { providers: {} } })
  })

  it('读出合法的价格表', () => {
    writePricing({
      providers: { demo: { 'model-a': { currency: 'USD', inputPerM: 1, outputPerM: 2 } } },
    })

    const { book: loaded, error } = loadPriceBook()
    expect(error).toBeUndefined()
    expect(loaded.providers.demo?.['model-a']).toEqual({
      currency: 'USD',
      inputPerM: 1,
      outputPerM: 2,
    })
  })

  it('JSON 解析失败 → 带原因，而不是静默空表', () => {
    // 「文件写坏了」与「没配」是两件事；静默空表会把前者伪装成后者。
    writeFileSync(PRICING_FILE, '{ not json')

    const { error } = loadPriceBook()
    expect(error).toBeTruthy()
    expect(error).toContain('pricing.json')
  })

  it('条目形状不对 → 带原因（含非法币种/负数/缺字段）', () => {
    writePricing({
      providers: { demo: { 'model-a': { currency: 'EUR', inputPerM: 1, outputPerM: 2 } } },
    })
    expect(loadPriceBook().error).toBeTruthy()

    writePricing({
      providers: { demo: { 'model-a': { currency: 'USD', inputPerM: -1, outputPerM: 2 } } },
    })
    expect(loadPriceBook().error).toBeTruthy()

    writePricing({ providers: { demo: { 'model-a': { currency: 'USD', inputPerM: 1 } } } })
    expect(loadPriceBook().error).toBeTruthy()
  })
})
