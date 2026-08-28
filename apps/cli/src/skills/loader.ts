import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parse as parseYaml } from 'yaml'
import type { SkillDefinition } from '../shared/index.ts'
import type { Skills } from './seam'
import { sanitizeSkillDescription, sanitizeSkillBody, checkSkillShadow } from './sanitizer.js'
import { BUNDLED_SKILLS, type BundledSkill } from './bundled-skills'

interface FrontmatterResult {
  data: Record<string, unknown>
  content: string
}

export function parseFrontmatter(raw: string): FrontmatterResult {
  // Strip a leading UTF-8 BOM — otherwise `^---` never matches and a
  // BOM-prefixed file is silently treated as body text (effectively ignored).
  const src = raw.replace(/^\uFEFF/, '')
  const match = src.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) {
    return { data: {}, content: src }
  }
  return {
    data: parseYaml(match[1] || '') as Record<string, unknown>,
    content: match[2] || '',
  }
}

export class SkillsLoader implements Skills {
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

  /**
   * Load the built-in skills shipped alongside the app.
   *
   * Resolves the app root from this module's own location (`import.meta.dirname`),
   * NOT the process working directory. `process.cwd()` points to wherever the user
   * launched `mipham` from, so a cwd-relative lookup would silently miss the bundled
   * skills in npm-global and compiled-binary installs.
   */
  loadBuiltinFromPackage(): void {
    // loader.ts lives at <app-root>/src/skills/loader.ts → app root is two levels up
    const appRoot = join(import.meta.dirname!, '..', '..')
    this.loadBuiltin(appRoot)
    // Fallback for the standalone binary: it has no skills/ on disk, so read
    // the embedded snapshot bundled at compile time instead.
    if (this.skills.size === 0) {
      this.loadEmbedded(BUNDLED_SKILLS)
    }
  }

  /** Load skills from an in-memory snapshot (the compiled-binary fallback). */
  loadEmbedded(entries: ReadonlyArray<BundledSkill>): void {
    for (const { type, raw } of entries) {
      this.tryLoadRaw(raw, type, `embedded:${type}`)
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

  /** Load a single skill file by path (used by Claude plugins: `skills/<name>/SKILL.md`). */
  loadSkillFile(path: string, type: 'standard' | 'mipham' = 'standard'): void {
    this.tryLoad(path, type)
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
      this.tryLoadRaw(raw, type, path)
    } catch {
      // skip unparseable
    }
  }

  private tryLoadRaw(raw: string, type: 'standard' | 'mipham', sourceName: string): void {
    try {
      const { data, content } = parseFrontmatter(raw)

      const rawDescription = (data.description as string) || ''
      const rawBody = content.trim() || undefined
      const skillName = (data.name as string) || this.nameFromPath(sourceName)

      // ── Safety: check for command/MCP shadowing ──
      const shadowCheck = checkSkillShadow(skillName, rawDescription)
      if (shadowCheck.shadowed) {
        process.stderr.write(
          `⚠️  Skill "${skillName}" shadows ${shadowCheck.conflictType} "${shadowCheck.conflictsWith}" — skipped for safety. Rename the skill and reload.\n`,
        )
        return
      }

      // ── Safety: sanitize description ──
      const description = sanitizeSkillDescription(
        rawDescription,
        type === 'mipham' ? undefined : type,
      )

      // ── Safety: sanitize body ──
      let body: string | undefined
      if (rawBody) {
        const bodyResult = sanitizeSkillBody(rawBody)
        body = bodyResult.text
        if (bodyResult.warnings.length > 0) {
          process.stderr.write(
            `⚠️  Skill "${skillName}" body sanitized: ${bodyResult.warnings.join('; ')}\n`,
          )
        }
      }

      const skill: SkillDefinition = {
        name: skillName,
        description,
        version: (data.version as string) || '0.1.0',
        type,
        body,
        tools: data.tools as SkillDefinition['tools'],
        hooks: data.hooks as SkillDefinition['hooks'],
        prompts: data.prompts as SkillDefinition['prompts'],
        // NEW: frontmatter fields for fork/auto-trigger support
        context: data.context as string | undefined,
        model: data.model as string | undefined,
        allowedTools: data['allowed-tools'] as string[] | undefined,
        disableModelInvocation: data['disable-model-invocation'] as boolean | undefined,
        requiresBins: data['requires-bins'] as string[] | undefined,
      }

      this.skills.set(skill.name, skill)
    } catch {
      // skip unparseable
    }
  }

  /**
   * Build the system-reminder block listing every skill the AI may invoke via
   * the Skill tool. A single full listing keeps the whole catalog discoverable:
   * at session start there is no query to match against, so a keyword "recall"
   * would silently hide most skills. Capped at `maxTokens` to stay bounded.
   */
  buildSystemReminder(maxTokens: number = 5000): string {
    const selected = this.list().filter((s) => !s.disableModelInvocation)

    if (selected.length === 0) return ''

    const lines: string[] = [
      '<system-reminder>',
      'The following skills are available. Invoke via the Skill tool when relevant:',
    ]

    let tokenBudget = 0
    for (const skill of selected) {
      const safeDesc = sanitizeSkillDescription(skill.description, skill.type)
      const entry = `- ${skill.name}: ${safeDesc}`
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
