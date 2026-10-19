import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SkillsLoader, invalidSkillNameReason } from '../../src/skills/loader'

// Skill names land verbatim in the `<system-reminder>` block, so a name that
// carries a newline/format control can forge reminder lines. These tests pin
// both halves: the validator's verdicts, and the loader's fall-back/skip path.

let dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'mipham-skill-name-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
  vi.restoreAllMocks()
})

describe('invalidSkillNameReason', () => {
  it('accepts ordinary names, including CJK and hyphens', () => {
    for (const name of ['code-review', 'my_skill', '技能', 'a b']) {
      expect(invalidSkillNameReason(name)).toBeNull()
    }
  })

  it.each([
    ['newline', 'a\nb'],
    ['NUL', 'a\u0000b'],
    ['right-to-left override', 'a\u202Eb'],
    ['zero-width space', 'a\u200Bb'],
    ['line separator', 'a\u2028b'],
    ['non-breaking space', 'a\u00A0b'],
    ['angle brackets', '<system-reminder>'],
  ])('rejects %s', (_label, name) => {
    expect(invalidSkillNameReason(name)).not.toBeNull()
  })

  it('rejects an empty or whitespace-only name', () => {
    expect(invalidSkillNameReason('   ')).not.toBeNull()
  })
})

describe('SkillsLoader name gate', () => {
  it('rejects a control-character frontmatter name and falls back to the file stem', () => {
    const dir = tmp()
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const p = join(dir, 'safe-stem.SKILL.md')
    writeFileSync(p, '---\nname: "evil\\u000Aname"\ndescription: d\n---\nbody\n', 'utf-8')

    const loader = new SkillsLoader()
    loader.loadExternal([dir])

    expect(loader.list()).toHaveLength(1)
    expect(loader.list()[0]!.name).toBe('safe-stem')
  })

  it('skips a skill whose path-derived name is also invalid', () => {
    const dir = tmp()
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const evilDir = join(dir, 'evil\ndir')
    mkdirSync(evilDir)
    const p = join(evilDir, 'SKILL.md')
    writeFileSync(p, '---\ndescription: d\n---\nbody\n', 'utf-8')

    const loader = new SkillsLoader()
    loader.loadSkillFile(p)

    expect(loader.list()).toHaveLength(0)
    expect(stderr.mock.calls.map(String).join('')).toContain('path-derived name rejected')
  })

  it('ignores a non-string name (YAML number) instead of casting it', () => {
    const dir = tmp()
    const p = join(dir, 'numeric.SKILL.md')
    writeFileSync(p, '---\nname: 42\ndescription: d\n---\nbody\n', 'utf-8')

    const loader = new SkillsLoader()
    loader.loadExternal([dir])

    expect(loader.list()).toHaveLength(1)
    expect(loader.list()[0]!.name).toBe('numeric')
    expect(typeof loader.list()[0]!.name).toBe('string')
  })

  it('keeps a valid declared name', () => {
    const dir = tmp()
    const p = join(dir, 'file-stem.SKILL.md')
    writeFileSync(p, '---\nname: declared-name\ndescription: d\n---\nbody\n', 'utf-8')

    const loader = new SkillsLoader()
    loader.loadExternal([dir])

    expect(loader.get('declared-name')).toBeDefined()
  })
})
