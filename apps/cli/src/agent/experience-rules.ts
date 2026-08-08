export interface ExperienceRule {
  id: string // rule-<category>-<shortHash>
  type: 'mandatory' | 'warning'
  condition: string
  action: string
  evidence: {
    failureCount: number
    lastFailure: string // ISO date
    examples: string[]
  }
  category: 'timeout' | 'import' | 'search' | 'tool-params' | 'semantic'
  source: 'agent-experience' | 'manual' | 'pattern-analyzer'
  agentName: string
  createdAt: string // ISO date
}

export interface FailureEntry {
  date: string
  description: string
}

export function parseFailureEntries(content: string): FailureEntry[] {
  const entries: FailureEntry[] = []
  const failureIdx = content.indexOf('## Failure Patterns')
  if (failureIdx === -1) return entries

  const afterFailure = content.slice(failureIdx)
  const nextSection = afterFailure.indexOf('\n## ', '## Failure Patterns'.length)
  const section = nextSection !== -1 ? afterFailure.slice(0, nextSection) : afterFailure

  const lines = section.split('\n')
  for (const line of lines) {
    const match = line.match(/^- \[(\d{4}-\d{2}-\d{2})\]\s+(.+)/)
    if (match && match[1] && match[2]) {
      entries.push({ date: match[1], description: match[2].trim() })
    }
  }
  return entries
}

export function categorize(description: string): ExperienceRule['category'] {
  const lower = description.toLowerCase()
  if (lower.includes('timeout')) return 'timeout'
  if (/module_not_found|import|\.js/.test(lower)) return 'import'
  if (/grep|token.*overflow|search.*scope/.test(lower)) return 'search'
  if (/bash|command.*fail|docker|npm|pnpm|cargo|brew/.test(lower)) return 'tool-params'
  return 'semantic'
}

function createRuleId(category: string, description: string): string {
  // Hash the first 30 chars of description for uniqueness
  const hash = description
    .slice(0, 30)
    .split('')
    .reduce((acc, c) => {
      return ((acc << 5) - acc + c.charCodeAt(0)) | 0
    }, 0)
    .toString(36)
    .slice(-6)
  return `rule-${category}-${hash}`
}

function conditionForCategory(category: string, entries: FailureEntry[]): string {
  const combined = entries.map((e) => e.description).join('; ')
  switch (category) {
    case 'timeout':
      return 'heavy CLI commands (npm/docker/pnpm)'
    case 'import':
      return 'ESM module imports missing .js extension'
    case 'search':
      return 'full-repository Grep without directory scoping'
    case 'tool-params':
      return combined.slice(0, 100)
    default:
      return combined.slice(0, 100)
  }
}

function actionForCategory(category: string): string {
  switch (category) {
    case 'timeout':
      return 'set Bash timeout ≥ 300000ms for heavy commands'
    case 'import':
      return 'always append .js extension to ESM relative imports'
    case 'search':
      return 'use Glob to narrow directory before Grep'
    case 'tool-params':
      return 'review and adjust tool parameters before execution'
    default:
      return 'verify tool parameters match known good patterns'
  }
}

export class ExperienceRuleExtractor {
  extract(content: string, agentName: string): ExperienceRule[] {
    if (!content || !content.includes('## Failure Patterns')) return []

    const entries = parseFailureEntries(content)
    if (entries.length < 2) return []

    // Group by category
    const byCategory = new Map<string, FailureEntry[]>()
    for (const entry of entries) {
      const cat = categorize(entry.description)
      const existing = byCategory.get(cat) || []
      existing.push(entry)
      byCategory.set(cat, existing)
    }

    const rules: ExperienceRule[] = []
    for (const [category, catEntries] of byCategory) {
      if (catEntries.length < 2) continue

      const type: 'mandatory' | 'warning' = catEntries.length >= 3 ? 'mandatory' : 'warning'
      const firstEntry = catEntries[0]
      const lastEntry = catEntries[catEntries.length - 1]
      if (!firstEntry || !lastEntry) continue

      rules.push({
        id: createRuleId(category, firstEntry.description),
        type,
        condition: conditionForCategory(category, catEntries),
        action: actionForCategory(category),
        evidence: {
          failureCount: catEntries.length,
          lastFailure: lastEntry.date,
          examples: catEntries.slice(0, 3).map((e) => e.description),
        },
        category: category as ExperienceRule['category'],
        source: 'agent-experience',
        agentName,
        createdAt: new Date().toISOString().slice(0, 10),
      })
    }

    return rules
  }

  prioritize(rules: ExperienceRule[]): ExperienceRule[] {
    const order: Record<string, number> = {
      mandatory: 0,
      warning: 1,
    }
    return [...rules].sort((a, b) => {
      const aOrder = order[a.type] ?? 0
      const bOrder = order[b.type] ?? 0
      const typeDiff = aOrder - bOrder
      if (typeDiff !== 0) return typeDiff
      // Within same type, more failures first
      return b.evidence.failureCount - a.evidence.failureCount
    })
  }

  formatForInjection(rules: ExperienceRule[]): string {
    if (rules.length === 0) return ''

    const mandatory = rules.filter((r) => r.type === 'mandatory')
    const warnings = rules.filter((r) => r.type === 'warning')

    let output = ''

    if (mandatory.length > 0) {
      output += '## ⚠️ Active Mandatory Rules (learned from past failures)\n\n'
      for (const r of mandatory) {
        const idx = mandatory.indexOf(r) + 1
        output += `${idx}. [${r.category}] ${r.condition} → ${r.action}\n`
        output += `   Evidence: ${r.evidence.failureCount} failures`
        if (r.evidence.lastFailure) output += `, last: ${r.evidence.lastFailure}`
        output += '\n'
        if (r.evidence.examples.length > 0) {
          output += `   Example: ${r.evidence.examples[0]}\n`
        }
        output += '\n'
      }
    }

    if (warnings.length > 0) {
      output += '## ⚡ Observed Patterns (warning level)\n\n'
      for (const r of warnings) {
        const idx = warnings.indexOf(r) + 1
        output += `${idx}. [${r.category}] ${r.condition} → ${r.action}\n`
        output += `   Evidence: ${r.evidence.failureCount} occurrences\n\n`
      }
    }

    return output.trim()
  }
}
