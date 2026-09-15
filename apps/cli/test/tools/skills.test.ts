import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SkillsLoader } from '../../src/skills/loader'
import { BUNDLED_SKILLS } from '../../src/skills/bundled-skills'
import { BUNDLED_SKILL_ASSETS } from '../../src/skills/bundled-skill-assets'

// ── Helpers ──

function createSkillFile(dir: string, name: string, frontmatter: Record<string, string>) {
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  const content = `---\n${yaml}\n---\n\n# ${name}\n\nBody content here.`
  writeFileSync(join(dir, name), content)
}

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mipham-skill-test-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ============================================================
// SkillsLoader
// ============================================================

describe('SkillsLoader', () => {
  describe('loadBuiltin', () => {
    it('loads standard skills from skills/standard/', () => {
      const stdDir = join(tmpDir, 'skills', 'standard')
      mkdirSync(stdDir, { recursive: true })
      createSkillFile(stdDir, 'alpha.SKILL.md', {
        name: 'alpha',
        description: 'First skill',
        version: '1.0.0',
      })
      createSkillFile(stdDir, 'beta.SKILL.md', {
        name: 'beta',
        description: 'Second skill',
        version: '2.0.0',
      })

      const loader = new SkillsLoader()
      loader.loadBuiltin(tmpDir)

      expect(loader.has('alpha')).toBe(true)
      expect(loader.has('beta')).toBe(true)
      expect(loader.has('nonexistent')).toBe(false)
    })

    it('loads mipham skills from skills/mipham/', () => {
      const mDir = join(tmpDir, 'skills', 'mipham')
      mkdirSync(mDir, { recursive: true })
      createSkillFile(mDir, 'om-test.mipham-skill.md', {
        name: 'om-test',
        description: 'Mipham exclusive skill',
        version: '1.0.0',
      })

      const loader = new SkillsLoader()
      loader.loadBuiltin(tmpDir)

      expect(loader.has('om-test')).toBe(true)
      const skill = loader.get('om-test')
      expect(skill?.type).toBe('mipham')
    })

    it('handles missing skills directories gracefully', () => {
      const loader = new SkillsLoader()
      loader.loadBuiltin(tmpDir) // no skills/ dir at all
      expect(loader.list()).toHaveLength(0)
    })

    it('ignores non-skill files in the directory', () => {
      const stdDir = join(tmpDir, 'skills', 'standard')
      mkdirSync(stdDir, { recursive: true })
      writeFileSync(join(stdDir, 'README.md'), '# Not a skill')
      writeFileSync(join(stdDir, 'notes.txt'), 'not a skill either')

      const loader = new SkillsLoader()
      loader.loadBuiltin(tmpDir)

      expect(loader.has('readme')).toBe(false)
      expect(loader.list()).toHaveLength(0)
    })

    it('uses name from path when frontmatter name is missing', () => {
      const stdDir = join(tmpDir, 'skills', 'standard')
      mkdirSync(stdDir, { recursive: true })
      // Skill file with no 'name' in frontmatter
      writeFileSync(
        join(stdDir, 'dynamic-name.SKILL.md'),
        '---\ndescription: No name field\nversion: 1.0.0\n---\n\nBody',
      )

      const loader = new SkillsLoader()
      loader.loadBuiltin(tmpDir)

      expect(loader.has('dynamic-name')).toBe(true)
    })
  })

  describe('buildSystemReminder', () => {
    function seedSkills() {
      const stdDir = join(tmpDir, 'skills', 'standard')
      mkdirSync(stdDir, { recursive: true })
      createSkillFile(stdDir, 'security-review.SKILL.md', {
        name: 'security-review',
        description: 'Security audit skill — vulnerability scanning',
      })
      createSkillFile(stdDir, 'codebase-design.SKILL.md', {
        name: 'codebase-design',
        description: 'Design codebase architecture',
      })
      createSkillFile(stdDir, 'debug-loop.SKILL.md', {
        name: 'debug-loop',
        description: 'Debug failures',
      })
      const loader = new SkillsLoader()
      loader.loadBuiltin(tmpDir)
      return loader
    }

    it('lists every skill so the whole catalog is discoverable', () => {
      const loader = seedSkills()
      const reminder = loader.buildSystemReminder()

      expect(reminder).toContain('security-review')
      expect(reminder).toContain('codebase-design')
      expect(reminder).toContain('debug-loop')
    })

    it('off mode returns an empty reminder', () => {
      const loader = seedSkills()
      expect(loader.buildSystemReminder(5000, 'off')).toBe('')
    })

    it('compact mode still lists every skill name', () => {
      const loader = seedSkills()
      const reminder = loader.buildSystemReminder(5000, 'compact')

      expect(reminder).toContain('security-review')
      expect(reminder).toContain('codebase-design')
      expect(reminder).toContain('debug-loop')
    })

    it('compact mode truncates long descriptions to one short line', () => {
      const stdDir = join(tmpDir, 'skills', 'standard')
      mkdirSync(stdDir, { recursive: true })
      const longDesc = 'x'.repeat(120)
      createSkillFile(stdDir, 'long-desc.SKILL.md', {
        name: 'long-desc',
        description: longDesc,
      })
      const loader = new SkillsLoader()
      loader.loadBuiltin(tmpDir)

      const reminder = loader.buildSystemReminder(5000, 'compact')
      expect(reminder).toContain('long-desc')
      expect(reminder).toContain('…')
      expect(reminder).not.toContain(longDesc)
    })
  })

  describe('loadBuiltinFromPackage', () => {
    it('loads the bundled skills shipped with the app (not cwd-relative)', () => {
      const loader = new SkillsLoader()
      loader.loadBuiltinFromPackage()

      const counts = loader.countByType()
      expect(counts.standard).toBeGreaterThanOrEqual(20)
      expect(counts.mipham).toBeGreaterThanOrEqual(3)
      // Spot-check two known bundled skills across both tracks
      expect(loader.has('code-review')).toBe(true)
      expect(loader.get('code-review')?.type).toBe('standard')
      expect(loader.has('om-artifact')).toBe(true)
      expect(loader.get('om-artifact')?.type).toBe('mipham')
    })
  })

  describe('loadEmbedded (compiled-binary fallback)', () => {
    it('loads skills from the bundled in-memory snapshot', () => {
      const loader = new SkillsLoader()
      loader.loadEmbedded(BUNDLED_SKILLS)

      const counts = loader.countByType()
      expect(counts.standard).toBeGreaterThanOrEqual(20)
      expect(counts.mipham).toBeGreaterThanOrEqual(3)
      expect(loader.has('code-review')).toBe(true)
      expect(loader.get('code-review')?.type).toBe('standard')
      expect(loader.has('om-artifact')).toBe(true)
      expect(loader.get('om-artifact')?.type).toBe('mipham')
    })
  })

  describe('loadExternal', () => {
    it('loads skills from external paths', () => {
      const extDir = join(tmpDir, 'external-skills')
      mkdirSync(extDir, { recursive: true })
      createSkillFile(extDir, 'ext-skill.SKILL.md', {
        name: 'ext-skill',
        description: 'External skill',
        version: '1.0.0',
      })

      const loader = new SkillsLoader()
      loader.loadExternal([extDir])

      expect(loader.has('ext-skill')).toBe(true)
    })

    it('loads a single skill file directly', () => {
      const skillPath = join(tmpDir, 'standalone.SKILL.md')
      writeFileSync(
        skillPath,
        '---\nname: standalone\ndescription: Standalone file\nversion: 1.0.0\n---\n\nBody',
      )

      const loader = new SkillsLoader()
      loader.loadExternal([skillPath])

      expect(loader.has('standalone')).toBe(true)
    })

    it('handles non-existent paths gracefully', () => {
      const loader = new SkillsLoader()
      loader.loadExternal(['/nonexistent/path'])
      expect(loader.list()).toHaveLength(0)
    })

    it('loads mipham skill files from external directories', () => {
      const extDir = join(tmpDir, 'ext-mipham')
      mkdirSync(extDir, { recursive: true })
      createSkillFile(extDir, 'om-external.mipham-skill.md', {
        name: 'om-external',
        description: 'External mipham skill',
        version: '1.0.0',
      })

      const loader = new SkillsLoader()
      loader.loadExternal([extDir])

      expect(loader.has('om-external')).toBe(true)
      expect(loader.get('om-external')?.type).toBe('standard') // external always standard type
    })
  })

  describe('get, list, listByType, has', () => {
    it('returns undefined for unknown skill', () => {
      const loader = new SkillsLoader()
      expect(loader.get('nope')).toBeUndefined()
    })

    it('lists all loaded skills', () => {
      const stdDir = join(tmpDir, 'skills', 'standard')
      mkdirSync(stdDir, { recursive: true })
      createSkillFile(stdDir, 'a.SKILL.md', { name: 'a', description: 'A', version: '1.0.0' })
      createSkillFile(stdDir, 'b.SKILL.md', { name: 'b', description: 'B', version: '1.0.0' })

      const loader = new SkillsLoader()
      loader.loadBuiltin(tmpDir)

      const list = loader.list()
      expect(list).toHaveLength(2)
    })

    it('filters by type with listByType', () => {
      const stdDir = join(tmpDir, 'skills', 'standard')
      const mDir = join(tmpDir, 'skills', 'mipham')
      mkdirSync(stdDir, { recursive: true })
      mkdirSync(mDir, { recursive: true })

      createSkillFile(stdDir, 'std.SKILL.md', { name: 'std', description: 'S', version: '1.0.0' })
      createSkillFile(mDir, 'om.mipham-skill.md', {
        name: 'om',
        description: 'M',
        version: '1.0.0',
      })

      const loader = new SkillsLoader()
      loader.loadBuiltin(tmpDir)

      expect(loader.listByType('standard')).toHaveLength(1)
      expect(loader.listByType('mipham')).toHaveLength(1)
    })
  })

  describe('skill properties', () => {
    it('parses all frontmatter fields correctly', () => {
      const stdDir = join(tmpDir, 'skills', 'standard')
      mkdirSync(stdDir, { recursive: true })
      writeFileSync(
        join(stdDir, 'full.SKILL.md'),
        [
          '---',
          'name: full-skill',
          'description: A complete skill definition',
          'version: 2.5.0',
          'tools:',
          '  - name: custom-tool',
          '    description: A tool',
          'hooks:',
          '  - type: pre-query',
          '    action: validate',
          'prompts:',
          '  analyze: "Analyze this code: ${file}"',
          '---',
          '',
          '# Full Skill',
          '',
          'Body content.',
        ].join('\n'),
      )

      const loader = new SkillsLoader()
      loader.loadBuiltin(tmpDir)

      const skill = loader.get('full-skill')
      expect(skill).toBeDefined()
      expect(skill!.name).toBe('full-skill')
      expect(skill!.description).toBe('A complete skill definition')
      expect(skill!.version).toBe('2.5.0')
      expect(skill!.type).toBe('standard')
      expect(skill!.tools).toEqual([{ name: 'custom-tool', description: 'A tool' }])
      expect(skill!.hooks).toEqual([{ type: 'pre-query', action: 'validate' }])
      expect(skill!.prompts).toEqual({ analyze: 'Analyze this code: ${file}' })
    })

    it('defaults version to 0.1.0 when missing', () => {
      const stdDir = join(tmpDir, 'skills', 'standard')
      mkdirSync(stdDir, { recursive: true })
      createSkillFile(stdDir, 'noversion.SKILL.md', {
        name: 'noversion',
        description: 'No version',
      })

      const loader = new SkillsLoader()
      loader.loadBuiltin(tmpDir)

      expect(loader.get('noversion')?.version).toBe('0.1.0')
    })
  })
})

