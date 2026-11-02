/**
 * 会话名的**取材对象**（314-025）—— 接线层测试。
 *
 * 缺陷：转发型斜杠命令（`/tdd`、`/design` 等）会把 `input` 换成给模型的指令正文
 * （`input = forwardToAI`），而自动命名用的是 `input` ⇒ 第一条命令就能把会话命名成
 * 「Follow the Test-Driven Development workflow for …」这一段内部指令，/resume
 * 列表里看到的全是模型的话，不是用户的话。
 *
 * 为什么只能钉形状：`App` 起不来（整条 engine / provider 链 + 挂载期 IO），与
 * `ctrl-c-guard.test.ts` 的主界面那一格同源。判据是**次序 + 取材对象**：
 * ① 用户敲的那串在 `input = forwardToAI` 之前就存下来；
 * ② `deriveSessionTitle` 吃的是它，不是被改写后的 `input`。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 去掉行注释与块注释（跳过字符串字面量）。
 *
 * 必须去掉：这次修的正是**注释里也会写**的那段代码形状 —— 修复留在注释里的
 * `（`input = forwardToAI`）` 会把「改写发生的位置」指到说明文字上，扫出来的次序
 * 描述的是探针，不是代码。
 */
function stripComments(src: string): string {
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (quote) {
      out += ch
      if (ch === '\\') {
        out += src[i + 1] ?? ''
        i++
      } else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ch
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i++
      continue
    }
    out += ch
  }
  return out
}

/** 返回问题描述；合格时返回 null。 */
function titleComesFromTypedInput(raw: string): string | null {
  const source = stripComments(raw)
  const saved = source.search(/const\s+typedInput\s*=\s*input\b/)
  const bridge = source.search(/\binput\s*=\s*forwardToAI\b/)
  const derive = source.search(/deriveSessionTitle\(([^)]*)\)/)

  if (saved < 0) return '没有保存用户敲的那串'
  if (bridge < 0) return '找不到 input = forwardToAI —— 扫错文件了？'
  if (derive < 0) return '找不到 deriveSessionTitle 调用'
  if (saved > bridge) return '保存发生在改写之后，存到的是指令正文'
  const arg = /deriveSessionTitle\(([^)]*)\)/.exec(source)?.[1]?.trim()
  if (arg !== 'typedInput') return `会话名取自 ${arg} —— 转发命令下那是内部指令`
  return null
}

describe('主界面：会话名取自用户敲的那串', () => {
  const source = readFileSync('src/ui/app.tsx', 'utf8')

  it('扫描器可失败（三条负对照 + 一条正对照）', () => {
    const ok =
      'const typedInput = input\ninput = forwardToAI\nconst t = deriveSessionTitle(typedInput)'
    expect(titleComesFromTypedInput(ok)).toBeNull() // 正对照

    // 负对照 1：修复前的写法 —— 直接吃被改写后的 input
    expect(
      titleComesFromTypedInput(
        'const typedInput = input\ninput = forwardToAI\nconst t = deriveSessionTitle(input)',
      ),
    ).toContain('内部指令')
    // 负对照 2：保存写在改写之后（存到的是指令正文）
    expect(
      titleComesFromTypedInput(
        'input = forwardToAI\nconst typedInput = input\nconst t = deriveSessionTitle(typedInput)',
      ),
    ).toContain('改写之后')
    // 负对照 3：压根没有保存
    expect(
      titleComesFromTypedInput('input = forwardToAI\nconst t = deriveSessionTitle(typedInput)'),
    ).toContain('没有保存')
  })

  it('真源码：先存用户的话，再由它取名', () => {
    expect(titleComesFromTypedInput(source)).toBeNull()
  })
})
