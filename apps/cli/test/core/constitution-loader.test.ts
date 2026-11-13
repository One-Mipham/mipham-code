import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConstitutionLoader, DEFAULT_CONSTITUTION } from '../../src/core/constitution-loader'

/**
 * `scope` carries two different things in the vocabulary: a hook phase
 * (`all-tools`, `pre-inference`, `post-tool-use`) and a comma-separated tool
 * list (`"Write,Edit,Bash"`). `getPrinciplesForTool` read the phase and the
 * `tools[]` array, never the comma list — so `no-credential-leak`, the one
 * entry spelled in the comma form, applied to **no tool at all** while its
 * neighbours (which declare `tools[]` as well) worked fine.
 *
 * A rule that is never selected cannot block anything, and nothing about it
 * looks wrong: the vocabulary parses, the principle renders in `/constitution`,
 * and every test that fed the gate a hand-built principle stayed green.
 */

const loader = new ConstitutionLoader(
  // Own path: the loader writes a default guardrails file when none exists.
  join(mkdtempSync(join(tmpdir(), 'constitution-')), 'ai-guardrails.yml'),
)

const ids = (tool: string) => loader.getPrinciplesForTool(tool).map((p) => p.id)

describe('ConstitutionLoader.getPrinciplesForTool', () => {
  it('applies a comma-separated scope to each tool it names', () => {
    for (const tool of ['Write', 'Edit', 'Bash']) {
      expect(ids(tool), `${tool} should enforce no-credential-leak`).toContain('no-credential-leak')
    }
  })

  it('does not apply that principle outside the three tools it names', () => {
    expect(ids('Read')).not.toContain('no-credential-leak')
  })

  it('still applies all-tools principles everywhere', () => {
    expect(ids('Read')).toEqual(expect.arrayContaining(['never-fabricate', 'respect-permissions']))
  })

  it('still matches a `tools[]` array', () => {
    expect(ids('Write')).toEqual(expect.arrayContaining(['minimal-change', 'simplicity-first']))
    expect(ids('Bash')).toContain('no-destructive-without-confirmation')
  })

  it('leaves hook-phase scopes off tool calls', () => {
    // `pre-inference` / `post-tool-use` name hooks, not tools; treating them as
    // tool names would be the mirror image of the same bug.
    for (const tool of ['Write', 'Edit', 'Bash', 'Read']) {
      expect(ids(tool)).not.toContain('think-before-coding')
      expect(ids(tool)).not.toContain('persist-crsi-learning')
    }
  })
})

/**
 * 写盘 → 读回。上面那组用例全绕着「文件不存在 ⇒ 用内置默认值」走，
 * 所以 `~/.mipham/ai-guardrails.yml` 自己写了什么、能不能读回来，一条都没碰到。
 *
 * 而那个文件头写着「Edit this file to customize principles」——
 * `parseYaml` 却先 `trim()` 再问 `startsWith('  ')`（trim 之后恒为假），
 * 于是每个缩进字段都被当成顶层键丢掉：`validate()` 必失败，
 * `load()` 恒回默认并**覆写**用户刚改的文件。
 */
describe('ConstitutionLoader 的写盘 → 读回', () => {
  const fresh = () => join(mkdtempSync(join(tmpdir(), 'constitution-rt-')), 'ai-guardrails.yml')

  it('自己写出的默认文件能被自己读回来，字段一个不少', () => {
    const path = fresh()
    new ConstitutionLoader(path).load() // 无文件 ⇒ 写入默认值
    const back = new ConstitutionLoader(path).load() // 有文件 ⇒ 必须解析回来

    expect(back.version).toBe(DEFAULT_CONSTITUTION.version)
    // 同一性断言：落回默认值时返回的就是 DEFAULT_CONSTITUTION 本身，
    // 深比较在那种情况下照样全绿 —— 这条才是「真的解析了」的判据。
    expect(back.principles).not.toBe(DEFAULT_CONSTITUTION.principles)
    expect(back.principles).toEqual(DEFAULT_CONSTITUTION.principles)
  })

  it('用户手写的条目会生效，且文件不被改写', () => {
    const path = fresh()
    const mine = [
      'version: "9.9.9"',
      'last_modified: "2026-11-13"',
      'principles:',
      '  - id: "user-rule"',
      '    text: "My own principle"',
      '    enforce: warn',
      '    scope: "all-tools"',
      '    tools: [Write, Edit]',
      '    hook: pre-tool-use',
      '',
    ].join('\n')
    writeFileSync(path, mine)

    const loaded = new ConstitutionLoader(path).load()

    expect(loaded.version).toBe('9.9.9')
    expect(loaded.principles).toEqual([
      {
        id: 'user-rule',
        text: 'My own principle',
        enforce: 'warn',
        scope: 'all-tools',
        tools: ['Write', 'Edit'],
        hook: 'pre-tool-use',
      },
    ])
    expect(readFileSync(path, 'utf8')).toBe(mine)
  })

  it('文件不合格时用默认原则，但保留原文并告警 —— 不许静默覆盖用户的东西', () => {
    const path = fresh()
    // 少了 `text`，`validate()` 会拒；旧代码在这里直接把它盖掉了。
    const mine = 'version: "9.9.9"\nprinciples:\n  - id: "half-written"\n    enforce: warn\n'
    writeFileSync(path, mine)
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const loaded = new ConstitutionLoader(path).load()

    expect(loaded.principles).toEqual(DEFAULT_CONSTITUTION.principles)
    expect(warn.mock.calls.map((c) => String(c[0])).join('')).toContain(path)
    expect(readFileSync(path, 'utf8')).toBe(mine)
    warn.mockRestore()
  })
})