describe('bundled-skills snapshot freshness', () => {
  it('matches the skills on disk (regenerate with `bun run scripts/generate-bundled-skills.ts`)', () => {
    const skillsRoot = join(import.meta.dirname, '..', '..', 'skills')

    const expected: Array<{ type: 'standard' | 'mipham'; raw: string }> = []
    for (const type of ['standard', 'mipham'] as const) {
      const ext = type === 'standard' ? '.SKILL.md' : '.mipham-skill.md'
      const dir = join(skillsRoot, type)
      const files = readdirSync(dir)
        .filter((f) => f.endsWith(ext))
        .sort()
      for (const f of files) {
        expected.push({ type, raw: readFileSync(join(dir, f), 'utf-8') })
      }
    }

    expect(BUNDLED_SKILLS).toEqual(expected)
  })
})

describe('bundled-skill-assets snapshot freshness', () => {
  it('matches web-access assets on disk (regenerate with `bun run scripts/generate-bundled-skills.ts`)', () => {
    const assetsRoot = join(import.meta.dirname, '..', '..', 'skills', 'standard', 'web-access')
    const expected: Array<{ path: string; content: string; mode?: number }> = []
    const walk = (dir: string, rel: string) => {
      // Mirror the generator's traversal: code-unit .sort() on string names, one statSync.
      for (const name of readdirSync(dir).sort()) {
        if (name === '.gitkeep') continue
        const full = join(dir, name)
        const relPath = rel ? `${rel}/${name}` : name
        const st = statSync(full)
        if (st.isDirectory()) walk(full, relPath)
        else
          expected.push({
            path: relPath,
            content: readFileSync(full, 'utf-8'),
            mode: st.mode & 0o777,
          })
      }
    }
    walk(assetsRoot, '')
    expect(BUNDLED_SKILL_ASSETS['web-access']).toEqual(expected)
  })
})
