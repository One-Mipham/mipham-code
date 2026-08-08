import type { ExperienceRule } from '../agent/experience-rules.js'

export interface ToolRule {
  id: string
  toolName: string
  category: string
  match: (params: Record<string, unknown>) => boolean
  fix: (params: Record<string, unknown>) => {
    modified: Record<string, unknown>
    warning: string
  }
  source: 'builtin' | 'pattern-analyzer' | 'manual'
  enabled: boolean
}

const BUILTIN_RULES: ToolRule[] = [
  {
    id: 'rule-timeout-bash-heavy',
    toolName: 'Bash',
    category: 'timeout',
    match: (p: Record<string, unknown>) => {
      const cmd = String(p.command ?? '')
      const heavy = /npm (install|ci|test)|docker build|pnpm install|cargo build|brew install/.test(cmd)
      if (!heavy) return false
      const timeout = (p as Record<string, unknown>).timeout as number | undefined
      return !timeout || timeout < 300_000
    },
    fix: (p: Record<string, unknown>) => {
      const prevTimeout = (p as Record<string, unknown>).timeout as number | undefined
      return {
        modified: { ...p, timeout: 300_000 },
        warning: `⏱️ timeout 已从 ${prevTimeout || 'default'}ms 自动提升至 300000ms（该命令类型历史超时率 > 50%）`,
      }
    },
    source: 'builtin',
    enabled: true,
  },
  {
    id: 'rule-git-force-protection',
    toolName: 'Bash',
    category: 'tool-params',
    match: (p: Record<string, unknown>) => {
      const cmd = String(p.command ?? '')
      return /git (push|reset) .*--force/.test(cmd) && !p.dangerouslyDisableSandbox
    },
    fix: (p: Record<string, unknown>) => ({
      modified: p,
      warning: '⚠️ 检测到 git --force 操作。如需执行请设置 dangerouslyDisableSandbox: true',
    }),
    source: 'builtin',
    enabled: true,
  },
]

export class ExperienceRuleEngine {
  private rules: ToolRule[]

  constructor() {
    this.rules = [...BUILTIN_RULES.map(r => ({ ...r }))]
  }

  register(rule: ToolRule): void {
    // Replace if same ID exists, otherwise append
    const idx = this.rules.findIndex(r => r.id === rule.id)
    if (idx !== -1) {
      this.rules[idx] = rule
    } else {
      this.rules.push(rule)
    }
  }

  intercept(
    toolName: string,
    params: Record<string, unknown>,
  ): { modified: Record<string, unknown>; warnings: string[] } {
    let modified = params
    const warnings: string[] = []

    for (const rule of this.rules) {
      if (!rule.enabled) continue
      if (rule.toolName !== toolName) continue

      try {
        if (rule.match(modified)) {
          const result = rule.fix(modified)
          modified = result.modified
          if (result.warning) {
            warnings.push(`[rule:${rule.id}] ${result.warning}`)
          }
        }
      } catch {
        // Rule match/fix failures never block execution
      }
    }

    return { modified, warnings }
  }

  convertFromExperienceRules(experienceRules: ExperienceRule[]): ToolRule[] {
    return experienceRules.map((er): ToolRule => {
      // Map experience rule category to tool name
      const toolNameMap: Record<string, string> = {
        timeout: 'Bash',
        'tool-params': 'Bash',
        import: 'Write',
        search: 'Grep',
        semantic: 'Bash',
      }
      const toolName = toolNameMap[er.category] || 'Bash'

      return {
        id: er.id,
        toolName,
        category: er.category,
        match: (p: Record<string, unknown>): boolean => {
          if (er.category === 'timeout') {
            const cmd = String(p.command ?? '')
            const heavy = /npm|docker|pnpm|cargo|brew|install|build/.test(cmd)
            if (!heavy) return false
            const timeout = (p as Record<string, unknown>).timeout as number | undefined
            return !timeout || timeout < 300_000
          }
          // Default: always match for the given tool
          return true
        },
        fix: (p: Record<string, unknown>) => ({
          modified: { ...p, timeout: 300_000 },
          warning: `⏱️ [auto-rule] ${er.action} (${er.evidence.failureCount} 次历史失败)`,
        }),
        source: 'pattern-analyzer',
        enabled: true,
      }
    })
  }

  getActiveRules(): ToolRule[] {
    return this.rules.filter(r => r.enabled)
  }

  setRuleEnabled(id: string, enabled: boolean): void {
    const rule = this.rules.find(r => r.id === id)
    if (rule) {
      rule.enabled = enabled
    }
  }
}
