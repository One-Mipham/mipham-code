/**
 * Esc 的归属（314-056）—— 接线层测试。
 *
 * 缺陷：Agent View 看板开着时按 Esc，看板自己关掉，**同时**主界面那一支也跑了一遍
 * `dismissTopmost()`，它的最后一步是 `abortRef.current.abort()` —— 用户想关的是面板，
 * 结果正在跑的主回合被停了。根因是 Ink 把同一个按键派发给**所有**挂载的 `useInput`
 * （没有 stopPropagation），两条分支对同一个字节各判各的。
 *
 * 为什么只能断言形状：`App` 起不来（整条 engine / provider 链 + 挂载期 IO），
 * 与 `ctrl-c-guard.test.ts` 的主界面那一格同源。故这里钉两件事：
 *   ① Esc 分支里、`dismissTopmost()` **之前**，有一道「面板开着就交还面板」的守卫；
 *   ② 扫描器自己可失败 —— 修复前的写法（无守卫）与「守卫写在 abort 之后」都必须被判红。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 从 `if (key.escape) {` 的 `{` 起按花括号配对切出整块（跳过字符串）。 */
function escapeBranch(source: string): string | null {
  const marker = 'if (key.escape) {'
  const at = source.indexOf(marker)
  if (at < 0) return null
  const open = at + marker.length - 1
  let depth = 0
  let quote: string | null = null
  for (let i = open; i < source.length; i++) {
    const ch = source[i]!
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return null
}

/**
 * 返回问题描述；合格时返回 null。
 *
 * 判据是**次序**，不是「字符串在不在」：守卫写在 abort 之后等于没写，而只查
 * 「包含 agentViewOpen」的话两种写法都绿。
 */
function escapeOwnedByOverlay(branch: string | null): string | null {
  if (branch === null) return '找不到 Esc 分支'
  // 只认**语句**，不认散落的词：此分支的注释里就写着 `dismissTopmost()` 这个名字，
  // 按 `indexOf` 找会命中注释，于是守卫「看起来」排在 abort 之后 —— 判据读的是探针，
  // 不是代码。
  const guard = branch.search(/if\s*\(\s*agentViewOpen\s*\|\|\s*attachedSessionId\s*\)\s*return/)
  const abort = branch.search(/if\s*\(\s*dismissTopmost\(\)\s*\)/)
  if (abort < 0) return 'Esc 分支里没有 dismissTopmost —— 扫错分支了？'
  if (guard < 0) return '面板开着时 Esc 仍会走 dismissTopmost（会顺带 abort 主回合）'
  if (guard > abort) return '守卫写在 dismissTopmost 之后，等于没写'
  return null
}

describe('主界面 Esc 分支：面板开着时把 Esc 交还面板', () => {
  const source = readFileSync('src/ui/app.tsx', 'utf8')

  it('扫描器可失败（三条负对照 + 一条正对照）', () => {
    // 正对照：真源码里确实切得出这一块，且它接着 dismissTopmost
    const real = escapeBranch(source)
    expect(real).not.toBeNull()
    expect(/if\s*\(\s*dismissTopmost\(\)\s*\)/.test(real!)).toBe(true)

    // 负对照 1：修复前的写法
    expect(escapeOwnedByOverlay('{ if (dismissTopmost()) return; return }')).toContain('面板开着时')
    // 负对照 2：守卫存在但写在 abort 之后
    expect(
      escapeOwnedByOverlay(
        '{ if (dismissTopmost()) return; if (agentViewOpen || attachedSessionId) return }',
      ),
    ).toContain('之后')
    // 负对照 3：压根没切到分支
    expect(escapeOwnedByOverlay(null)).toContain('找不到')

    // 正对照 4：正确写法必须判绿
    expect(
      escapeOwnedByOverlay(
        '{ if (agentViewOpen || attachedSessionId) return; if (dismissTopmost()) return }',
      ),
    ).toBeNull()
  })

  it('真源码里守卫在 dismissTopmost 之前', () => {
    expect(escapeOwnedByOverlay(escapeBranch(source))).toBeNull()
  })
})
