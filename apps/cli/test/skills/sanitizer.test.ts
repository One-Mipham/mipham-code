import { describe, it, expect } from 'vitest'
import { checkSkillShadow, sanitizeSkillBody } from '../../src/skills/sanitizer'

describe('checkSkillShadow', () => {
  it('flags a skill whose name shadows a builtin command (slash-normalized)', () => {
    // skillName has no leading slash; BUILTIN_COMMANDS stores '/help' etc.
    expect(checkSkillShadow('help', '').shadowed).toBe(true)
    expect(checkSkillShadow('crsi', '').shadowed).toBe(true)
    expect(checkSkillShadow('help', '').conflictsWith).toBe('help')
    expect(checkSkillShadow('help', '').conflictType).toBe('command')
  })

  it('does not flag non-shadowing names', () => {
    expect(checkSkillShadow('save', '').shadowed).toBe(false)
    expect(checkSkillShadow('wiki', '').shadowed).toBe(false)
    // 'triage' 是真实 skill（user-invocable），/triage 已从 BUILTIN_COMMANDS 移除
    expect(checkSkillShadow('triage', '').shadowed).toBe(false)
  })
})

/**
 * `sanitizeSkillBody` 此前**一条测试都没有**（本文件只 import 了 `checkSkillShadow`），
 * 而它是有两个生产调用点的安全相关函数（`tools/agent/skill.ts:98`、`skills/loader.ts:170`）。
 * 下面钉住每个变换**做了什么**、以及**没做什么** —— 后者是这次的缺陷来源：正文里那段
 * 「`! command` → `! command`」的注释两侧逐字相同（真实插入的是一个**普通空格**，
 * 而它当时写的是零宽空格），另有一条「Excessively long lines → truncated」的承诺
 * **对应的代码根本不存在**。
 */
describe('sanitizeSkillBody — `!` 命令中和', () => {
  it('在行首 `!` 后插入一个**普通空格**（不是零宽空格）', () => {
    const r = sanitizeSkillBody('!rm -rf /\nkeep me')
    expect(r.modified).toBe(true)
    expect(r.text).toBe('! rm -rf /\nkeep me')
    // 逐码点断言：夹在 `!` 与 `rm` 之间的必须恰好是 U+0020。
    // 只比字符串会放过零宽空格（它肉眼不可见）—— 而 U+200B 在
    // `shared/sanitize.ts` 的危险不可见字符表里，写进去会被下游剥掉、中和自我撤销。
    const after = r.text.charCodeAt(1)
    expect(after, '插入的字符必须是普通空格 U+0020').toBe(0x20)
    const cps = [...r.text].map((c) => c.codePointAt(0) ?? 0)
    expect(
      cps.some((cp) => (cp >= 0x200b && cp <= 0x200f) || cp === 0xfeff),
      '不得引入零宽字符',
    ).toBe(false)
  })

  it('只在**行首**动手：行中间的 `!` 原样留着', () => {
    const r = sanitizeSkillBody('a ! b\nc!d')
    expect(r.modified).toBe(false)
    expect(r.text).toBe('a ! b\nc!d')
    expect(r.warnings).toEqual([])
    // 反向对照：写法对的时候这条断言会亮 —— 免得上面那句在任何输入下都为真。
    expect(sanitizeSkillBody('!x').modified).toBe(true)
  })

  it('孤零零一行 `!` 不跨行抓取下一行的词（`\\s*` 会，`[^\\S\\n]*` 不会）', () => {
    // 这是本次修掉的真缺陷：`\s` 含 `\n`，于是 `!\nfoo` 把下一行的 `foo`
    // 报成 shell 命令、并把那一行改成 `! `（凭空多一个尾随空格）。
    const r = sanitizeSkillBody('!\nfoo')
    expect(r.warnings).toEqual([])
    expect(r.text).toBe('!\nfoo')
    expect(r.modified).toBe(false)
  })

  it('同一行上 `!` 后跟空格仍算（`!  ls`），且不重复计数', () => {
    const r = sanitizeSkillBody('!  ls\n!pwd')
    expect(r.text).toBe('!   ls\n! pwd')
    expect(r.warnings[0]).toContain('2 shell-command-like patterns')
  })

  it('检测与替换作用在同一批行上：报了 1 条，就只准改 1 行', () => {
    // 替换阶段只在**检出过**时才跑，所以上面那条孤零零 `!` 的用例
    // 其实碰不到替换正则（早退）。这里加一条已被检出的正文：
    // `^!(?=\s*\S)` 的 `\s*` 会跨过换行、把第二行那个未被检出的 `!`
    // 也改成 `! ` —— 「报 1 条、改 2 行」。`[^\S\n]*` 不会。
    const r = sanitizeSkillBody('!ls\n!\nfoo')
    expect(r.warnings[0]).toContain('1 shell-command-like pattern')
    expect(r.text).toBe('! ls\n!\nfoo')
  })
})

describe('sanitizeSkillBody — @file 与围栏', () => {
  it('`@file.md` 变成 `@ file.md`（`@` 后加空格以终止展开）', () => {
    const r = sanitizeSkillBody('see @notes.md for detail')
    expect(r.modified).toBe(true)
    expect(r.text).toBe('see @ notes.md for detail')
  })

  it('奇数个围栏补一个收尾围栏，偶数个不动', () => {
    const odd = sanitizeSkillBody('```ts\ncode\n')
    expect(odd.text.endsWith('\n```')).toBe(true)
    expect(odd.warnings.join(' ')).toContain('unclosed markdown fence')

    const even = sanitizeSkillBody('```ts\ncode\n```\n')
    expect(even.text).toBe('```ts\ncode\n```\n')
    expect(even.modified).toBe(false)
  })

  it('干净正文原样返回，零告警', () => {
    const r = sanitizeSkillBody('# Title\n\nPlain instructions.\n')
    expect(r).toEqual({
      text: '# Title\n\nPlain instructions.\n',
      warnings: [],
      modified: false,
      blocked: false,
    })
  })
})
