/**
 * 分类器台账 —— 「`auto` 档批过什么」必须留得下痕迹。
 *
 * 这一条守的是设计文档 §3.7 / 风险 8：子代理与后台**无人值守**，而 `sub-agent.ts` 的闸门
 * 只有**拒绝**的通知路径，**放行是无声的**。所以 `source: 'classifier'` 这个东西在拒绝这
 * 一支被两个闸门读走，在放行那一支被丢掉 —— 没有会话日志事件、没有 metrics、没有 hook。
 * 台账就是为了消掉这个无声，`permission-audit.ts` 文件头有完整论证。
 *
 * **本文件断的是「接线」而不是「模块能不能写文件」** —— 后者只是最低限度。真正会静默腐烂
 * 的是**接线**：模块写得再对、单测再全，`resolveApproval` 里那句调用被删掉照样全绿
 * （`rules-loader.ts` 与 `index.tsx` 的 `setClassifier` 都是先例）。所以下面每一组判据都是
 * 走**真实的 `resolveApproval`** 再回头读盘上的文件，而不是直接调 `recordClassifierRuling`。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '../../src/shared'
import { PermissionSystem } from '../../src/core/permission'
import type { PermissionClassifier } from '../../src/core/permission-classifier'
import {
  permissionAuditPath,
  readClassifierRulings,
  recordClassifierRuling,
} from '../../src/core/permission-audit'

// 文件级 home 隔离（`improvement-track.test.ts` / `eval-harness.test.ts` 同形）：
// 全局 `vitest.setup.ts` 已经把 homedir 指到 tmpdir，这里再指到一个**本文件专用**的
// 子目录，免得与别的测试文件共用同一份台账。可写可变（`fakeHome`）是为了让「写不进去」
// 那条能真的失败 —— 一个不能失败的失败用例是仪式。
const TEST_HOME = `${tmpdir()}/mipham-test-permission-audit`
let fakeHome = TEST_HOME

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => fakeHome }
})

function clearLedger(): void {
  rmSync(join(TEST_HOME, '.mipham'), { recursive: true, force: true })
}

// ── Helpers ──

function makeTool(
  name: string,
  permission: ToolDefinition['permission'] = 'self',
  category: ToolDefinition['category'] = 'file',
): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    category,
    permission,
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ success: true, content: '' }),
  }
}

/**
 * 一律放行的分类器；`asked.n` 记下被问过几次（「问了没有」是契约的一半）。
 *
 * `asked` 是**对象**不是 getter —— getter 一被解构就求值成快照，于是「问了 0 次」的断言
 * 在分类器明明被问过之后**照样绿**，成了不能失败的检查。
 */
function alwaysAllow(): { classifier: PermissionClassifier; asked: { n: number } } {
  const asked = { n: 0 }
  return {
    asked,
    classifier: {
      version: 'test',
      classify: async () => {
        asked.n++
        return { allow: true, reason: '只读的列表命令' }
      },
    },
  }
}

/** 固定裁决的分类器。 */
function stubClassifier(verdict: {
  allow: boolean
  reason?: string
  retryable?: boolean
}): PermissionClassifier {
  return { version: 'test', classify: async () => verdict }
}

/** 静态链会判 `ask` 的一对（`default` 档下的 Bash，声明 `permission: 'ask'`）。 */
const bash = (): ToolDefinition => makeTool('Bash', 'ask', 'exec')
const BASH_INPUT = { command: 'pnpm test' }

function autoWith(classifier: PermissionClassifier): PermissionSystem {
  const ps = new PermissionSystem('auto')
  ps.setClassifier(classifier)
  return ps
}

beforeEach(clearLedger)
afterEach(clearLedger)

describe('permission-audit — 台账本身', () => {
  it('写一行、读回来：字段齐全，未给的键**不出现**（不是写成 null）', () => {
    recordClassifierRuling({
      mode: 'auto',
      tool: 'Bash',
      verdict: 'allow',
      level: 'bypass',
      reason: '只读命令',
    })

    const rows = readClassifierRulings()

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      mode: 'auto',
      tool: 'Bash',
      verdict: 'allow',
      level: 'bypass',
      reason: '只读命令',
    })
    expect(typeof rows[0]!.at).toBe('string')
    // 「缺省不写该键」是承重的：读取侧按 `'retryable' in row` 判「引擎故障 / 策略拒绝」
    // 会读错一个**写着 undefined 的键**。JSON.stringify 丢 undefined，故本条钉住它。
    expect(Object.keys(rows[0]!)).not.toContain('retryable')
    expect(Object.keys(rows[0]!)).not.toContain('denialReason')
  })

  it('文件不存在 ⇒ 空数组，而不是抛', () => {
    expect(existsSync(permissionAuditPath())).toBe(false)
    expect(readClassifierRulings()).toEqual([])
  })

  it('撕裂行只跳过那一行 —— 半行 JSON 不能让整份台账报废', () => {
    recordClassifierRuling({ mode: 'auto', tool: 'Read', verdict: 'allow', level: 'bypass' })
    writeFileSync(permissionAuditPath(), '{"at":"半行被截', { flag: 'a' })

    const rows = readClassifierRulings()

    expect(rows).toHaveLength(1)
    expect(rows[0]!.tool).toBe('Read')
  })

  it('写不进去：不抛（可用性优先），但**不能无声** —— stderr 说一次，之后不再重复', () => {
    const spied = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    // 让 mkdirSync 必然失败：父路径是一个**文件**（/dev/null）而不是目录 ⇒ ENOTDIR。
    fakeHome = '/dev/null'

    try {
      expect(() =>
        recordClassifierRuling({ mode: 'auto', tool: 'Bash', verdict: 'allow', level: 'bypass' }),
      ).not.toThrow()
      expect(() =>
        recordClassifierRuling({ mode: 'auto', tool: 'Bash', verdict: 'allow', level: 'bypass' }),
      ).not.toThrow()

      expect(spied).toHaveBeenCalledTimes(1)
      const msg = String(spied.mock.calls[0]![0])
      expect(msg).toContain('分类器台账写不进去')
    } finally {
      fakeHome = TEST_HOME
      spied.mockRestore()
    }
  })
})

