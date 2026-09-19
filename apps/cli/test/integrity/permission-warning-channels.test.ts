/**
 * 权限告警的**两条通道**必须成对出现。
 *
 * 这是本仓库第四次踩同一个形状（「定义在那儿，施加点没接上」）的变体：**能力接了一条
 * 入口、另一条没接**。前三次分别是 `core/rules-loader.ts`（`setRulesLoader` 零调用
 * 点）、工具计数（主漏斗 `engine.ts` 接了、旁路 `agent/sub-agent.ts` 没接）、以及
 * `daemon-capability-parity.test.ts` 开头列的那一串（telegram / wecom / dingtalk /
 * allow-deny / permissionRestrictions / contextWindow 每一个都是独立一次提交）。
 *
 * 本文件守的是 P1 的修复本身：写错的 `permissionRestrictions` 会**静默失效**
 * （fail-open），所以它必须像写错的规则那样被念出来。念的办法是在两个入口各打一遍
 * `getInvalidRules()` 那圈 stderr —— 只接其中一个入口，另一个入口上的用户就依旧什么
 * 都看不到，而这个缺陷**在单入口的测试里完全看不见**（两处循环都测得到，漏接的那处
 * 测不到）。故这里断的是**文件集合之间的包含关系**，不是某一行的内容：
 *
 *   凡是调用了 `.getInvalidRules()` 的生产文件，就必须也调用 `.getInvalidRestrictions()`。
 *
 * 反方向不断（只念限制不念规则的文件不会被判红）—— 本轮修的是「限制没被念出来」，
 * 不是「规则没被念出来」，多断一条只会在将来制造假红。
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 同 `daemon-capability-parity.test.ts`：只读 `apps/cli/` 之内，锚定包目录即可。 */
const CLI_DIR = join(import.meta.dirname, '..', '..')

/** 生产源码全集（`src/` 下的 `.ts` / `.tsx`）。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(path))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(path)
  }
  return out
}

const CALL_RULES = /\.getInvalidRules\(\)/
const CALL_RESTRICTIONS = /\.getInvalidRestrictions\(\)/

/** 源文件路径 → 相对 `apps/cli/` 的斜杠路径（断言里可读）。 */
const rel = (path: string): string =>
  path
    .slice(CLI_DIR.length + 1)
    .split('\\')
    .join('/')

const FILES = sourceFiles(join(CLI_DIR, 'src'))
const RULE_CALLERS = FILES.filter((p) => CALL_RULES.test(readFileSync(p, 'utf8'))).map(rel)
const RESTRICTION_CALLERS = FILES.filter((p) =>
  CALL_RESTRICTIONS.test(readFileSync(p, 'utf8')),
).map(rel)

describe('权限告警的两条通道成对出现', () => {
  it('正对照：规则通道确实扫到了入口（否则下面的包含关系是空集上的空话）', () => {
    // 两个入口是 `src/index.tsx`（交互式 CLI）与 `src/daemon/server.ts`（daemon）。
    // 这条同时是「扫描读到了真内容」的证明 —— 数目录错了、后缀猜错了，这里就红。
    expect(RULE_CALLERS).toEqual(['src/daemon/server.ts', 'src/index.tsx'])
  })

  it('凡是念规则告警的入口，也必须念限制告警', () => {
    const missing = RULE_CALLERS.filter((p) => !RESTRICTION_CALLERS.includes(p))
    expect(missing).toEqual([])
  })
})
