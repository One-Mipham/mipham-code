import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SkillsLoader } from '../../src/skills/loader'

// `description:` is free-form YAML, so a list is legal input. It used to be cast
// to `string`, then `sanitizeSkillDescription` called `.replace` on the array,
// threw, and the per-file catch swallowed the error — the skill disappeared with
// no message. A malformed description may cost the description; it must not cost
// the skill, and it must not be silent.

let dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'mipham-skill-desc-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
  vi.restoreAllMocks()
})

describe('SkillsLoader frontmatter description', () => {
  it('loads a skill whose description is a YAML list, with an empty description', () => {
    const dir = tmp()
    writeFileSync(
      join(dir, 'arr.SKILL.md'),
      '---\nname: arr-desc\ndescription:\n  - first line\n  - second line\n---\nbody\n',
      'utf-8',
    )
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const loader = new SkillsLoader()
    loader.loadExternal([dir])

    expect(loader.list()).toHaveLength(1)
    expect(loader.list()[0]!.name).toBe('arr-desc')
    expect(loader.list()[0]!.description).toBe('')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('description is not a string'))
  })

  it('positive control: a string description still loads unchanged', () => {
    const dir = tmp()
    writeFileSync(
      join(dir, 'ok.SKILL.md'),
      '---\nname: ok-desc\ndescription: fine\n---\nbody\n',
      'utf-8',
    )

    const loader = new SkillsLoader()
    loader.loadExternal([dir])

    expect(loader.list()).toHaveLength(1)
    expect(loader.list()[0]!.description).toBe('fine')
  })

  it('coerces a bare number description instead of dropping the skill', () => {
    const dir = tmp()
    writeFileSync(
      join(dir, 'num.SKILL.md'),
      '---\nname: num-desc\ndescription: 3000\n---\nbody\n',
      'utf-8',
    )

    const loader = new SkillsLoader()
    loader.loadExternal([dir])

    expect(loader.list()).toHaveLength(1)
    expect(loader.list()[0]!.description).toBe('3000')
  })

  it('recovers a plain scalar containing ": " that strict YAML rejects', () => {
    // `description: Fix: a bug` is invalid YAML (second mapping colon). Strict
    // parsing threw and the skill vanished; the fallback keeps the top-level
    // scalar keys instead (CC 2.1.69-068).
    const dir = tmp()
    writeFileSync(
      join(dir, 'colon.SKILL.md'),
      '---\nname: colon-desc\ndescription: Fix: a bug in the parser\n---\nbody\n',
      'utf-8',
    )

    const loader = new SkillsLoader()
    loader.loadExternal([dir])

    expect(loader.list()).toHaveLength(1)
    expect(loader.list()[0]!.name).toBe('colon-desc')
    expect(loader.list()[0]!.description).toBe('Fix: a bug in the parser')
  })
})
