import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { SkillDefinition } from '../shared/index.ts'
import type { Skills } from './seam'
import { sanitizeSkillDescription, sanitizeSkillBody, checkSkillShadow } from './sanitizer.js'
import { BUNDLED_SKILLS, type BundledSkill } from './bundled-skills'
import { miphamHome } from '../core/paths.ts'

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

/**
 * Skill names are interpolated verbatim into the `<system-reminder>` block and
 * used as the map key for the Skill tool. A name carrying control characters,
 * bidirectional/format controls, line separators, exotic spaces or angle
 * brackets can forge reminder lines or make the listing unreadable.
 *
 * Returns a short reason when the name is unusable, null when it is fine.
 * Callers reject rather than strip: a name the author did not choose is worse
 * than falling back to the path-derived name.
 */
export function invalidSkillNameReason(name: string): string | null {
  if (!name.trim()) return 'empty name'
  if (/[\p{Cc}\p{Cf}<>]/u.test(name)) return 'control, format or angle-bracket characters'
  if (/[\p{Zl}\p{Zp}]/u.test(name)) return 'line/paragraph separators'
  if (/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/u.test(name)) return 'non-ASCII spacing'
  return null
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

      // Name gate (see `invalidSkillNameReason`). A declared name that fails is
      // ignored in favour of the path-derived one; if that fails too the skill
      // is skipped. Only a string counts — `name: 42` is a malformed declaration,
      // not a name.
      const declaredName = typeof data.name === 'string' ? data.name.trim() : ''
      let skillName = ''
      if (declaredName) {
        const reason = invalidSkillNameReason(declaredName)
        if (reason) {
          process.stderr.write(
            `⚠️  Skill at ${sourceName}: frontmatter name rejected (${reason}) — using the path-derived name.\n`,
          )
        } else {
          skillName = declaredName
        }
      }
      if (!skillName) {
        skillName = this.nameFromPath(sourceName)
        const reason = invalidSkillNameReason(skillName)
        if (reason) {
          process.stderr.write(
            `⚠️  Skill at ${sourceName}: path-derived name rejected (${reason}) — skipped.\n`,
          )
          return
        }
      }

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
        hooks: parseSkillHooks(data.hooks, skillName),
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
   *
   * `mode` controls the startup token budget:
   * - `full` (default): name + full description
   * - `compact`: name + description collapsed to one short line
   * - `off`: no reminder at all
   */
  buildSystemReminder(maxTokens: number = 5000, mode: 'full' | 'compact' | 'off' = 'full'): string {
    if (mode === 'off') return ''

    const selected = this.list().filter((s) => !s.disableModelInvocation)

    if (selected.length === 0) return ''

    const lines: string[] = [
      '<system-reminder>',
      'The following skills are available. Invoke via the Skill tool when relevant:',
    ]

    let tokenBudget = 0
    for (const skill of selected) {
      const safeDesc = sanitizeSkillDescription(skill.description, skill.type)
      const desc = mode === 'compact' ? truncateSkillDescription(safeDesc) : safeDesc
      const entry = `- ${skill.name}: ${desc}`
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
    const userSkillsPath = miphamHome('skills')
    this.loadExternal([userSkillsPath])
  }

  private nameFromPath(path: string): string {
    const parts = path.split('/').filter(Boolean)
    const base = parts.pop() ?? ''
    // `foo.SKILL.md` / `foo.mipham-skill.md` — the file name carries the skill.
    const stem = base.replace(/\.md$/i, '').replace(/\.(SKILL|mipham-skill)$/i, '')
    if (stem && stem !== 'SKILL' && stem !== 'mipham-skill') return stem
    // Directory layout (`skills/<name>/SKILL.md`, the Claude-plugin shape). Every
    // one of these files is literally named `SKILL.md`, so the file name names
    // nothing — they all collide on one key and the last loaded silently wins.
    // The folder is the name. Skip the `skills` bucket itself so a flat
    // `skills/SKILL.md` falls through to the plugin directory above it.
    let dir = parts.pop()
    while (dir === 'skills') dir = parts.pop()
    return dir || base
  }
}

/**
 * 只接受**真带 handler** 的技能钩子。
 *
 * YAML 里没有闭包，所以技能 frontmatter 写的 `hooks:` 到这一步只是数据，`handler`
 * 恒为 `undefined`（`as` 断言把类型骗过去了）。原样注册的后果不是「钩子不生效」，
 * 是**每一个工具调用都被拒**：`runHooks` 调 `undefined(ctx)` 抛 TypeError，而
 * PreToolUse 的守卫是 fail-closed —— 引擎把它读成「守卫答不出来」，于是整场会话
 * 的每一次工具调用都返回拒绝。插件路径交进来的钩子带真 handler，照常放行。
 */
function parseSkillHooks(raw: unknown, skillName: string): SkillDefinition['hooks'] {
  if (!Array.isArray(raw)) return undefined

  const accepted: SkillDefinition['hooks'] = []
  for (const entry of raw) {
    const handler = (entry as { handler?: unknown } | null)?.handler
    if (typeof handler === 'function') {
      accepted.push({
        ...(entry as object),
        source: skillName,
      } as NonNullable<SkillDefinition['hooks']>[number])
      continue
    }
    process.stderr.write(
      `⚠️  Skill "${skillName}": a hook entry has no handler (frontmatter cannot carry ` +
        `functions) — ignored. Declare the hook in settings.json instead.\n`,
    )
  }
  return accepted.length > 0 ? accepted : undefined
}

const COMPACT_DESC_MAX_CHARS = 80

/**
 * Collapse a description to a single short line.
 *
 * Used both by the compact system reminder and by the human-facing `/skills`
 * listing: skill descriptions are written for the *model* and are often
 * several paragraphs of instructions. Pasting that into a terminal listing
 * turns three skills into a screenful; the first line + an ellipsis is the
 * honest short form (there is no separate short-description field to read).
 */
export function truncateSkillDescription(desc: string): string {
  const firstLine = desc.split('\n')[0]?.trim() ?? ''
  return firstLine.length > COMPACT_DESC_MAX_CHARS
    ? firstLine.slice(0, COMPACT_DESC_MAX_CHARS) + '…'
    : firstLine
}
