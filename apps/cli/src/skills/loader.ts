import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { SkillDefinition } from '../shared/index.ts'

interface FrontmatterResult {
  data: Record<string, unknown>
  content: string
}

function parseFrontmatter(raw: string): FrontmatterResult {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) {
    return { data: {}, content: raw }
  }
  return {
    data: parseYaml(match[1] || '') as Record<string, unknown>,
    content: match[2] || '',
  }
}

export class SkillsLoader {
  private skills = new Map<string, SkillDefinition>()

  loadBuiltin(basePath: string): void {
    // Load standard skills (*.SKILL.md)
    const standardDir = join(basePath, 'skills', 'standard')
    if (existsSync(standardDir)) {
      this.loadDirectory(standardDir, 'standard')
    }

    // Load mipham skills (*.mipham-skill.md)
    const miphamDir = join(basePath, 'skills', 'mipham')
    if (existsSync(miphamDir)) {
      this.loadDirectory(miphamDir, 'mipham')
    }
  }

  loadExternal(paths: string[]): void {
    for (const p of paths) {
      if (existsSync(p)) {
        const stat = statSync(p)
        if (stat.isDirectory()) {
          this.loadDirectory(p, 'standard')
        } else if (stat.isFile()) {
          this.tryLoad(p, 'standard')
        }
      }
    }
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name)
  }

  list(): SkillDefinition[] {
    return Array.from(this.skills.values())
  }

  listByType(type: 'standard' | 'mipham'): SkillDefinition[] {
    return Array.from(this.skills.values()).filter((s) => s.type === type)
  }

  has(name: string): boolean {
    return this.skills.has(name)
  }

  private loadDirectory(dir: string, type: 'standard' | 'mipham'): void {
    try {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        const fullPath = join(dir, entry)
        const isSkillFile = entry.endsWith('.SKILL.md') || entry.endsWith('.mipham-skill.md')

        if (isSkillFile) {
          this.tryLoad(fullPath, type)
        }
      }
    } catch {
      // skip unreadable
    }
  }

  private tryLoad(path: string, type: 'standard' | 'mipham'): void {
    try {
      const raw = readFileSync(path, 'utf-8')
      const { data } = parseFrontmatter(raw)

      const skill: SkillDefinition = {
        name: (data.name as string) || this.nameFromPath(path),
        description: (data.description as string) || '',
        version: (data.version as string) || '0.1.0',
        type,
        tools: data.tools as SkillDefinition['tools'],
        hooks: data.hooks as SkillDefinition['hooks'],
        prompts: data.prompts as SkillDefinition['prompts'],
      }

      this.skills.set(skill.name, skill)
    } catch {
      // skip unparseable
    }
  }

  private nameFromPath(path: string): string {
    const base = path.split('/').pop() || ''
    return base.replace(/\.(SKILL|mipham-skill)\.md$/i, '')
  }
}
