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
import { join, relative } from 'node:path'

interface RuleFile {
  name: string
  paths: string[] // glob patterns, empty = always loaded
  description: string
  content: string
}

export class RulesLoader {
  private rules: RuleFile[] = []
  private rulesDir: string

  constructor(cwd: string) {
    this.rulesDir = join(cwd, '.mipham', 'rules')
  }

  /**
   * Load all rules from .mipham/rules/. Call once at startup.
   */
  load(): void {
    this.rules = []
    if (!existsSync(this.rulesDir)) return

    try {
      const files = readdirSync(this.rulesDir).filter((f) => f.endsWith('.md'))
      for (const file of files) {
        const filepath = join(this.rulesDir, file)
        try {
          const raw = readFileSync(filepath, 'utf-8')
          const { paths, description, content } = this.parseRule(raw, file)
          this.rules.push({ name: file.replace(/\.md$/, ''), paths, description, content })
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
   * Simple glob matching. Supports **, *, and exact file matching.
   * Returns true if file matches pattern.
   */
  private matchPath(file: string, pattern: string): boolean {
    // Convert glob pattern to regex
    let regexStr = pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '<<GLOBSTAR>>')
      .replace(/\*/g, '[^/]*')
      .replace(/<<GLOBSTAR>>/g, '.*')

    // If pattern doesn't start with ** or *, anchor to be a suffix match
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
    filename: string,
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
