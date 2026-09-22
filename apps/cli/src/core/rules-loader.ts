/**
 * RulesLoader — path-scoped rules from .mipham/rules/.
 *
 * Rules are markdown files with YAML frontmatter. They are injected into
 * the conversation when the AI touches matching files.
 *
 * Directory structure:
 *   .mipham/rules/
 *     always.md        — always loaded (no paths filter)
 *     typescript.md    — loaded when touching *.ts files
 *     security.md      — loaded when touching auth/ or crypto/ paths
 *
 * Frontmatter:
 *   ---
 *   paths: "apps/cli/src/**\/*.ts"
 *   description: TypeScript coding standards
 *   ---
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { globToRegexSource } from './credential-masker/matcher'
import { findWorktreeMarker } from './paths.ts'
import { MIPHAM_DIR } from '../shared/constants.ts'

interface RuleFile {
  name: string
  paths: string[] // glob patterns, empty = always loaded
  description: string
  content: string
}

export class RulesLoader {
  private rules: RuleFile[] = []
  private rulesDir: string
  /**
   * Rules directory of the **project the cwd belongs to**, when cwd sits inside
   * one of our worktrees; `null` otherwise.
   *
   * `.mipham/` is gitignored, so a worktree checkout never contains
   * `.mipham/rules` — `git worktree add .mipham/worktrees/w1` produces a tree
   * with no `.mipham/` at all (measured). Reading only `cwd` therefore made
   * every project rule invisible inside a worktree session, **silently**: zero
   * rules, no warning, empty context block.
   *
   * Detection is marker-based (`findWorktreeMarker`, the same one the git/bash
   * tools use) — a worktree created outside `.mipham/worktrees/` and
   * `.claude/worktrees/` is not covered.
   */
  private projectRulesDir: string | null

  constructor(cwd: string) {
    this.rulesDir = join(cwd, MIPHAM_DIR, 'rules')
    const marker = findWorktreeMarker(cwd)
    const projectRulesDir = marker ? join(marker.root, MIPHAM_DIR, 'rules') : null
    this.projectRulesDir = projectRulesDir === this.rulesDir ? null : projectRulesDir
  }

  /**
   * Load all rules from .mipham/rules/. Call once at startup.
   */
  load(): void {
    this.rules = []
    this.readDir(this.rulesDir)
    if (this.projectRulesDir) this.readDir(this.projectRulesDir)
  }

  /**
   * Read every `.md` in `dir` into `this.rules`. A name already loaded wins —
   * "nearest first": a rule the worktree defines overrides the project copy.
   */
  private readDir(dir: string): void {
    if (!existsSync(dir)) return
    try {
      const seen = new Set(this.rules.map((r) => r.name))
      const files = readdirSync(dir).filter((f) => f.endsWith('.md'))
      for (const file of files) {
        const name = file.replace(/\.md$/, '')
        if (seen.has(name)) continue
        try {
          const raw = readFileSync(join(dir, file), 'utf-8')
          const { paths, description, content } = this.parseRule(raw, file)
          this.rules.push({ name, paths, description, content })
          seen.add(name)
        } catch {
          // Skip unparseable files
        }
      }
    } catch {
      // Directory read error — rules unavailable
    }
  }

  /**
   * Get rules that match the given file paths.
   * Rules with no paths filter ("always") are always included.
   */
  getMatchingRules(touchedFiles: string[]): RuleFile[] {
    const matched: RuleFile[] = []

    for (const rule of this.rules) {
      // Always rules — no paths filter
      if (rule.paths.length === 0) {
        matched.push(rule)
        continue
      }

      // Check if any touched file matches any rule path pattern
      for (const file of touchedFiles) {
        for (const pattern of rule.paths) {
          if (this.matchPath(file, pattern)) {
            matched.push(rule)
            // Break inner loops — rule already matched
            break
          }
        }
        if (matched.includes(rule)) break
      }
    }

    return matched
  }

  /**
   * Build a context block to inject into the conversation.
   */
  buildContextBlock(touchedFiles: string[]): string {
    const matched = this.getMatchingRules(touchedFiles)
    if (matched.length === 0) return ''

    const blocks = matched.map(
      (r) => `[Rule: ${r.name}]${r.description ? ` — ${r.description}` : ''}\n${r.content}`,
    )
    return `\n<!-- Path-scoped rules matching: ${touchedFiles.join(', ')} -->\n${blocks.join('\n\n')}\n`
  }

  /**
   * Count loaded rules.
   */
  count(): number {
    return this.rules.length
  }

  /**
   * List loaded rule names.
   */
  list(): string[] {
    return this.rules.map((r) => r.name)
  }

  /**
   * Glob matching for path-scoped rules. Reuses the shared path-glob core
   * (globToRegexSource) so `*`/`**`/`?` semantics match credential-file
   * matching. Anchoring differs: rules match by *suffix* (a rule `*.ts`
   * applies to any file ending in `.ts`), not full path.
   */
  private matchPath(file: string, pattern: string): boolean {
    let regexStr = globToRegexSource(pattern)

    // If pattern doesn't start with ** or *, anchor to a suffix match
    if (!pattern.startsWith('**') && !pattern.startsWith('*')) {
      regexStr = regexStr + '$'
    }

    try {
      return new RegExp(regexStr).test(file)
    } catch {
      // Invalid pattern — fallback to simple includes
      return file.includes(pattern.replace(/\*\*/g, '').replace(/\*/g, ''))
    }
  }

  /**
   * Parse a rule file — extract frontmatter and body.
   */
  private parseRule(
    raw: string,
    _filename: string,
  ): { paths: string[]; description: string; content: string } {
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
    if (!match) {
      return { paths: [], description: '', content: raw.trim() }
    }

    const frontmatter = match[1] || ''
    const body = (match[2] || '').trim()

    const paths: string[] = []
    let description = ''

    for (const line of frontmatter.split('\n')) {
      const pathMatch = line.match(/^paths:\s*"(.+)"$/)
      if (pathMatch) {
        pathMatch[1]!.split(',').forEach((p) => paths.push(p.trim()))
      }
      const descMatch = line.match(/^description:\s*(.+)$/)
      if (descMatch) {
        description = descMatch[1]!.trim()
      }
    }

    return { paths, description, content: body }
  }
}
