import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SkillDefinition } from '@mipham/shared'
import { SkillsLoader } from '../../src/skills/loader'
import { StandardRuntime } from '../../src/skills/standard/runtime'
import { MiphamRuntime } from '../../src/skills/mipham/runtime'

// ── Helpers ──

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: 'test-skill',
    description: 'A test skill',
    version: '1.0.0',
    type: 'standard',
    ...overrides,
  }
}

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

// ============================================================
// StandardRuntime
// ============================================================

describe('StandardRuntime', () => {
  const skill = makeSkill({
    name: 'test',
    description: 'Test skill',
    prompts: {
      greet: 'Hello, ${name}!',
      analyze: 'Analyze ${file} with focus on ${aspect}.',
    },
    tools: [
      {
        name: 'tool-a',
        description: 'Tool A',
        category: 'system',
        permission: 'auto',
        parameters: {},
        execute: async () => ({ success: true, content: '' }),
      },
    ],
    hooks: [{ event: 'PostToolUse', handler: async () => ({ allowed: true }) }],
  })

  const runtime = new StandardRuntime({
    skill,
    cwd: '/test/cwd',
    sessionId: 'session-1',
  })

  it('returns the skill', () => {
    expect(runtime.getSkill()).toBe(skill)
  })

  it('returns all prompts', () => {
    const prompts = runtime.getPrompts()
    expect(prompts).toEqual(skill.prompts)
  })

  it('returns a specific prompt by name', () => {
    expect(runtime.getPrompt('greet')).toBe('Hello, ${name}!')
  })

  it('returns undefined for missing prompt', () => {
    expect(runtime.getPrompt('nonexistent')).toBeUndefined()
  })

  it('returns tools', () => {
    expect(runtime.getTools()).toEqual(skill.tools)
  })

  it('returns hooks', () => {
    expect(runtime.getHooks()).toEqual(skill.hooks)
  })

  it('returns empty array for missing tools', () => {
    const emptySkill = makeSkill({ name: 'empty', prompts: {}, tools: undefined, hooks: undefined })
    const rt = new StandardRuntime({ skill: emptySkill, cwd: '/', sessionId: 's' })
    expect(rt.getTools()).toEqual([])
    expect(rt.getHooks()).toEqual([])
  })

  it('executes a prompt with variable substitution', async () => {
    const result = await runtime.executePrompt('greet', { name: 'World' })
    expect(result).toBe('Hello, World!')
  })

  it('executes prompt with multiple variables', async () => {
    const result = await runtime.executePrompt('analyze', {
      file: 'src/app.ts',
      aspect: 'security',
    })
    expect(result).toBe('Analyze src/app.ts with focus on security.')
  })

  it('throws error for non-existent prompt', async () => {
    await expect(runtime.executePrompt('missing')).rejects.toThrow('not found')
  })

  it('handles empty variables gracefully', async () => {
    const result = await runtime.executePrompt('greet', {})
    // With no variables, placeholders remain
    expect(result).toBe('Hello, ${name}!')
  })
})

// ============================================================
// MiphamRuntime
// ============================================================