describe('permission-audit — 接线在 resolveApproval 里（不是挂在闸门上）', () => {
  it('分类器放行 ⇒ 恰好一条 allow 记录，且带工具名与理由', async () => {
    const { classifier, asked } = alwaysAllow()
    const ps = autoWith(classifier)

    const decision = await ps.resolveApproval(bash(), BASH_INPUT)

    expect(decision.level).toBe('bypass')
    expect(asked.n).toBe(1)
    const rows = readClassifierRulings()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      mode: 'auto',
      tool: 'Bash',
      verdict: 'allow',
      level: 'bypass',
      reason: '只读的列表命令',
    })
  })

  it('策略拒绝 ⇒ 一条 deny 记录，denialReason 是 classifier-deny，且**不带** retryable', async () => {
    const ps = autoWith(stubClassifier({ allow: false, reason: '写入 .env' }))

    await ps.resolveApproval(bash(), BASH_INPUT)

    const rows = readClassifierRulings()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tool: 'Bash',
      verdict: 'deny',
      level: 'ask',
      denialReason: 'classifier-deny',
      reason: '写入 .env',
    })
    expect(Object.keys(rows[0]!)).not.toContain('retryable')
  })

  it('引擎故障被拿住 ⇒ retryable 落在记录里（「不是策略决定」这件事本身要可审计）', async () => {
    const ps = autoWith(stubClassifier({ allow: false, retryable: true }))

    await ps.resolveApproval(bash(), BASH_INPUT)

    expect(readClassifierRulings()[0]).toMatchObject({ verdict: 'deny', retryable: true })
  })

  it('组织级上限封顶：分类器同意、上限否决 ⇒ verdict=allow 与 level=ask 并存', async () => {
    const ps = autoWith(stubClassifier({ allow: true, reason: '看着无害' }))
    // 上限必须是 `'auto'` 而不是更紧的档：`setRestrictions` 会**重钳当前档位**，
    // 封到 `'plan'` 时 `this.mode` 本身就是 `plan` 了，分类器根本不被咨询（那是另一条路径）。
    // 封到 `'auto'` 才是「档位仍是 auto、放行被上限否决」这一支。
    ps.setRestrictions({ maxAllowedMode: 'auto' })

    const decision = await ps.resolveApproval(bash(), BASH_INPUT)

    // 先把这一支的行为钉住：放行经 `allowRuleDecision()` 重推导 ⇒ 被上限压回 ask。
    expect(decision).toMatchObject({ source: 'classifier', level: 'ask' })
    // 台账里两个字段必须**同时**在：只看 verdict 会读成「放行了」，只看 level 会读成
    // 「分类器拒绝了」—— 两种单字段读法都是错的，这正是要记两个字段的原因。
    expect(readClassifierRulings()[0]).toMatchObject({ verdict: 'allow', level: 'ask' })
  })

  // ── 反向：不落账的那些路径。没有这一组，「记多了」与「记对了」不可区分 ──

  it('静态链已放行的调用不落账 —— 台账只记**分类器裁决**，不问它就不该有行', async () => {
    const ps = new PermissionSystem('bypassPermissions')
    const { classifier, asked } = alwaysAllow()
    ps.setClassifier(classifier)

    const decision = await ps.resolveApproval(bash(), BASH_INPUT)

    expect(decision).toMatchObject({ level: 'bypass', source: 'static' })
    expect(asked.n).toBe(0)
    expect(readClassifierRulings()).toEqual([])
  })

  it('分类器**不可介入**的 ask（组织 deny 规则）不落账', async () => {
    const ps = autoWith(stubClassifier({ allow: true }))
    ps.deny('Bash')

    const decision = await ps.resolveApproval(bash(), BASH_INPUT)

    expect(decision).toMatchObject({ level: 'ask', source: 'static', denialReason: 'deny-rule' })
    expect(readClassifierRulings()).toEqual([])
  })

  it('缓存命中不落账：一行 = **一条裁决**，不是一次执行（分类器那时根本没被问到）', async () => {
    const { classifier, asked } = alwaysAllow()
    const ps = autoWith(classifier)

    const first = await ps.resolveApproval(bash(), BASH_INPUT)
    const second = await ps.resolveApproval(bash(), BASH_INPUT)

    expect(first.level).toBe('bypass')
    expect(second.level).toBe('bypass')
    // 分类器只被问了一次（缓存生效），台账也只有一行 —— 两者同源。
    expect(asked.n).toBe(1)
    expect(readClassifierRulings()).toHaveLength(1)
  })

  // ── 「绝不记工具入参」这句承诺，是可测的 ──

  it('台账**不含工具入参**：把哨兵串塞进命令里，落盘内容里一个字节都不能有', async () => {
    const SENTINEL = 'SENTINEL-c0ffee-不要落进台账'
    const ps = autoWith(stubClassifier({ allow: true, reason: '拒绝理由里也不许复述它' }))

    await ps.resolveApproval(bash(), { command: `cat ${SENTINEL}` })

    const raw = readClassifierRulings()
    expect(raw).toHaveLength(1)
    // 整行序列化后逐字比对 —— 不是只挑几个字段看。
    expect(JSON.stringify(raw)).not.toContain(SENTINEL)
    expect(JSON.stringify(raw)).not.toContain('command')
  })
})
