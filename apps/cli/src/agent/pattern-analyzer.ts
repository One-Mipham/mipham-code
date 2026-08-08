import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { AgentExperience } from './agent-experience.js'
import { parseFailureEntries, categorize, type ExperienceRule } from './experience-rules.js'
import type { ToolRule } from '../core/rule-engine.js'

export interface Pattern {
  id: string
  category: 'timeout' | 'import' | 'search' | 'tool-params' | 'semantic'
  agentName: string
  frequency: number
  confidence: 'high' | 'medium' | 'low'
  examples: string[]
  firstSeen: string
  lastSeen: string
}

export class PatternAnalyzer {
  analyzeAgent(agentName: string, baseDir?: string): Pattern[] {
    const dir = baseDir || join(homedir(), '.mipham', 'agent-memory')
    const exp = new AgentExperience(agentName, dir)
    const content = exp.getExperience()
    if (!content) return []

    const allEntries = parseFailureEntries(content)

    // Group by category
    const byCategory = new Map<string, { descriptions: string[]; dates: string[] }>()
    for (const entry of allEntries) {
      const cat = categorize(entry.description)
      const existing = byCategory.get(cat) || { descriptions: [], dates: [] }
      existing.descriptions.push(entry.description)
      existing.dates.push(entry.date)
      byCategory.set(cat, existing)
    }

    const patterns: Pattern[] = []
    for (const [category, data] of byCategory) {
      if (data.descriptions.length < 3) continue

      patterns.push({
        id: `pattern-${category}-${agentName}`,
        category: category as Pattern['category'],
        agentName,
        frequency: data.descriptions.length,
        confidence: data.descriptions.length >= 5 ? 'high' : 'medium',
        examples: data.descriptions.slice(0, 5),
        firstSeen: data.dates[0] ?? '',
        lastSeen: data.dates[data.dates.length - 1] ?? '',
      })
    }

    return patterns
  }

  analyzeAllAgents(baseDir?: string): Pattern[] {
    const dir = baseDir || join(homedir(), '.mipham', 'agent-memory')
    if (!existsSync(dir)) return []

    let agents: string[]
    try {
      agents = readdirSync(dir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
    } catch {
      return []
    }

    const allPatterns: Pattern[] = []
    for (const agent of agents) {
      allPatterns.push(...this.analyzeAgent(agent, baseDir))
    }
    return allPatterns
  }

  toRule(pattern: Pattern): ExperienceRule {
    return {
      id: `${pattern.id}-${Date.now().toString(36)}`,
      type: pattern.frequency >= 3 ? 'mandatory' : 'warning',
      condition: this._conditionForCategory(pattern),
      action: this._actionForCategory(pattern.category),
      evidence: {
        failureCount: pattern.frequency,
        lastFailure: pattern.lastSeen,
        examples: pattern.examples.slice(0, 3),
      },
      category: pattern.category,
      source: 'pattern-analyzer',
      agentName: pattern.agentName,
      createdAt: new Date().toISOString().slice(0, 10),
    }
  }

  toToolRule(pattern: Pattern): ToolRule {
    const toolNameMap: Record<string, string> = {
      timeout: 'Bash',
      'tool-params': 'Bash',
      import: 'Write',
      search: 'Grep',
      semantic: 'Bash',
    }

    return {
      id: pattern.id,
      toolName: toolNameMap[pattern.category] || 'Bash',
      category: pattern.category,
      match: (p: Record<string, unknown>): boolean => {
        if (pattern.category === 'timeout') {
          const cmd = String(p.command ?? '')
          const heavy = /npm|docker|pnpm|cargo|brew|install|build/.test(cmd)
          if (!heavy) return false
          const timeout = (p as Record<string, unknown>).timeout as number | undefined
          return !timeout || timeout < 300_000
        }
        return true
      },
      fix: (p: Record<string, unknown>) => ({
        modified: pattern.category === 'timeout' ? { ...p, timeout: 300_000 } : p,
        warning: `🤖 [auto-rule] ${pattern.category}: ${pattern.frequency} 次同类失败 — ${this._actionForCategory(pattern.category)}`,
      }),
      source: 'pattern-analyzer',
      enabled: true,
    }
  }

  // ── Private helpers ──

  private _conditionForCategory(pattern: Pattern): string {
    switch (pattern.category) {
      case 'timeout': return 'heavy CLI commands (npm/docker/pnpm/cargo)'
      case 'import': return 'ESM module imports missing .js extension'
      case 'search': return 'full-repository search without directory scoping'
      default: return pattern.examples[0]?.slice(0, 100) || 'unknown condition'
    }
  }

  private _actionForCategory(category: string): string {
    switch (category) {
      case 'timeout': return 'set Bash timeout ≥ 300000ms for heavy commands'
      case 'import': return 'append .js extension to ESM relative imports'
      case 'search': return 'use Glob to narrow directory before Grep'
      default: return 'review and adjust tool parameters before execution'
    }
  }
}
