import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { InstructionFile } from '../shared/index.ts'

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

export class InstructionsLoader {
  private instructions: InstructionFile[] = []
  private skillsReminder = ''

  loadAll(cwd: string): void {
    this.instructions = []

    // Tier 1: Ancestor-level CLAUDE.md (for Claude Code compatibility)
    // ../../ = Rismed_Ronxin_Capital
    this.tryLoad(join(cwd, '..', '..', 'CLAUDE.md'), 'group')
    // ../ = One_Mipham_Corporation
    this.tryLoad(join(cwd, '..', 'CLAUDE.md'), 'company')

    // Tier 1b: Group-level MIPHAM.md — One_Mipham_Corporation is the root
    this.tryLoad(join(cwd, '..', 'MIPHAM.md'), 'group')

    // Tier 2: Project-level (CLAUDE.md + MIPHAM.md at cwd)
    this.tryLoad(join(cwd, 'MIPHAM.md'), 'project')
    this.tryLoad(join(cwd, 'CLAUDE.md'), 'project')

    // Tier 2b: Directory-level MIPHAM.md (recursive, up to 3 levels)
    this.tryLoadRecursive(cwd, 'directory')

    // Tier 3: User-level ~/.mipham/USER.md
    const home = process.env.HOME || '~'
    this.tryLoad(join(home, '.mipham', 'USER.md'), 'user')
  }

  buildSystemPrompt(permissionMode?: string): string {
    const parts: string[] = []

    for (const inst of this.instructions) {
      const levelLabel: Record<string, string> = {
        group: 'Group Policy',
        company: 'Company Policy',
        project: 'Project Rules',
        directory: 'Directory Rules',
        user: 'User Preferences',
      }
      parts.push(`<!-- ${levelLabel[inst.level] || inst.level} (${inst.path}) -->\n${inst.content}`)
    }

    // P2-2: Inject current permission mode so the model knows its constraints
    if (permissionMode) {
      parts.push(this.buildPermissionContext(permissionMode))
    }

    // Append skills reminder after all instructions
    if (this.skillsReminder) {
      parts.push(this.skillsReminder)
    }

    // Inject workflow auto-generation guidance
    parts.push(`## Workflow Auto-Generation

When a task involves 3+ independent subtasks, multi-file operations,
or unknown-size discovery, generate a workflow script and execute it
via the Workflow tool instead of running agents sequentially. The
orchestration itself is code (zero tokens for inter-agent coordination).

Prefer workflows for: audits across many files, web research with multiple
sources, code migrations touching many files, security scans, bug hunts
with unknown scope, multi-dimensional code reviews.

Available primitives: agent(), parallel(), pipeline(), verify(),
judge(), loopUntilConvergence(), phase(), log(), args, budget.

Key rules:
- Default to pipeline() — only use parallel() barrier when a stage
  genuinely needs all prior results at once
- Edge logic (flatten, dedupe, filter) is plain JS — not agent calls
- Use verify() on edges where confidence matters
- Use loopUntilConvergence() for discovery tasks with unknown size

When a workflow completes successfully, offer to save it:
"Workflow complete. Save this script? /workflow save <name>"

Script format: export const meta = { name, description, phases: [...] }
// script body using primitives...`)

    return parts.join('\n\n---\n\n')
  }

  /** Set the skills system-reminder block to inject into the system prompt. */
  setSkillsReminder(reminder: string): void {
    this.skillsReminder = reminder
  }

  /**
   * P2-2: Build a permission-mode context block for the system prompt.
   * Tells the model its current permission level and what to expect.
   */
  private buildPermissionContext(mode: string): string {
    const modeDescriptions: Record<string, string> = {
      default: 'You are in **default** mode. Tools marked as requiring approval will be blocked. Use Read/Grep/Glob for exploration.',
      acceptEdits: 'You are in **acceptEdits** mode. File reads and edits are allowed; Bash requires approval.',
      plan: 'You are in **plan** mode. Only Read/Grep/Glob are allowed — no file modifications or command execution.',
      auto: 'You are in **auto** mode. Most tools run without approval. If a tool is blocked by security policy or hooks, try a different approach instead of retrying.',
      dontAsk: 'You are in **dontAsk** mode. All tools blocked unless explicitly allowlisted. Check your allow rules before acting.',
      bypassPermissions: 'You are in **bypassPermissions** mode. All tools are allowed. Use this power responsibly.',
    }

    const description = modeDescriptions[mode]
    if (!description) return ''

    return `## Permission Context\n\n${description}\n\nWhen a tool is denied, do NOT retry with the same tool and similar parameters. Move on to a different approach or ask the user for guidance.`
  }

  list(): InstructionFile[] {
    return [...this.instructions]
  }

  private tryLoad(path: string, level: InstructionFile['level']): void {
    if (!existsSync(path)) return

    try {
      const raw = readFileSync(path, 'utf-8')
      const { data, content } = parseFrontmatter(raw)
      this.instructions.push({
        path,
        level,
        privacy: (data.privacy as InstructionFile['privacy']) || 'project',
        language: (data.language as string) || 'en-US',
        content,
        frontmatter: data,
      })
    } catch {
      // Silently skip unreadable files
    }
  }

  private tryLoadRecursive(dir: string, level: InstructionFile['level']): void {
    const maxDepth = 3

    const walk = (current: string, depth: number) => {
      if (depth > maxDepth) return

      // Check for MIPHAM.md in this directory
      const miphamPath = join(current, 'MIPHAM.md')
      if (existsSync(miphamPath) && current !== dir) {
        this.tryLoad(miphamPath, level)
      }
      // Also check for CLAUDE.md
      const claudeMdPath = join(current, 'CLAUDE.md')
      if (existsSync(claudeMdPath) && current !== dir) {
        this.tryLoad(claudeMdPath, level)
      }

      try {
        const items = readdirSync(current, { withFileTypes: true })
        for (const item of items) {
          if (
            item.isDirectory() &&
            !item.name.startsWith('.') &&
            item.name !== 'node_modules' &&
            item.name !== 'dist' &&
            item.name !== '.next'
          ) {
            walk(join(current, item.name), depth + 1)
          }
        }
      } catch {
        // skip unreadable directories
      }
    }

    walk(dir, 0)
  }
}
