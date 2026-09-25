/**
 * 状态文件**读侧**的族守卫 —— `state-write-integrity.test.ts` 的姊妹件。
 *
 * 写侧那一族的形状是「非原子写 + 读侧把读不动兜成空」；写成 `atomicWriteFileSync` 之后
 * 崩溃不再赔上全部 —— 但**读侧那一半没修**：`JSON.parse(readFileSync(...))` 的结果被
 * **直接当声明类型用**，形状不验。
 *
 * 危险的正是「**合法 JSON、错的形状**」这一格 —— 它不抛，所以既没有 `catch` 兜、也没有
 * 别的东西会说话，于是垃圾一路走到消费者手里：
 *   - `DreamEngine.getDreamHistory()` 返回一个对象，调用方 `.length` 是 `undefined`、
 *     `.slice` 直接 TypeError（`ui/commands.ts:1819-1823`）；
 *   - `ErrorSignatureDB` / `EffectivenessTracker` 把 `["x"]` 收进集合，`sig.id` 是
 *     `undefined`，于是 map 里躺着一个没有 id 的成员；
 *   - `MemoryManager` 的链接表把字符串当数组迭代 ⇒ `new Set("bc")` 是 `{'b','c'}`，
 *     一条链接被**按字符拆成两条**。
 *
 * 为什么值得一份守卫而不是一次清扫：这一族**已经复发过**（同批清扫掉 21 个写侧成员，
 * 读侧漏在外面），而且漏在外面的原因不是疏忽 —— 是**没有任何东西会在新成员出现时变红**。
 * 清扫能修当天的成员，修不了复发。
 *
 * 判据是**行为式**的，不扫描源码：往真 store 路径写一份毒化负载，经**真加载器**读回来，
 * 断言没有垃圾逃逸。静态扫描分不出「`as` 断言」与「形状门控」，行为式可以。
 *
 * **每个成员都必须同时有良构对照**（正向）：没有它，畸形那半全绿可能只是因为探针压根
 * 没读到那个文件（比如路径写错、构造器不再调 load）。正向对照证明**探针真的在读这个
 * 对象** —— 见 `mipham-code` 的「零命中必配正对照」教训。
 *
 * 下面 `CONTROL` 那一格是**判据自检**：一个裸读的本地对照实现，必须被判为「不干净」。
 * 恒绿的判据是仪式，不是检查。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DreamEngine } from '../../src/core/dream-engine.js'
import { ErrorSignatureDB } from '../../src/core/error-signature-db.js'
import { EffectivenessTracker } from '../../src/agent/effectiveness-tracker.js'
import { ExperienceRuleEngine } from '../../src/core/rule-engine.js'

/**
 * 成员定义。`observe` 一律走**公开 API**（不碰私有字段）—— 私有字段的形状是实现的
 * 自由，公开 API 的形状才是承诺。
 */
interface Member {
  name: string
  store: string
  /** 良构负载：必须能被读出来（证明探针真的读到了这个 store）。 */
  good: unknown
  /** 畸形负载：合法 JSON、错的形状。必须不吐出垃圾。 */
  bad: unknown
  observe: (dir: string) => unknown
  /** 良构时：观察到的东西确实来自文件，且形状干净。 */
  assertGood: (observed: unknown) => void
  /** 畸形时：不吐垃圾（空、或缺省值，而不是把负载原样端出来）。 */
  assertBad: (observed: unknown) => void
}

const isUsableRule = (r: unknown): boolean => {
  const rule = r as { id?: unknown; match?: unknown; fix?: unknown }
  return (
    !!rule &&
    typeof rule === 'object' &&
    typeof rule.id === 'string' &&
    typeof rule.match === 'function' &&
    typeof rule.fix === 'function'
  )
}

