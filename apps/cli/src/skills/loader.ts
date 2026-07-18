import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
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

  countByType(): { standard: number; mipham: number; total: number } {
    const all = this.list()
    return {
      standard: all.filter((s) => s.type === 'standard').length,
      mipham: all.filter((s) => s.type === 'mipham').length,
      total: all.length,
    }
  }

  getNamesByType(type: 'standard' | 'mipham'): string[] {
    return this.listByType(type).map((s) => s.name)
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
        // NEW: frontmatter fields for fork/auto-trigger support
        context: data.context as string | undefined,
        model: data.model as string | undefined,
        allowedTools: data['allowed-tools'] as string[] | undefined,
        disableModelInvocation: data['disable-model-invocation'] as boolean | undefined,
        userInvocable: data['user-invocable'] as boolean | undefined,
      }

      this.skills.set(skill.name, skill)
    } catch {
      // skip unparseable
    }
  }

  /**
   * Build the system-reminder block for AI auto-triggering.
   * Injects available skill names + descriptions so the AI can match
   * user requests to relevant skills.
   */
  buildSystemReminder(maxTokens: number = 5000): string {
    const skills = this.list().filter((s) => {
      // Skip skills that disable model invocation
      return !s.disableModelInvocation
    })

    if (skills.length === 0) return ''

    const lines: string[] = [
      '<system-reminder>',
      'The following skills are available. Invoke via the Skill tool when relevant:',
    ]

    let tokenBudget = 0
    for (const skill of skills) {
      const entry = `- ${skill.name}: ${skill.description}`
      const entryTokens = Math.ceil(entry.length / 4) + 1 // rough estimate
      if (tokenBudget + entryTokens > maxTokens) break

      lines.push(entry)
      tokenBudget += entryTokens
    }

    lines.push('</system-reminder>')
    return lines.join('\n')
  }

  /** Load skills from ~/.mipham/skills/ (user home directory). */
  loadUserSkills(): void {
    const home = homedir()
    const userSkillsPath = join(home, '.mipham', 'skills')
    this.loadExternal([userSkillsPath])
  }

  private nameFromPath(path: string): string {
    const base = path.split('/').pop() || ''
    return base.replace(/\.(SKILL|mipham-skill)\.md$/i, '')
  }
}