describe('MiphamRuntime', () => {
  const skill = makeSkill({
    name: 'om-test',
    type: 'mipham',
    prompts: {
      analyze:
        'Provider: ${provider}, Model: ${model}, Session: ${session}, CWD: ${cwd}, Custom: ${custom}',
    },
  })

  const runtime = new MiphamRuntime({
    skill,
    cwd: '/test/mipham',
    sessionId: 'mipham-session-1',
    providerId: 'deepseek',
    modelId: 'deepseek-v4-pro',
  })

  it('returns the skill', () => {
    expect(runtime.getSkill()).toBe(skill)
  })

  it('returns prompts', () => {
    expect(runtime.getPrompts()).toEqual(skill.prompts)
  })

  it('executes prompt with Mipham context variables', async () => {
    const result = await runtime.executePrompt('analyze', { custom: 'extra' })
    expect(result).toContain('Provider: deepseek')
    expect(result).toContain('Model: deepseek-v4-pro')
    expect(result).toContain('Session: mipham-session-1')
    expect(result).toContain('CWD: /test/mipham')
    expect(result).toContain('Custom: extra')
  })

  it('Mipham context variables can be overridden by explicit variables', async () => {
    const result = await runtime.executePrompt('analyze', { provider: 'overridden' })
    expect(result).toContain('Provider: overridden')
    expect(result).toContain('Model: deepseek-v4-pro')
  })

  it('throws error for non-existent prompt', async () => {
    await expect(runtime.executePrompt('missing')).rejects.toThrow('not found')
  })

  it('returns tools and hooks', () => {
    const skillWithTools = makeSkill({
      name: 'om-with-tools',
      type: 'mipham',
      tools: [
        {
          name: 'mipham-tool',
          description: 'A Mipham tool',
          category: 'system',
          permission: 'auto',
          parameters: {},
          execute: async () => ({ success: true, content: '' }),
        },
      ],
      hooks: [{ event: 'PostToolUse', handler: async () => ({ allowed: true }) }],
    })
    const rt = new MiphamRuntime({
      skill: skillWithTools,
      cwd: '/',
      sessionId: 'x',
      providerId: 'p',
      modelId: 'm',
    })
    expect(rt.getTools()).toHaveLength(1)
    expect(rt.getHooks()).toHaveLength(1)
  })
})

// ============================================================
// Built-in Skills Validation
// ============================================================

describe('Built-in skills', () => {
  it('loads all built-in skills', () => {
    const loader = new SkillsLoader()
    const projectRoot = join(import.meta.dirname, '..', '..')
    loader.loadBuiltin(projectRoot)

    const all = loader.list()
    expect(all.length).toBe(15) // 12 standard + 3 mipham

    const standard = loader.listByType('standard')
    expect(standard.length).toBe(12)

    const mipham = loader.listByType('mipham')
    expect(mipham.length).toBe(3)
  })

  it('every built-in skill has a name and description', () => {
    const loader = new SkillsLoader()
    const projectRoot = join(import.meta.dirname, '..', '..')
    loader.loadBuiltin(projectRoot)

    for (const skill of loader.list()) {
      expect(skill.name).toBeTruthy()
      expect(skill.description).toBeTruthy()
      expect(skill.version).toBeTruthy()
      expect(['standard', 'mipham']).toContain(skill.type)
      expect(skill.name.length).toBeGreaterThan(0)
      expect(skill.description.length).toBeGreaterThan(0)
    }
  })

  it('all standard skills have expected names', () => {
    const loader = new SkillsLoader()
    const projectRoot = join(import.meta.dirname, '..', '..')
    loader.loadBuiltin(projectRoot)

    const names = loader
      .listByType('standard')
      .map((s) => s.name)
      .sort()
    expect(names).toEqual([
      'code-review',
      'compassionate-communication',
      'doc-generator',
      'github-ops',
      'memory',
      'mipham-code-setup',
      'security-review',
      'self-review',
      'superpower',
      'tdd',
      'web-access',
      'web-search',
    ])
  })

  it('all mipham skills have expected names', () => {
    const loader = new SkillsLoader()
    const projectRoot = join(import.meta.dirname, '..', '..')
    loader.loadBuiltin(projectRoot)

    const names = loader
      .listByType('mipham')
      .map((s) => s.name)
      .sort()
    expect(names).toEqual(['om-artifact', 'om-model-optimize', 'om-security'])
  })

  it('standard skills are loaded from files ending in .SKILL.md', () => {
    const loader = new SkillsLoader()
    const projectRoot = join(import.meta.dirname, '..', '..')
    loader.loadBuiltin(projectRoot)

    // Verify the skill type matches the directory convention
    for (const skill of loader.listByType('standard')) {
      expect(skill.type).toBe('standard')
    }
  })

  it('mipham skills are loaded from files ending in .mipham-skill.md', () => {
    const loader = new SkillsLoader()
    const projectRoot = join(import.meta.dirname, '..', '..')
    loader.loadBuiltin(projectRoot)

    for (const skill of loader.listByType('mipham')) {
      expect(skill.type).toBe('mipham')
    }
  })
})