const MEMBERS: Member[] = [
  {
    name: 'DreamEngine.getDreamHistory',
    store: 'dream-log.json',
    good: [{ timestamp: '2026-09-25T00:00:00.000Z', actions: [] }],
    bad: { notAnArray: true },
    observe: (dir) => new DreamEngine(dir).getDreamHistory(),
    assertGood: (o) => {
      expect(Array.isArray(o)).toBe(true)
      expect((o as unknown[]).length).toBe(1)
    },
    assertBad: (o) => {
      expect(Array.isArray(o)).toBe(true)
      expect((o as unknown[]).length).toBe(0)
    },
  },
  {
    name: 'ErrorSignatureDB.getActive',
    store: 'error-signatures.json',
    good: [{ id: 'sig-good', signature: 'boom', count: 1 }],
    bad: ['not-an-object'],
    observe: (dir) => new ErrorSignatureDB(dir).getActive(),
    assertGood: (o) => {
      const arr = o as Array<{ id?: string }>
      expect(arr.some((s) => s.id === 'sig-good')).toBe(true)
    },
    assertBad: (o) => {
      const arr = o as Array<{ id?: unknown }>
      expect(arr.every((s) => !!s && typeof s === 'object' && typeof s.id === 'string')).toBe(true)
    },
  },
  {
    name: 'EffectivenessTracker.allRules',
    store: 'effectiveness.json',
    good: { 'rule-good': { ruleId: 'rule-good', status: 'active' } },
    bad: { '0': 'not-an-object' },
    observe: (dir) => {
      // 构造器刻意不 load（由调用方决定何时读盘）—— 探针必须自己触发，否则测的是空表。
      const tracker = new EffectivenessTracker(dir)
      tracker.load()
      return tracker.allRules
    },
    assertGood: (o) => {
      const arr = o as Array<{ ruleId?: string }>
      expect(arr.some((r) => r.ruleId === 'rule-good')).toBe(true)
    },
    assertBad: (o) => {
      const arr = o as Array<{ ruleId?: unknown }>
      // 键名不是规则：`Object.entries({"0":"x"})` 会造出一条 ruleId 为 undefined 的记录。
      expect(arr.every((r) => !!r && typeof r === 'object' && typeof r.ruleId === 'string')).toBe(
        true,
      )
    },
  },
  {
    name: 'ExperienceRuleEngine.getActiveRules',
    store: 'rules.json',
    // ⚠️ 这一格没有真正的正向对照，**这个缺席本身就是发现**：`ToolRule.match`/`fix` 是函数，
    // `JSON.stringify` 必然丢，所以 `persist()` 写出去的形状里**不可能**载回一条可用的规则。
    // 「良构负载」在这里只能是内置规则在场（证明构造器起了），文件确被读到由**负向那格变红**
    // 证明 —— 载入项只可能来自文件，故红只可能来自读了文件。
    good: [],
    // 真形状：`enabled:true`（否则会被 getActiveRules 先滤掉，测不到）但没有 match/fix ——
    // 这正是 `persist()` 今天写出去的东西。
    bad: [{ id: 'rule-persisted', toolName: 'Bash', category: 'timeout', enabled: true }],
    observe: (dir) => new ExperienceRuleEngine(dir).getActiveRules(),
    assertGood: (o) => {
      expect((o as unknown[]).length).toBeGreaterThan(0)
    },
    assertBad: (o) => {
      expect((o as unknown[]).every(isUsableRule)).toBe(true)
    },
  },
]

describe('读侧不验形 —— 族守卫', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'read-side-shape-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  for (const m of MEMBERS) {
    describe(m.name, () => {
      it('良构负载读得出来（正向对照：证明探针真的在读这个 store）', () => {
        writeFileSync(join(dir, m.store), JSON.stringify(m.good), 'utf-8')
        m.assertGood(m.observe(dir))
      })

      it('畸形负载不吐垃圾（合法 JSON、错的形状）', () => {
        writeFileSync(join(dir, m.store), JSON.stringify(m.bad), 'utf-8')
        m.assertBad(m.observe(dir))
      })
    })
  }

  it('判据自检：裸读的对照实现必须被判为不干净（否则上面全是仪式）', () => {
    // 一个**故意**不设门的读法，形状与清扫前那 21 个写侧成员一模一样。
    const naive = (raw: string): unknown => JSON.parse(raw)
    writeFileSync(join(dir, 'dream-log.json'), JSON.stringify({ notAnArray: true }), 'utf-8')
    const observed = naive(JSON.stringify({ notAnArray: true }))
    // 这条断言就是「畸形那半」用的判据：它必须在这个对象上红。
    expect(() => {
      expect(Array.isArray(observed)).toBe(true)
    }).toThrow()
  })
})
