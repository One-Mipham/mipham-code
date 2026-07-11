import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, extname } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { AgentDefinition, SubAgentType } from './types'

interface FrontmatterResult {
  data: Record<string, unknown>
  content: string
}

function parseFrontmatter(raw: string): FrontmatterResult {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) {
    return { data: {}, content: raw }
  }
  return {
    data: parseYaml(match[1] || '') as Record<string, unknown>,
    content: (match[2] || '').trim(),
  }
}

const BUILTIN_SYSTEM_PROMPTS: Record<SubAgentType, string> = {
  general: 'You are a focused sub-agent. Complete the assigned task thoroughly and return results.',
  explore:
    'You are an exploration sub-agent. Search, read, and analyze code. Return structured findings with file paths and line numbers.',
  plan: 'You are a planning sub-agent. Design implementation approaches. Return a step-by-step plan with files to modify.',
  'code-review':
    'You are a code review sub-agent. Find bugs, security issues, and code quality problems. Return findings by severity.',
}

const BUILTIN_DESCRIPTIONS: Record<SubAgentType, string> = {
  general: 'General-purpose agent for complex multi-step tasks.',
  explore: 'Read-only search agent for broad fan-out searches across files.',
  plan: 'Software architect agent for designing implementation plans.',
  'code-review': 'Code review agent for finding bugs and quality issues.',
}

export class AgentRegistry {
  private agents = new Map<string, AgentDefinition>()

  /** Load agents from a directory. Later loads override earlier ones for same name. */
  loadDirectory(dir: string, source: 'project' | 'user'): void {
    if (!existsSync(dir)) return

    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      // Permission errors, missing dir, etc.
      return
    }

    for (const entry of entries) {
      if (extname(entry) !== '.md') continue
      const fullPath = join(dir, entry)
      try {
        const raw = readFileSync(fullPath, 'utf-8')
        const { data, content } = parseFrontmatter(raw)

        const name = (data.name as string) || entry.replace(/\.md$/, '')
        const def: AgentDefinition = {
          name,
          description: (data.description as string) || '',
          systemPrompt: content,
          tools: data.tools as string | undefined,
          disallowedTools: data.disallowedTools as string | undefined,
          model: (data.model as string) || 'inherit',
          permissionMode: (data.permissionMode as string) || 'inherit',
          maxTurns: data.maxTurns as number | undefined,
          skills: data.skills
            ? String(data.skills)
                .split(',')
                .map((s) => s.trim())
            : undefined,
          background: (data.background as boolean) || false,
          source,
          filePath: fullPath,
        }

        this.agents.set(name, def)
      } catch {
        // Skip unparseable files
      }
    }
  }

  /** Load project-level agents from .mipham/agents/ */
  loadProjectAgents(cwd: string): void {
    this.loadDirectory(join(cwd, '.mipham', 'agents'), 'project')
  }

  /** Load user-level agents from ~/.mipham/agents/ */
  loadUserAgents(): void {
    const home = homedir()
    this.loadDirectory(join(home, '.mipham', 'agents'), 'user')
  }

  /** Get a custom agent by name. Returns undefined for builtins. */
  get(name: string): AgentDefinition | undefined {
    return this.agents.get(name)
  }

  /** List all custom agents. */
  list(): AgentDefinition[] {
    return Array.from(this.agents.values())
  }

  /**
   * Resolve an agent name to its definition.
   * Priority: custom (project) > custom (user) > builtin.
   * Builtins are always available and never return undefined.
   */
  resolve(name: string): AgentDefinition | undefined {
    const custom = this.agents.get(name)
    if (custom) return custom

    // Check if it's a builtin type
    const builtinType = name as SubAgentType
    if (BUILTIN_SYSTEM_PROMPTS[builtinType]) {
      return {
        name: builtinType,
        description: BUILTIN_DESCRIPTIONS[builtinType],
        systemPrompt: BUILTIN_SYSTEM_PROMPTS[builtinType],
        model: 'inherit',
        permissionMode: 'inherit',
        background: false,
        source: 'builtin',
      }
    }

    return undefined
  }
}
