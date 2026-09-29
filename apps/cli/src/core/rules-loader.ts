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

import { readdirSync, readFileSync, existsSync, lstatSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { globToRegexSource } from './credential-masker/matcher'
import { findWorktreeMarker } from './paths.ts'
import { MIPHAM_DIR } from '../shared/constants.ts'

/**
 * 每个被拒的规则路径**只报告一次**（同 `core/permission-audit.ts` 的 `warnedOnce`）。
 *
 * 按路径去重而不是全局一次：两个坏文件是两件事。若只记一个全局布尔，daemon
 * 那条路径（`daemon/engine-capabilities.ts` 每会话新建一只 loader）会让第二个
 * 会话遇到同一个坏文件时一片沉默 —— 而「沉默」正是这里要消掉的东西。
 */
const reportedRefusals = new Set<string>()

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
  /** Project directory owning `rulesDir` — i.e. `rulesDir` is `<rulesRoot>/.mipham/rules`. */
  private rulesRoot: string
  /** Project directory owning `projectRulesDir`; unused when that is `null`. */
  private projectRoot: string

  constructor(cwd: string) {
    this.rulesRoot = cwd
    this.rulesDir = join(cwd, MIPHAM_DIR, 'rules')
    const marker = findWorktreeMarker(cwd)
    const projectRulesDir = marker ? join(marker.root, MIPHAM_DIR, 'rules') : null
    this.projectRulesDir = projectRulesDir === this.rulesDir ? null : projectRulesDir
    this.projectRoot = marker?.root ?? cwd
  }

  /**
   * Load all rules from .mipham/rules/. Call once at startup.
   */
  load(): void {
    this.rules = []
    this.readDir(this.rulesDir, this.rulesRoot)
    if (this.projectRulesDir) this.readDir(this.projectRulesDir, this.projectRoot)
  }

  /**
   * Read every `.md` in `dir` into `this.rules`. A name already loaded wins —
   * "nearest first": a rule the worktree defines overrides the project copy.
   *
   * `root` is the project directory that owns `dir` (i.e. `dir` is exactly
   * `<root>/.mipham/rules`); it bounds what a symlink may resolve to.
   *
   * ### Why every path here is checked before it is read
   *
   * A rule's body is injected into the conversation **verbatim** and shipped to
   * the model provider. So `.mipham/rules/*.md` is not just config — it is an
   * **egress** path that the repository alone controls, and `readFileSync` is
   * the point where a name becomes content. Three shapes are refused:
   *
   * 1. **The rules directory reached through a symlink** — `.mipham/rules ->
   *    ~/.mipham/memory` would inject the user's private notes as project
   *    rules. It has to be checked on the *directory*: `.mipham` is one segment
   *    above the entries, so no per-entry check can see it.
   * 2. **A symlinked rule file** — `-> ~/.ssh/id_rsa`, `-> ../../.env`. Note
   *    that "resolve it and require the target to be inside the project" is
   *    *not* a safe rule: the project root is exactly where the user's own
   *    gitignored secrets live. A rule must be a plain file, not a link.
   * 3. **A non-regular file** — `readFileSync` on a FIFO blocks until a writer
   *    appears, and `/dev/zero` reads unboundedly: both *synchronously*, at
   *    startup. Same family as the audited non-regular-file hang on the daemon
   *    token path.
   *
   * Refusals are **reported, not skipped silently** (once per path, on stderr —
   * this repo's warning channel). The rules directory exists so that its
   * contents are always obeyed; a rule that is present but not loaded must say
   * so. `config/loader.ts`'s `stripProjectPermission` made the same call.
   *
   * Honest boundary: in *this* repo `.mipham/` is gitignored, so these entries
   * cannot be committed from here — the surface is a project that tracks
   * `.mipham/` (or one where the file is placed on disk by other means). And
   * the check is not TOCTOU-proof: it holds at the moment of the `lstat`.
   */
  private readDir(dir: string, root: string): void {
    if (!existsSync(dir)) return

    // Resolved against the *resolved* root, so a symlink anywhere above the
    // project (macOS `/var -> /private/var`, a symlinked home) is not counted —
    // only the `<root>/.mipham/rules` tail has to be link-free.
    try {
      if (realpathSync(dir) !== join(realpathSync(root), MIPHAM_DIR, 'rules')) {
        this.refuse(dir, '规则目录不是本工程的真实目录（路径中有符号链接）')
        return
      }
    } catch {
      this.refuse(dir, '无法解析规则目录的真实路径')
      return
    }

    try {
      const seen = new Set(this.rules.map((r) => r.name))
      const files = readdirSync(dir).filter((f) => f.endsWith('.md'))
      for (const file of files) {
        const name = file.replace(/\.md$/, '')
        if (seen.has(name)) continue
        const full = join(dir, file)

        let entry
        try {
          entry = lstatSync(full)
        } catch {
          this.refuse(full, '无法读取文件状态')
          continue
        }
        // `lstat` (not `stat`) — so a symlink reports as itself, not as its
        // target. The `isFile` gate below would refuse a link anyway (a link is
        // not a regular file); this branch exists to say **which** shape it was,
        // because "refused" with the wrong reason is its own kind of silent.
        if (entry.isSymbolicLink()) {
          this.refuse(full, '是符号链接 —— 规则必须是普通文件')
          continue
        }
        if (!entry.isFile()) {
          this.refuse(full, '不是普通文件（目录／FIFO／设备）')
          continue
        }

        try {
          const raw = readFileSync(full, 'utf-8')
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

  /** Report a refused rule path once per process, on stderr. */
  private refuse(path: string, reason: string): void {
    if (reportedRefusals.has(path)) return
    reportedRefusals.add(path)
    process.stderr.write(`⚠️  规则未被加载（之后不再重复报告）: ${path} — ${reason}\n`)
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
