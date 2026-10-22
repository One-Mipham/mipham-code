import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { AgentDefinition, SubAgentType } from './types'
import { miphamHome } from '../core/paths.ts'
import { MIPHAM_DIR } from '../shared/constants.ts'

interface FrontmatterResult {
  data: Record<string, unknown>
  content: string
}

function parseFrontmatter(raw: string): FrontmatterResult {
  // Strip a leading UTF-8 BOM — otherwise `^---` never matches and a
  // BOM-prefixed file is silently treated as body text (effectively ignored).
  const src = raw.replace(/^\uFEFF/, '')
  const match = src.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) {
    return { data: {}, content: src }
  }
  return {
    data: parseYaml(match[1] || '') as Record<string, unknown>,
    content: (match[2] || '').trim(),
  }
}

/** `autoCompactWindow` 的合法区间：小到 0 是「一直压」，大到超过任何窗口都是笔误。 */
const MIN_COMPACT_WINDOW = 1_000
const MAX_COMPACT_WINDOW = 2_000_000

/**
 * 解析 agent 定义里的 `autoCompactWindow`，接受 `200000`、`200k`、`1M` 三种写法。
 *
 * 先前只吃 `number`，字符串被**静默**丢成 `undefined` —— 于是 `autoCompactWindow: 200k`
 * 的代理从不收缩，而且没有任何一处说它被忽略了。一个声明被吞掉时，至少要说一声。
 */
export function parseTokenWindow(value: unknown, agentName: string): number | undefined {
  if (value === undefined || value === null) return undefined

  let parsed: number | undefined
  if (typeof value === 'number') {
    parsed = value
  } else if (typeof value === 'string') {
    const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM])?$/)
    if (m) {
      const scale = m[2] ? (/m/i.test(m[2]) ? 1_000_000 : 1_000) : 1
      parsed = Math.round(parseFloat(m[1]!) * scale)
    }
  }

  if (parsed === undefined) {
    console.warn(
      `⚠ Agent "${agentName}": autoCompactWindow "${String(value)}" is not a number ` +
        `(${MIN_COMPACT_WINDOW}–${MAX_COMPACT_WINDOW}, or 200k / 1M). Ignored.`,
    )
    return undefined
  }
  if (parsed < MIN_COMPACT_WINDOW || parsed > MAX_COMPACT_WINDOW) {
    console.warn(
      `⚠ Agent "${agentName}": autoCompactWindow ${parsed} is outside ` +
        `${MIN_COMPACT_WINDOW}–${MAX_COMPACT_WINDOW}. Ignored.`,
    )
    return undefined
  }
  return parsed
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
          background: typeof data.background === 'boolean' ? data.background : undefined,
          memory: data.memory as 'user' | 'project' | 'local' | undefined,
          autoCompactWindow: parseTokenWindow(data.autoCompactWindow, name),
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
    this.loadDirectory(join(cwd, MIPHAM_DIR, 'agents'), 'project')
  }

  /** Load user-level agents from ~/.mipham/agents/ */
  loadUserAgents(): void {
    this.loadDirectory(miphamHome('agents'), 'user')
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
        source: 'builtin',
      }
    }

    return undefined
  }
}
