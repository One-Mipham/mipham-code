import { describe, it, expect } from 'vitest'
import { unprovenCountClaims } from '../../src/core/number-provenance'

/**
 * 「这个数是命令产的吗？」
 *
 * 只有一种主张能机械判定：**带计数单位的数量**（`4,572 测试`、`343 files`）。
 * 判据是它有没有在本轮**工具结果**里出现过 —— 模型自己前一轮写下的话不算出处，
 * 那正是「先猜一个数、再当事实复述」的形态。
 */
describe('unprovenCountClaims', () => {
  it('reports a Chinese count claim that no tool output supports', () => {
    const claims = unprovenCountClaims('测试 4,572 个，全部通过。', 'Tests  4570 passed')
    expect(claims.map((c) => c.digits)).toEqual(['4572'])
  })

  it('accepts a claim whose number the tool output carries, separators aside', () => {
    expect(unprovenCountClaims('总共 4,572 个测试。', 'Tests 4,572 passed (4,572)')).toEqual([])
  })

  it('does not accept a claim that is merely a prefix of a longer number', () => {
    const claims = unprovenCountClaims('改了 4572 行。', 'total 45720 lines')
    expect(claims).toHaveLength(1)
  })

  it('reports an English count claim', () => {
    const claims = unprovenCountClaims('That touches 343 files.', 'git status: clean')
    expect(claims.map((c) => c.digits)).toEqual(['343'])
  })

  it('ignores numbers that are not counts', () => {
    const text = 'Version 2.94.48 is out; port 3007, 2026-10-29, 2400 ms elapsed.'
    expect(unprovenCountClaims(text, '')).toEqual([])
  })

  it('ignores claims inside code — quoting a file is not making a claim about it', () => {
    const text = 'Use `wc -l: 1234 lines` in the block:\n\n```\n1235 tests\n```\n'
    expect(unprovenCountClaims(text, '')).toEqual([])
  })

  it('ignores a line reference — 第 N 行 names a place, it does not count', () => {
    expect(unprovenCountClaims('见第 1234 行。', '')).toEqual([])
  })

  it('keeps the surrounding words so the notice can name what it doubts', () => {
    const claims = unprovenCountClaims('测试 4,572 个。', '')
    expect(claims[0]!.context).toContain('4,572')
    expect(claims[0]!.context).toContain('个')
  })

  it('reports each distinct number once', () => {
    const claims = unprovenCountClaims('4572 个测试，且 4572 个都过了。', '')
    expect(claims).toHaveLength(1)
  })
})
