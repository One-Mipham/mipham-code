import { describe, it, expect } from 'vitest'
import { join, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
import { execSync } from 'node:child_process'
import {
  InstructionsLoader,
  stripSections,
  parsePromptExclude,
  gitRoot,
  discoverDirectories,
} from '../../src/core/instructions'

describe('InstructionsLoader.buildSystemPrompt', () => {
  it('injects the commit-attribution instruction (AI 署名披露)', () => {
    const prompt = new InstructionsLoader().buildSystemPrompt()
    expect(prompt).toContain('Commit Attribution')
    expect(prompt).toContain('Co-Authored-By: Mipham <noreply@mipham.ai>')
  })

  it('injects the greeting-restraint instruction (寒暄克制)', () => {
    const prompt = new InstructionsLoader().buildSystemPrompt()
    expect(prompt).toContain('Greeting Restraint')
    expect(prompt).toContain('Do NOT introduce yourself')
  })
})

describe('stripSections (prompt-exclude)', () => {
  it('strips a section from its heading to the next same-level heading, keeping the rest', () => {
    const doc = `# Rules
- keep this
## Changelog
- drop this
## Architecture
- keep arch`
    const out = stripSections(doc, ['Changelog'])
    expect(out).toContain('keep this')
    expect(out).toContain('keep arch')
    expect(out).not.toContain('drop this')
  })

  it('strips subheadings along with an excluded ## section', () => {
    const doc = `## 下一步计划
### 修订历史
- version table
## Keep
- kept`
    const out = stripSections(doc, ['下一步计划'])
    expect(out).toContain('kept')
    expect(out).not.toContain('version table')
    expect(out).not.toContain('修订历史')
  })

  it('returns the document unchanged when excluded is empty', () => {
    const doc = '## A\n- x\n## B\n- y'
    expect(stripSections(doc, [])).toBe(doc)
  })
})

describe('parsePromptExclude', () => {
  it('normalizes a YAML list, a single string, and absent value', () => {
    expect(parsePromptExclude(['最近提交', '下一步计划'])).toEqual(['最近提交', '下一步计划'])
    expect(parsePromptExclude('修订历史')).toEqual(['修订历史'])
    expect(parsePromptExclude(undefined)).toEqual([])
  })
})

describe('gitRoot', () => {
  it('falls back to cwd outside a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mipham-instr-'))
    try {
      expect(gitRoot(dir)).toBe(resolve(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('discoverDirectories', () => {
  it('returns [root] when cwd equals root', () => {
    expect(discoverDirectories('/repo', '/repo')).toEqual([resolve('/repo')])
  })
  it('walks root → cwd, nearest last', () => {
    expect(discoverDirectories('/repo', '/repo/apps/cli')).toEqual([
      resolve('/repo'),
      resolve('/repo/apps'),
      resolve('/repo/apps/cli'),
    ])
  })
  it('degrades to [cwd] when cwd is outside root', () => {
    expect(discoverDirectories('/repo', '/other')).toEqual([resolve('/other')])
  })
})

describe('InstructionsLoader.loadAll (AGENTS.md 多格式 + 递归)', () => {
  it('loads AGENTS.md alongside CLAUDE.md and MIPHAM.md, AGENTS first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mipham-instr-'))
    try {
      writeFileSync(join(dir, 'AGENTS.md'), '# AGENTS rules\n- agent rule')
      writeFileSync(join(dir, 'CLAUDE.md'), '# CLAUDE rules\n- claude rule')
      writeFileSync(join(dir, 'MIPHAM.md'), '# MIPHAM rules\n- mipham rule')
      const loader = new InstructionsLoader()
      loader.loadAll(dir)
      const files = loader.list().filter((f) => f.path.startsWith(dir))
      const names = files.map((f) => basename(f.path))
      expect(names).toContain('AGENTS.md')
      expect(names).toContain('CLAUDE.md')
      expect(names).toContain('MIPHAM.md')
      expect(names.indexOf('AGENTS.md')).toBeLessThan(names.indexOf('MIPHAM.md'))
      expect(names.indexOf('MIPHAM.md')).toBeLessThan(names.indexOf('CLAUDE.md'))
      expect(files.find((f) => basename(f.path) === 'AGENTS.md')!.level).toBe('project')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('recursively loads subdirectory AGENTS.md as directory level', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mipham-instr-')))
    try {
      execSync('git init -q', { cwd: root })
      writeFileSync(join(root, 'AGENTS.md'), '# root agents')
      mkdirSync(join(root, 'apps'))
      writeFileSync(join(root, 'apps', 'AGENTS.md'), '# apps agents')
      const loader = new InstructionsLoader()
      loader.loadAll(join(root, 'apps'))
      const list = loader.list()
      const rootAgents = list.find((f) => f.path === join(root, 'AGENTS.md'))
      const appsAgents = list.find((f) => f.path === join(root, 'apps', 'AGENTS.md'))
      expect(rootAgents!.level).toBe('directory')
      expect(appsAgents!.level).toBe('project')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
