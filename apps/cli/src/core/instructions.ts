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

  buildSystemPrompt(): string {
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

    return parts.join('\n\n---\n\n')
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
