/**
 * 「这条权限规则写坏了」只报一次 —— 直到那条规则本身变了。
 *
 * 判据分两半：第二次启动不再报（记的是**这一条**的文本），以及文本一变就重报
 * （不是「报过任何一条就永久闭嘴」）。少了后一半，一个把告警全局关掉的实现也能
 * 让前一半全绿 —— 而那正是真正的失效形态：坏规则从此刻起没人知道。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { unacknowledgedRuleWarnings } from '../../src/core/permission-rule-ack'

// 记账会真的落盘 —— 压在 tmpdir 里，别碰用户的 ~/.mipham。
// 全局 setup 已经把 homedir 指向 `mipham-test-home`，那份目录**跨运行保留**：
// 不换成自己的目录，上一趟写下的认同会让这一趟的「第一次」读到空结果。
const HOME = `${(await import('node:os')).tmpdir()}/mipham-test-rule-ack`
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => `${actual.tmpdir()}/mipham-test-rule-ack` }
})

const WARN_A = 'Permission rule "Bash(ls) x" is malformed and will never match.'
const WARN_B = 'Permission rule "Bahs(ls)" names an unknown tool.'

describe('permission-rule-ack', () => {
  beforeEach(() => {
    rmSync(HOME, { recursive: true, force: true })
  })

  it('第一次全都报，第二次一条都不报', () => {
    expect(unacknowledgedRuleWarnings([WARN_A, WARN_B])).toEqual([WARN_A, WARN_B])
    expect(unacknowledgedRuleWarnings([WARN_A, WARN_B])).toEqual([])
  })

  it('规则改了（文本变了）就重新报 —— 记账的是文本，不是「报过就算」', () => {
    unacknowledgedRuleWarnings([WARN_A])
    const changed = 'Permission rule "Bash(ls) x y" is malformed and will never match.'
    expect(unacknowledgedRuleWarnings([changed])).toEqual([changed])
  })

  it('只有新出现的那条报，旧的不重复', () => {
    unacknowledgedRuleWarnings([WARN_A])
    expect(unacknowledgedRuleWarnings([WARN_A, WARN_B])).toEqual([WARN_B])
  })

  it('没有坏规则 ⇒ 不写记账文件', () => {
    expect(unacknowledgedRuleWarnings([])).toEqual([])
    expect(existsSync(join(HOME, '.mipham', 'permission-rule-acks.json'))).toBe(false)
  })

  it('记账文件坏了 ⇒ 当作没记过（重报，而不是静默）', () => {
    const path = join(HOME, '.mipham', 'permission-rule-acks.json')
    mkdirSync(join(HOME, '.mipham'), { recursive: true })
    writeFileSync(path, '{ not json', 'utf-8')
    expect(unacknowledgedRuleWarnings([WARN_A])).toEqual([WARN_A])
    // 并且把文件修好了：下一次就安静了
    expect(JSON.parse(readFileSync(path, 'utf-8')).acknowledged).toEqual([WARN_A])
    expect(unacknowledgedRuleWarnings([WARN_A])).toEqual([])
  })

  it('写盘失败 ⇒ 这一次照报（多报优于静默）', () => {
    // 把 ~/.mipham 占成一个文件：mkdirSync 会失败
    mkdirSync(HOME, { recursive: true })
    writeFileSync(join(HOME, '.mipham'), '')
    expect(unacknowledgedRuleWarnings([WARN_A])).toEqual([WARN_A])
  })
})
