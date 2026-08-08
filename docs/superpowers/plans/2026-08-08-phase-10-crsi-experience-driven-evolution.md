# Phase 10 CRSI 经验驱动行为进化 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a three-layer pipeline that converts accumulated Agent experience into automated behavioral rules — injecting mandatory rules into system prompts (10.1), intercepting tool calls for deterministic fixes (10.2), and auto-discovering failure patterns with feedback-driven rule lifecycle management (10.3).

**Architecture:** Three sequential phases. 10.1 defines the `ExperienceRule` type and extraction logic. 10.2 builds `ExperienceRuleEngine` on top of the existing `PreToolUse` hook in `engine.ts:800` to intercept tool calls before execution. 10.3 adds `PatternAnalyzer` and `EffectivenessTracker` that hook into `SessionEnd` (via `index.tsx:343`) and `SubagentStop` callbacks, closing the full CRSI loop.

**Tech Stack:** TypeScript 5.5+ strict, Bun runtime, Vitest 3, Node.js fs/path APIs for rule storage.

**Design Spec:** `docs/superpowers/specs/2026-08-08-phase-10-crsi-experience-driven-evolution-design.md`

## Global Constraints

- TypeScript strict mode, ESM modules with `.js` extensions in relative imports
- Test framework: Vitest 3; run with `pnpm test` from `apps/cli/`
- Commit messages: Conventional Commits (`feat:`, `fix:`, `test:`)
- File storage: `~/.mipham/rule-engine/` (rules, effectiveness, patterns, audit log)
- Feature flags in `~/.mipham/config.json` under `crsi.*`
- Max 20 experience entries per agent (existing cap from Phase 7)
- Max 50 active rules globally
- Lint: ESLint flat config + Prettier, CI enforced
- All new files use `import type` for type-only imports from `../shared/index.ts`

---

## File Map

| File | Role | Phase |
|------|------|-------|
| `agent/experience-rules.ts` | **NEW** — `ExperienceRule` type + `ExperienceRuleExtractor` | 10.1 |
| `agent/agent-experience.ts` | MODIFY — add `getRules()` convenience method | 10.1 |
| `agent/agent-context.ts` | MODIFY — replace raw `getExperience()` with rule extraction + injection | 10.1 |
| `core/rule-engine.ts` | **NEW** — `ExperienceRuleEngine` + `ToolRule` + builtin rules | 10.2 |
| `core/engine.ts` | MODIFY — integrate `RuleEngine.intercept()` into `executeTool()` | 10.2 |
| `ui/commands.ts` | MODIFY — register `/crsi rules` and `/crsi disable` | 10.2 |
| `agent/pattern-analyzer.ts` | **NEW** — `PatternAnalyzer` — scans experience.md for failure patterns | 10.3 |
| `agent/effectiveness-tracker.ts` | **NEW** — `EffectivenessTracker` — tracks rule impact | 10.3 |
| `ui/commands.ts` | MODIFY (2nd pass) — register `/crsi analyze`, `/crsi restore`, `/crsi stats` | 10.3 |
| `agent/sub-agent.ts` | MODIFY — wire `PatternAnalyzer` trigger on `SubagentStop` | 10.3 |
| `test/agent/experience-rules.test.ts` | **NEW** — tests for rule extraction | 10.1 |
| `test/core/rule-engine.test.ts` | **NEW** — tests for RuleEngine + builtin rules | 10.2 |
| `test/agent/pattern-analyzer.test.ts` | **NEW** — tests for pattern detection | 10.3 |
| `test/agent/effectiveness-tracker.test.ts` | **NEW** — tests for effectiveness tracking | 10.3 |

---

### Task 1: ExperienceRule type + ExperienceRuleExtractor

**Files:**
- Create: `apps/cli/src/agent/experience-rules.ts`
- Modify: `apps/cli/src/agent/agent-experience.ts`
- Test: `apps/cli/test/agent/experience-rules.test.ts`

**Interfaces:**
- Produces: `ExperienceRule` interface, `ExperienceRuleExtractor` class with `extract(experienceContent: string, agentName: string): ExperienceRule[]`, `prioritize(rules: ExperienceRule[]): ExperienceRule[]`, `formatForInjection(rules: ExperienceRule[]): string`

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/cli/test/agent/experience-rules.test.ts
import { describe, it, expect } from 'vitest'
import { ExperienceRuleExtractor } from '../../src/agent/experience-rules.js'
import type { ExperienceRule } from '../../src/agent/experience-rules.js'

function makeExperience(failures: string[]): string {
  const header = `# Agent Experience — test-agent

## Success Patterns

- [2026-08-07] Fixed import cycle by glob scanning
  **When to apply:** cross-module PR review

## Failure Patterns
`
  const footer = `
## Stats
- 总执行: 10 次 | 成功: 7 | 失败: 3
`
  return header + failures.map((f, i) => `- [2026-08-0${7 - i}] ${f}
  **When to avoid:** auto-generated`).join('\n') + footer
}

describe('ExperienceRuleExtractor', () => {
  const extractor = new ExperienceRuleExtractor()

  it('returns empty array for empty experience content', () => {
    expect(extractor.extract('', 'test-agent')).toEqual([])
    expect(extractor.extract('# Agent Experience — test-agent\n\n## Success Patterns\n\n## Failure Patterns\n\n## Stats\n- 总执行: 0 次 | 成功: 0 | 失败: 0\n', 'test-agent')).toEqual([])
  })

  it('does not generate rules for single failures', () => {
    const exp = makeExperience(['npm install timeout at 120s'])
    const rules = extractor.extract(exp, 'test-agent')
    expect(rules).toEqual([])
  })

  it('generates warning rule for 2 failures of same category', () => {
    const exp = makeExperience([
      'npm install timeout at 120s',
      'pnpm install timeout at 120s',
    ])
    const rules = extractor.extract(exp, 'test-agent')
    expect(rules.length).toBeGreaterThanOrEqual(1)
    const timeoutRule = rules.find(r => r.category === 'timeout')
    expect(timeoutRule).toBeDefined()
    expect(timeoutRule!.type).toBe('warning')
    expect(timeoutRule!.evidence.failureCount).toBe(2)
  })

  it('generates mandatory rule for 3+ failures of same category', () => {
    const exp = makeExperience([
      'npm install timeout at 120s',
      'docker build timeout at 120s',
      'pnpm install timeout at 120s',
    ])
    const rules = extractor.extract(exp, 'test-agent')
    const timeoutRule = rules.find(r => r.category === 'timeout')
    expect(timeoutRule).toBeDefined()
    expect(timeoutRule!.type).toBe('mandatory')
    expect(timeoutRule!.evidence.failureCount).toBe(3)
  })

  it('categorizes MODULE_NOT_FOUND as import', () => {
    const exp = makeExperience([
      'MODULE_NOT_FOUND for ./foo',
      'MODULE_NOT_FOUND for ./bar',
    ])
    const rules = extractor.extract(exp, 'test-agent')
    const importRule = rules.find(r => r.category === 'import')
    expect(importRule).toBeDefined()
  })

  it('categorizes grep/token errors as search', () => {
    const exp = makeExperience([
      'Grep returned 450K tokens — overflow',
      'Grep search scope too large — 300K tokens',
    ])
    const rules = extractor.extract(exp, 'test-agent')
    const searchRule = rules.find(r => r.category === 'search')
    expect(searchRule).toBeDefined()
  })

  it('assigns unique IDs to each rule', () => {
    const exp = makeExperience([
      'npm install timeout at 120s',
      'npm install timeout at 120s',
      'npm install timeout at 120s',
      'MODULE_NOT_FOUND for ./foo',
      'MODULE_NOT_FOUND for ./foo',
    ])
    const rules = extractor.extract(exp, 'test-agent')
    const ids = rules.map(r => r.id)
    expect(new Set(ids).size).toBe(ids.length) // all unique
  })

  it('formatForInjection produces correct markdown', () => {
    const rules: ExperienceRule[] = [
      {
        id: 'rule-timeout-abc',
        type: 'mandatory',
        condition: 'npm/docker commands',
        action: 'set timeout ≥ 300s',
        evidence: { failureCount: 3, lastFailure: '2026-08-07', examples: ['npm install timeout at 120s'] },
        category: 'timeout',
        source: 'agent-experience',
        agentName: 'test-agent',
        createdAt: '2026-08-08',
      },
    ]
    const formatted = extractor.formatForInjection(rules)
    expect(formatted).toContain('## ⚠️ Active Mandatory Rules')
    expect(formatted).toContain('[timeout]')
    expect(formatted).toContain('Evidence: 3 failures')
    expect(formatted).toContain('npm install timeout at 120s')
  })

  it('prioritize orders mandatory before warning', () => {
    const rules: ExperienceRule[] = [
      { id: 'r1', type: 'warning', category: 'search', condition: '', action: '', evidence: { failureCount: 2, lastFailure: '', examples: [] }, source: 'agent-experience', agentName: 'x', createdAt: '' },
      { id: 'r2', type: 'mandatory', category: 'timeout', condition: '', action: '', evidence: { failureCount: 3, lastFailure: '', examples: [] }, source: 'agent-experience', agentName: 'x', createdAt: '' },
    ]
    const prioritized = extractor.prioritize(rules)
    expect(prioritized[0].type).toBe('mandatory')
    expect(prioritized[1].type).toBe('warning')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/cli && pnpm test test/agent/experience-rules.test.ts`
Expected: FAIL — "Cannot find module" or "not defined"

- [ ] **Step 3: Write ExperienceRule type + ExperienceRuleExtractor**

```typescript
// apps/cli/src/agent/experience-rules.ts
export interface ExperienceRule {
  id: string                    // rule-<category>-<shortHash>
  type: 'mandatory' | 'warning'
  condition: string
  action: string
  evidence: {
    failureCount: number
    lastFailure: string         // ISO date
    examples: string[]
  }
  category: 'timeout' | 'import' | 'search' | 'tool-params' | 'semantic'
  source: 'agent-experience' | 'manual' | 'pattern-analyzer'
  agentName: string
  createdAt: string             // ISO date
}

interface FailureEntry {
  date: string
  description: string
}

function parseFailureEntries(content: string): FailureEntry[] {
  const entries: FailureEntry[] = []
  const failureIdx = content.indexOf('## Failure Patterns')
  if (failureIdx === -1) return entries

  const afterFailure = content.slice(failureIdx)
  const nextSection = afterFailure.indexOf('\n## ', '## Failure Patterns'.length)
  const section = nextSection !== -1 ? afterFailure.slice(0, nextSection) : afterFailure

  const lines = section.split('\n')
  let currentDate = ''
  for (const line of lines) {
    const dateMatch = line.match(/^- \[(\d{4}-\d{2}-\d{2})\]\s+(.+)/)
    if (dateMatch) {
      currentDate = dateMatch[1]
      entries.push({ date: currentDate, description: dateMatch[2].trim() })
    }
  }
  return entries
}

function categorize(description: string): ExperienceRule['category'] {
  const lower = description.toLowerCase()
  if (lower.includes('timeout')) return 'timeout'
  if (/module_not_found|import|\.js/.test(lower)) return 'import'
  if (/grep|token.*overflow|search.*scope/.test(lower)) return 'search'
  if (/bash|command.*fail|docker|npm|pnpm|cargo|brew/.test(lower)) return 'tool-params'
  return 'semantic'
}

function createRuleId(category: string, description: string): string {
  // Hash the first 30 chars of description for uniqueness
  const hash = description.slice(0, 30).split('').reduce((acc, c) => {
    return ((acc << 5) - acc + c.charCodeAt(0)) | 0
  }, 0).toString(36).slice(-6)
  return `rule-${category}-${hash}`
}

function conditionForCategory(category: string, entries: FailureEntry[]): string {
  const combined = entries.map(e => e.description).join('; ')
  switch (category) {
    case 'timeout': return 'heavy CLI commands (npm/docker/pnpm)'
    case 'import': return 'ESM module imports missing .js extension'
    case 'search': return 'full-repository Grep without directory scoping'
    case 'tool-params': return combined.slice(0, 100)
    default: return combined.slice(0, 100)
  }
}

function actionForCategory(category: string): string {
  switch (category) {
    case 'timeout': return 'set Bash timeout ≥ 300000ms for heavy commands'
    case 'import': return 'always append .js extension to ESM relative imports'
    case 'search': return 'use Glob to narrow directory before Grep'
    case 'tool-params': return 'review and adjust tool parameters before execution'
    default: return 'verify tool parameters match known good patterns'
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
      const lastEntry = catEntries[catEntries.length - 1]

      rules.push({
        id: createRuleId(category, catEntries[0].description),
        type,
        condition: conditionForCategory(category, catEntries),
        action: actionForCategory(category),
        evidence: {
          failureCount: catEntries.length,
          lastFailure: lastEntry.date,
          examples: catEntries.slice(0, 3).map(e => e.description),
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
      const typeDiff = order[a.type] - order[b.type]
      if (typeDiff !== 0) return typeDiff
      // Within same type, more failures first
      return b.evidence.failureCount - a.evidence.failureCount
    })
  }

  formatForInjection(rules: ExperienceRule[]): string {
    if (rules.length === 0) return ''

    const mandatory = rules.filter(r => r.type === 'mandatory')
    const warnings = rules.filter(r => r.type === 'warning')

    let output = ''

    if (mandatory.length > 0) {
      output += '## ⚠️ Active Mandatory Rules (learned from past failures)\n\n'
      for (let i = 0; i < mandatory.length; i++) {
        const r = mandatory[i]
        output += `${i + 1}. [${r.category}] ${r.condition} → ${r.action}\n`
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
      for (let i = 0; i < warnings.length; i++) {
        const r = warnings[i]
        output += `${i + 1}. [${r.category}] ${r.condition} → ${r.action}\n`
        output += `   Evidence: ${r.evidence.failureCount} occurrences\n\n`
      }
    }

    return output.trim()
  }
}
```

- [ ] **Step 4: Add getRules() to AgentExperience**

In `apps/cli/src/agent/agent-experience.ts`, add after `reset()`:

```typescript
import { ExperienceRuleExtractor, type ExperienceRule } from './experience-rules.js'

// Add to AgentExperience class:
getRules(): ExperienceRule[] {
  const content = this.getExperience()
  if (!content) return []
  const extractor = new ExperienceRuleExtractor()
  return extractor.extract(content, this.agentName)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/cli && pnpm test test/agent/experience-rules.test.ts`
Expected: all 8 tests PASS

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/agent/experience-rules.ts apps/cli/src/agent/agent-experience.ts apps/cli/test/agent/experience-rules.test.ts
git commit -m "feat(crsi): add ExperienceRuleExtractor — convert failure patterns to structured rules

- ExperienceRule type with mandatory/warning levels and evidence chains
- ExperienceRuleExtractor.extract() categorizes failures by keyword matching
- prioritze() sorts mandatory before warning, more failures first
- formatForInjection() generates system prompt rule blocks
- Thresholds: ≥3 failures → mandatory, 2 failures → warning, 1 → skip
- +8 tests

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Wire rule injection into agent-context.ts

**Files:**
- Modify: `apps/cli/src/agent/agent-context.ts`

**Interfaces:**
- Consumes: `ExperienceRuleExtractor.extract()`, `ExperienceRuleExtractor.formatForInjection()`
- Modifies: `loadAgentMemory()` — replaces raw `exp.getExperience()` with `exp.getRules()` + formatted injection

- [ ] **Step 1: Update loadAgentMemory in agent-context.ts**

Replace lines 59–117 (the experience handling block) in `apps/cli/src/agent/agent-context.ts`:

```typescript
import { ExperienceRuleExtractor } from './experience-rules.js'

// Inside loadAgentMemory(), replace the experience block (lines 59-117) with:
  // Load auto-accumulated experience rules (always from user scope)
  const exp = new AgentExperience(agentName)
  const extractor = new ExperienceRuleExtractor()
  const rules = extractor.prioritize(exp.getRules())

  let experienceMemory = ''
  if (rules.length > 0) {
    experienceMemory = extractor.formatForInjection(rules)
  }
```

- [ ] **Step 2: Run existing tests to verify no regressions**

Run: `cd apps/cli && pnpm test test/agent/sub-agent.test.ts`
Expected: all existing tests PASS (experience injection path is unchanged in structure)

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/agent/agent-context.ts
git commit -m "feat(crsi): wire rule-based experience injection into agent context

Replace raw experience.md injection with structured ExperienceRule
injection using ExperienceRuleExtractor. Rules now appear as mandatory
directives and warnings in the agent system prompt.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: ExperienceRuleEngine + builtin rules

**Files:**
- Create: `apps/cli/src/core/rule-engine.ts`
- Test: `apps/cli/test/core/rule-engine.test.ts`

**Interfaces:**
- Produces: `ToolRule` interface, `ExperienceRuleEngine` class with `register(rule: ToolRule): void`, `intercept(toolName: string, params: Record<string, unknown>): { modified: Record<string, unknown>; warnings: string[] }`, `convertFromExperienceRules(experienceRules: ExperienceRule[]): ToolRule[]`, `getActiveRules(): ToolRule[]`, `setRuleEnabled(id: string, enabled: boolean): void`

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/cli/test/core/rule-engine.test.ts
import { describe, it, expect } from 'vitest'
import { ExperienceRuleEngine } from '../../src/core/rule-engine.js'
import type { ToolRule } from '../../src/core/rule-engine.js'

describe('ExperienceRuleEngine', () => {
  it('intercept returns unmodified params when no rules match', () => {
    const engine = new ExperienceRuleEngine()
    const result = engine.intercept('Read', { file_path: '/tmp/test.txt' })
    expect(result.modified).toEqual({ file_path: '/tmp/test.txt' })
    expect(result.warnings).toEqual([])
  })

  it('builtin timeout rule matches npm install with low timeout', () => {
    const engine = new ExperienceRuleEngine()
    const result = engine.intercept('Bash', {
      command: 'npm install express',
      timeout: 120000,
      description: 'install deps',
    })
    expect(result.modified.timeout).toBe(300000)
    expect(result.warnings.length).toBe(1)
    expect(result.warnings[0]).toContain('timeout')
    expect(result.warnings[0]).toContain('300000')
  })

  it('builtin timeout rule also matches docker build', () => {
    const engine = new ExperienceRuleEngine()
    const result = engine.intercept('Bash', {
      command: 'docker build -t app .',
      description: 'build image',
    })
    expect(result.modified.timeout).toBe(300000)
    expect(result.warnings.length).toBe(1)
  })

  it('builtin timeout rule does not modify already-high timeout', () => {
    const engine = new ExperienceRuleEngine()
    const result = engine.intercept('Bash', {
      command: 'npm install express',
      timeout: 600000,
      description: 'install deps',
    })
    expect(result.modified.timeout).toBe(600000)
    expect(result.warnings).toEqual([])
  })

  it('builtin timeout rule does not match non-heavy commands', () => {
    const engine = new ExperienceRuleEngine()
    const result = engine.intercept('Bash', {
      command: 'echo hello',
      description: 'simple echo',
    })
    expect(result.modified.timeout).toBeUndefined()
    expect(result.warnings).toEqual([])
  })

  it('git force protection warns but does not modify params', () => {
    const engine = new ExperienceRuleEngine()
    const result = engine.intercept('Bash', {
      command: 'git push --force origin main',
      description: 'force push',
    })
    expect(result.warnings.length).toBe(1)
    expect(result.warnings[0]).toContain('--force')
    // params unchanged — only warning
    expect(result.modified.command).toBe('git push --force origin main')
  })

  it('git force with dangerouslyDisableSandbox is not warned', () => {
    const engine = new ExperienceRuleEngine()
    const result = engine.intercept('Bash', {
      command: 'git push --force origin main',
      dangerouslyDisableSandbox: true,
      description: 'force push',
    })
    expect(result.warnings).toEqual([])
  })

  it('custom rules can be registered and take effect', () => {
    const engine = new ExperienceRuleEngine()
    const customRule: ToolRule = {
      id: 'rule-test-custom',
      toolName: 'Write',
      category: 'tool-params',
      match: (p) => {
        const path = String(p.file_path ?? '')
        return path.endsWith('.ts') && !path.includes('.js')
      },
      fix: (p) => ({
        modified: { ...p, file_path: String(p.file_path) + '?' },
        warning: 'test warning for .ts file',
      }),
      source: 'manual',
      enabled: true,
    }
    engine.register(customRule)
    const result = engine.intercept('Write', { file_path: '/tmp/test.ts', content: 'x' })
    expect(result.warnings.length).toBe(1)
    expect(result.modified.file_path).toBe('/tmp/test.ts?')
  })

  it('disabled rules are skipped', () => {
    const engine = new ExperienceRuleEngine()
    const rule: ToolRule = {
      id: 'rule-disabled-test',
      toolName: 'Read',
      category: 'tool-params',
      match: () => true,
      fix: (p) => ({ modified: p, warning: 'should not appear' }),
      source: 'manual',
      enabled: false,
    }
    engine.register(rule)
    const result = engine.intercept('Read', { file_path: '/tmp/test.txt' })
    expect(result.warnings).toEqual([])
  })

  it('setRuleEnabled toggles rule state', () => {
    const engine = new ExperienceRuleEngine()
    const rules = engine.getActiveRules()
    const timeoutRule = rules.find(r => r.id === 'rule-timeout-bash-heavy')
    expect(timeoutRule).toBeDefined()
    expect(timeoutRule!.enabled).toBe(true)

    engine.setRuleEnabled('rule-timeout-bash-heavy', false)
    const result = engine.intercept('Bash', {
      command: 'npm install express',
      description: 'install',
    })
    expect(result.warnings).toEqual([])

    engine.setRuleEnabled('rule-timeout-bash-heavy', true)
    const result2 = engine.intercept('Bash', {
      command: 'npm install express',
      description: 'install',
    })
    expect(result2.warnings.length).toBe(1)
  })

  it('convertFromExperienceRules converts ExperienceRule[] to ToolRule[]', () => {
    const engine = new ExperienceRuleEngine()
    const expRules = [
      {
        id: 'rule-timeout-xyz', type: 'mandatory' as const,
        condition: 'heavy CLI commands', action: 'set timeout ≥ 300s',
        evidence: { failureCount: 3, lastFailure: '2026-08-07', examples: ['npm install timeout'] },
        category: 'timeout' as const, source: 'agent-experience' as const,
        agentName: 'test', createdAt: '2026-08-08',
      },
    ]
    const toolRules = engine.convertFromExperienceRules(expRules)
    expect(toolRules.length).toBe(1)
    expect(toolRules[0].toolName).toBe('Bash')
    expect(toolRules[0].source).toBe('pattern-analyzer')
  })

  it('getActiveRules returns only enabled rules', () => {
    const engine = new ExperienceRuleEngine()
    const rules = engine.getActiveRules()
    expect(rules.length).toBeGreaterThan(0)
    expect(rules.every(r => r.enabled)).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/cli && pnpm test test/core/rule-engine.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write ExperienceRuleEngine + builtin rules**

```typescript
// apps/cli/src/core/rule-engine.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/cli && pnpm test test/core/rule-engine.test.ts`
Expected: all 12 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/rule-engine.ts apps/cli/test/core/rule-engine.test.ts
git commit -m "feat(crsi): add ExperienceRuleEngine with builtin rules

- ToolRule interface with match/fix functions for deterministic interception
- 2 builtin rules: timeout boost for heavy CLI commands, git force protection
- Register, enable/disable, convertFromExperienceRules APIs
- Full audit trail via warnings injected into tool result
- +12 tests

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Integrate RuleEngine into engine.ts tool execution

**Files:**
- Modify: `apps/cli/src/core/engine.ts`

**Interfaces:**
- Consumes: `ExperienceRuleEngine.intercept()`
- Modifies: `QueryEngine.executeTool()` — calls `ruleEngine.intercept()` in the PreToolUse flow, injects warnings into tool result

- [ ] **Step 1: Add ruleEngine field and initialize in engine.ts**

In `apps/cli/src/core/engine.ts`:

```typescript
// Add import at top:
import { ExperienceRuleEngine } from './rule-engine.js'

// Add field to QueryEngine class:
export class QueryEngine {
  // ...existing fields...
  private ruleEngine?: ExperienceRuleEngine

  constructor(/* ...existing params... */, ruleEngine?: ExperienceRuleEngine) {
    // ...existing init...
    this.ruleEngine = ruleEngine
  }
```

- [ ] **Step 2: Integrate intercept into executeTool**

In the `executeTool` method of `QueryEngine`, after the existing PreToolUse hook block (lines 797–811), add the RuleEngine intercept:

```typescript
    // Run PreToolUse hooks (existing code)
    let effectiveParams = params
    let hookWarnings: string[] = []
    if (this.hookEngine) {
      const preResult = await this.hookEngine.executePreToolUse(name, params, this.sessionId)
      if (!preResult.allowed) {
        return {
          success: false,
          content: '',
          error: preResult.reason || t('errors.tool_blocked', { name }),
        }
      }
      if (preResult.modifiedInput) {
        effectiveParams = { ...params, ...preResult.modifiedInput }
      }
    }

    // CRSI RuleEngine intercept (new)
    if (this.ruleEngine) {
      const ruleResult = this.ruleEngine.intercept(name, effectiveParams)
      if (Object.keys(ruleResult.modified).length > 0) {
        effectiveParams = ruleResult.modified
      }
      if (ruleResult.warnings.length > 0) {
        hookWarnings = ruleResult.warnings
      }
    }
```

Then, after the tool executes successfully (after line 826), prepend warnings to the result:

```typescript
      // Track touched files for rules matching (existing)
      this.trackTouchedFile(name, effectiveParams)

      // Prepend CRSI warnings to result content
      if (hookWarnings.length > 0 && result.success) {
        result.content = hookWarnings.join('\n') + '\n' + (result.content || '')
      }

      // Run PostToolUse hooks (existing)
      if (this.hookEngine) {
        await this.hookEngine.executePostToolUse(name, effectiveParams, result, this.sessionId)
      }
```

- [ ] **Step 3: Pass ruleEngine instance in index.tsx**

Find where `QueryEngine` is instantiated in `apps/cli/src/index.tsx`, and pass a new `ExperienceRuleEngine()`:

```typescript
import { ExperienceRuleEngine } from './core/rule-engine.js'

// Find the QueryEngine constructor call and add:
const ruleEngine = new ExperienceRuleEngine()
// Pass as parameter to QueryEngine constructor
```

- [ ] **Step 4: Run existing tests to verify no regressions**

Run: `cd apps/cli && pnpm test test/core/engine.test.ts`
Expected: all existing tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/engine.ts apps/cli/src/index.tsx
git commit -m "feat(crsi): integrate RuleEngine into tool execution pipeline

RuleEngine.intercept() runs after PreToolUse hooks and before tool execution.
Warnings from matched rules are prepended to tool result content, ensuring AI
sees the auto-corrections. RuleEngine instance is optional — no breakage if absent.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Register /crsi commands (Phase 10.2 set)

**Files:**
- Modify: `apps/cli/src/ui/commands.ts`

**Interfaces:**
- Consumes: `ExperienceRuleEngine.getActiveRules()`, `setRuleEnabled()`

- [ ] **Step 1: Find command registration pattern in commands.ts**

Locate the section where slash commands are registered. Identify the pattern used (typically an array of command objects or a registry map).

- [ ] **Step 2: Add /crsi rules and /crsi disable commands**

In `apps/cli/src/ui/commands.ts`, add the following commands:

```typescript
// ── CRSI commands ──

{
  name: 'crsi-rules',
  command: '/crsi rules',
  description: 'List all active CRSI rules with their status',
  category: 'Tools & Skills',
  handler: async (ctx: CommandContext) => {
    const engine = ctx.ruleEngine
    if (!engine) {
      return 'CRSI rule engine is not available.'
    }
    const rules = engine.getActiveRules()
    if (rules.length === 0) {
      return 'No active CRSI rules.'
    }
    const lines = ['## Active CRSI Rules', '']
    for (const r of rules) {
      lines.push(`- \`${r.id}\` [${r.category}] ${r.toolName} — ${r.source} ${r.enabled ? '✅' : '⛔'}`)
    }
    lines.push('', `Total: ${rules.length} active rules`)
    lines.push('', 'Use `/crsi disable <rule-id>` to disable a rule.')
    return lines.join('\n')
  },
},

{
  name: 'crsi-disable',
  command: '/crsi disable',
  description: 'Disable a CRSI rule by ID',
  category: 'Tools & Skills',
  handler: async (ctx: CommandContext, args?: string) => {
    const engine = ctx.ruleEngine
    if (!engine) return 'CRSI rule engine is not available.'
    if (!args || !args.trim()) return 'Usage: /crsi disable <rule-id>'
    const ruleId = args.trim()
    engine.setRuleEnabled(ruleId, false)
    return `Rule \`${ruleId}\` has been disabled. Use \`/crsi restore ${ruleId}\` to re-enable.`
  },
},
```

- [ ] **Step 3: Run typecheck**

Run: `cd apps/cli && pnpm typecheck`
Expected: no new type errors

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/ui/commands.ts
git commit -m "feat(crsi): register /crsi rules and /crsi disable commands

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: PatternAnalyzer — auto-discover failure patterns

**Files:**
- Create: `apps/cli/src/agent/pattern-analyzer.ts`
- Test: `apps/cli/test/agent/pattern-analyzer.test.ts`

**Interfaces:**
- Produces: `Pattern` interface, `PatternAnalyzer` class with `analyzeAgent(agentName: string, baseDir?: string): Pattern[]`, `analyzeAllAgents(baseDir?: string): Pattern[]`, `toRule(pattern: Pattern): ExperienceRule`, `toToolRule(pattern: Pattern): ToolRule`
- Consumes: `AgentExperience.getExperience()`, `ExperienceRule` type, `ToolRule` type

- [ ] **Step 1: Write failing tests**

```typescript
// apps/cli/test/agent/pattern-analyzer.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PatternAnalyzer } from '../../src/agent/pattern-analyzer.js'
import { AgentExperience } from '../../src/agent/agent-experience.js'

function setupAgentDir(baseDir: string, agentName: string, failures: string[]): AgentExperience {
  const exp = new AgentExperience(agentName, baseDir)
  for (const f of failures) {
    exp.logFailure(f, `Avoid ${f.slice(0, 30)}`)
  }
  return exp
}

describe('PatternAnalyzer', () => {
  let baseDir: string

  beforeEach(() => {
    baseDir = join(tmpdir(), `crsi-test-${Date.now()}`)
  })

  afterEach(() => {
    if (existsSync(baseDir)) {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it('returns empty array when no experience exists', () => {
    const analyzer = new PatternAnalyzer()
    const patterns = analyzer.analyzeAgent('nonexistent-agent', baseDir)
    expect(patterns).toEqual([])
  })

  it('detects timeout pattern with 3+ failures', () => {
    setupAgentDir(baseDir, 'test-agent', [
      'npm install timeout at 120s',
      'docker build timeout at 120s',
      'pnpm install timeout at default',
    ])
    const analyzer = new PatternAnalyzer()
    const patterns = analyzer.analyzeAgent('test-agent', baseDir)
    const timeoutPattern = patterns.find(p => p.category === 'timeout')
    expect(timeoutPattern).toBeDefined()
    expect(timeoutPattern!.frequency).toBeGreaterThanOrEqual(3)
    expect(timeoutPattern!.confidence).toBe('high')
  })

  it('does not detect pattern with only 2 failures', () => {
    setupAgentDir(baseDir, 'test-agent', [
      'npm install timeout at 120s',
      'npm install timeout at 120s',
    ])
    const analyzer = new PatternAnalyzer()
    const patterns = analyzer.analyzeAgent('test-agent', baseDir)
    // 2 failures → no pattern (only warning rule, not auto-created ToolRule)
    expect(patterns.filter(p => p.frequency >= 3)).toEqual([])
  })

  it('detects import error pattern', () => {
    setupAgentDir(baseDir, 'test-agent', [
      'MODULE_NOT_FOUND for ./foo',
      'MODULE_NOT_FOUND for ./bar',
      'MODULE_NOT_FOUND for ./baz',
    ])
    const analyzer = new PatternAnalyzer()
    const patterns = analyzer.analyzeAgent('test-agent', baseDir)
    const importPattern = patterns.find(p => p.category === 'import')
    expect(importPattern).toBeDefined()
    expect(importPattern!.frequency).toBe(3)
  })

  it('toRule converts pattern to ExperienceRule', () => {
    setupAgentDir(baseDir, 'test-agent', [
      'npm install timeout at 120s',
      'npm install timeout at 120s',
      'npm install timeout at 120s',
    ])
    const analyzer = new PatternAnalyzer()
    const patterns = analyzer.analyzeAgent('test-agent', baseDir)
    const timeoutPattern = patterns.find(p => p.category === 'timeout')
    expect(timeoutPattern).toBeDefined()

    const rule = analyzer.toRule(timeoutPattern!)
    expect(rule.type).toBe('mandatory')
    expect(rule.category).toBe('timeout')
    expect(rule.source).toBe('pattern-analyzer')
    expect(rule.evidence.failureCount).toBeGreaterThanOrEqual(3)
  })

  it('toToolRule converts pattern to ToolRule', () => {
    setupAgentDir(baseDir, 'test-agent', [
      'npm install timeout at 120s',
      'npm install timeout at 120s',
      'npm install timeout at 120s',
    ])
    const analyzer = new PatternAnalyzer()
    const patterns = analyzer.analyzeAgent('test-agent', baseDir)
    const timeoutPattern = patterns.find(p => p.category === 'timeout')
    expect(timeoutPattern).toBeDefined()

    const toolRule = analyzer.toToolRule(timeoutPattern!)
    expect(toolRule.toolName).toBe('Bash')
    expect(toolRule.source).toBe('pattern-analyzer')
    expect(toolRule.enabled).toBe(true)
    expect(typeof toolRule.match).toBe('function')
    expect(typeof toolRule.fix).toBe('function')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/cli && pnpm test test/agent/pattern-analyzer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write PatternAnalyzer**

```typescript
// apps/cli/src/agent/pattern-analyzer.ts
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { AgentExperience } from './agent-experience.js'
import { ExperienceRuleExtractor, type ExperienceRule } from './experience-rules.js'
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

    const extractor = new ExperienceRuleExtractor()
    const allEntries = this._parseAllFailures(content)

    // Group by category
    const byCategory = new Map<string, { descriptions: string[]; dates: string[] }>()
    for (const entry of allEntries) {
      const cat = this._categorize(entry.description)
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
        firstSeen: data.dates[0],
        lastSeen: data.dates[data.dates.length - 1],
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

  private _parseAllFailures(content: string): Array<{ date: string; description: string }> {
    const entries: Array<{ date: string; description: string }> = []
    const failureIdx = content.indexOf('## Failure Patterns')
    if (failureIdx === -1) return entries

    const afterFailure = content.slice(failureIdx)
    const nextSection = afterFailure.indexOf('\n## ', '## Failure Patterns'.length)
    const section = nextSection !== -1 ? afterFailure.slice(0, nextSection) : afterFailure

    const lines = section.split('\n')
    for (const line of lines) {
      const match = line.match(/^- \[(\d{4}-\d{2}-\d{2})\]\s+(.+)/)
      if (match) {
        entries.push({ date: match[1], description: match[2].trim() })
      }
    }
    return entries
  }

  private _categorize(description: string): string {
    const lower = description.toLowerCase()
    if (lower.includes('timeout')) return 'timeout'
    if (/module_not_found|import|\.js/.test(lower)) return 'import'
    if (/grep|token.*overflow|search.*scope/.test(lower)) return 'search'
    if (/bash|command.*fail|docker|npm|pnpm|cargo|brew/.test(lower)) return 'tool-params'
    return 'semantic'
  }

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/cli && pnpm test test/agent/pattern-analyzer.test.ts`
Expected: all 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/agent/pattern-analyzer.ts apps/cli/test/agent/pattern-analyzer.test.ts
git commit -m "feat(crsi): add PatternAnalyzer — auto-discover failure patterns

Scans all agent experience.md files for recurring failure patterns
(≥3 occurrences). Converts patterns to ExperienceRule and ToolRule.
Trigger: SessionEnd + manual /crsi analyze.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: EffectivenessTracker — rule impact tracking

**Files:**
- Create: `apps/cli/src/agent/effectiveness-tracker.ts`
- Test: `apps/cli/test/agent/effectiveness-tracker.test.ts`

**Interfaces:**
- Produces: `RuleEffectiveness` interface, `EffectivenessTracker` class with `recordApplication(ruleId: string, success: boolean): void`, `evaluate(): { upgrades: string[]; degradations: string[]; disables: string[] }`, `getEffectiveness(ruleId: string): RuleEffectiveness | null`, `persist(): void`, `load(): void`

- [ ] **Step 1: Write failing tests**

```typescript
// apps/cli/test/agent/effectiveness-tracker.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EffectivenessTracker } from '../../src/agent/effectiveness-tracker.js'

describe('EffectivenessTracker', () => {
  let tracker: EffectivenessTracker
  let storePath: string

  beforeEach(() => {
    storePath = join(tmpdir(), `crsi-eff-${Date.now()}`)
    tracker = new EffectivenessTracker(storePath)
  })

  afterEach(() => {
    if (existsSync(storePath)) {
      rmSync(storePath, { recursive: true, force: true })
    }
  })

  it('starts with no effectiveness data', () => {
    expect(tracker.getEffectiveness('nonexistent')).toBeNull()
  })

  it('recordApplication tracks success/failure', () => {
    tracker.recordApplication('rule-test', true)
    tracker.recordApplication('rule-test', true)
    tracker.recordApplication('rule-test', false)

    const eff = tracker.getEffectiveness('rule-test')
    expect(eff).toBeDefined()
    expect(eff!.appliedCount).toBe(3)
    expect(eff!.successAfterCount).toBe(2)
  })

  it('evaluate returns empty when no rules have enough data', () => {
    tracker.recordApplication('rule-test', true)
    const result = tracker.evaluate()
    expect(result.upgrades).toEqual([])
    expect(result.degradations).toEqual([])
    expect(result.disables).toEqual([])
  })

  it('evaluate does not degrade rules that are working', () => {
    // 10 successes in a row
    for (let i = 0; i < 10; i++) {
      tracker.recordApplication('rule-good', true)
    }
    const result = tracker.evaluate()
    expect(result.degradations).toEqual([])
    expect(result.disables).toEqual([])
  })

  it('persist and load roundtrip', () => {
    tracker.recordApplication('rule-test', true)
    tracker.recordApplication('rule-test', false)
    tracker.persist()

    const tracker2 = new EffectivenessTracker(storePath)
    tracker2.load()
    const eff = tracker2.getEffectiveness('rule-test')
    expect(eff).toBeDefined()
    expect(eff!.appliedCount).toBe(2)
    expect(eff!.successAfterCount).toBe(1)
  })

  it('records evaluation history', () => {
    for (let i = 0; i < 10; i++) {
      tracker.recordApplication('rule-test', i < 5) // 5 success, 5 failure
    }
    // Force evaluation by checking
    tracker.evaluate()
    const eff = tracker.getEffectiveness('rule-test')
    expect(eff).toBeDefined()
    expect(eff!.evaluationHistory.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/cli && pnpm test test/agent/effectiveness-tracker.test.ts`
Expected: FAIL

- [ ] **Step 3: Write EffectivenessTracker**

```typescript
// apps/cli/src/agent/effectiveness-tracker.ts
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

export interface RuleEffectiveness {
  ruleId: string
  appliedCount: number
  successAfterCount: number
  preRuleFailureRate: number
  postRuleFailureRate: number
  status: 'active' | 'degrading' | 'disabled'
  createdAt: string
  lastEvaluatedAt: string
  evaluationHistory: Array<{
    date: string
    appliedCount: number
    failureRate: number
  }>
}

const EVAL_THRESHOLD = 10  // evaluate after 10 applications
const DEGRADE_THRESHOLD = 10  // 10 more applications with no improvement → degrade
const STORE_FILE = 'effectiveness.json'

export class EffectivenessTracker {
  private data: Map<string, RuleEffectiveness>
  private storePath: string

  constructor(storeDir: string = join(process.env.HOME || '~', '.mipham', 'rule-engine')) {
    this.storePath = join(storeDir, STORE_FILE)
    this.data = new Map()
  }

  recordApplication(ruleId: string, success: boolean): void {
    let eff = this.data.get(ruleId)
    if (!eff) {
      eff = {
        ruleId,
        appliedCount: 0,
        successAfterCount: 0,
        preRuleFailureRate: 1.0,
        postRuleFailureRate: 0,
        status: 'active',
        createdAt: new Date().toISOString().slice(0, 10),
        lastEvaluatedAt: '',
        evaluationHistory: [],
      }
      this.data.set(ruleId, eff)
    }

    eff.appliedCount++
    if (success) eff.successAfterCount++

    // Calculate current failure rate over last EVAL_THRESHOLD entries
    if (eff.appliedCount >= EVAL_THRESHOLD) {
      const recentWindow = Math.min(eff.appliedCount, 20)
      eff.postRuleFailureRate = 1 - eff.successAfterCount / eff.appliedCount
    }
  }

  evaluate(): { upgrades: string[]; degradations: string[]; disables: string[] } {
    const result = { upgrades: [] as string[], degradations: [] as string[], disables: [] as string[] }
    const now = new Date().toISOString().slice(0, 10)

    for (const [ruleId, eff] of this.data) {
      if (eff.appliedCount < EVAL_THRESHOLD) continue

      eff.lastEvaluatedAt = now
      eff.evaluationHistory.push({
        date: now,
        appliedCount: eff.appliedCount,
        failureRate: eff.postRuleFailureRate,
      })

      // Keep max 10 history entries
      if (eff.evaluationHistory.length > 10) {
        eff.evaluationHistory = eff.evaluationHistory.slice(-10)
      }

      if (eff.status === 'active' && eff.postRuleFailureRate > 0.6) {
        // High failure rate despite rule → degrade
        eff.status = 'degrading'
        result.degradations.push(ruleId)
      } else if (
        eff.status === 'degrading' &&
        eff.evaluationHistory.length >= 2 &&
        eff.evaluationHistory[eff.evaluationHistory.length - 1].failureRate >=
          eff.evaluationHistory[eff.evaluationHistory.length - 2].failureRate
      ) {
        // No improvement after degrading → disable
        eff.status = 'disabled'
        result.disables.push(ruleId)
      } else if (
        eff.status === 'degrading' &&
        eff.postRuleFailureRate < 0.4
      ) {
        // Improved → restore to active
        eff.status = 'active'
        result.upgrades.push(ruleId)
      }
    }

    return result
  }

  getEffectiveness(ruleId: string): RuleEffectiveness | null {
    return this.data.get(ruleId) || null
  }

  persist(): void {
    const dir = dirname(this.storePath)
    mkdirSync(dir, { recursive: true })

    const obj: Record<string, RuleEffectiveness> = {}
    for (const [k, v] of this.data) {
      obj[k] = v
    }
    writeFileSync(this.storePath, JSON.stringify(obj, null, 2), 'utf-8')
  }

  load(): void {
    if (!existsSync(this.storePath)) return
    try {
      const raw = JSON.parse(readFileSync(this.storePath, 'utf-8'))
      this.data = new Map(Object.entries(raw))
    } catch {
      // Corrupt file — start fresh
      this.data = new Map()
    }
  }

  get allRules(): RuleEffectiveness[] {
    return Array.from(this.data.values())
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/cli && pnpm test test/agent/effectiveness-tracker.test.ts`
Expected: all 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/agent/effectiveness-tracker.ts apps/cli/test/agent/effectiveness-tracker.test.ts
git commit -m "feat(crsi): add EffectivenessTracker — rule impact measurement

Tracks each rule's applied count, success rate, and evaluation history.
Auto-evaluates after 10 applications. Degrades rules with >60% failure
rate. Disables rules that show no improvement after degrading.
Persists to ~/.mipham/rule-engine/effectiveness.json.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Wire SessionEnd trigger + full CRSI loop

**Files:**
- Modify: `apps/cli/src/agent/sub-agent.ts` — trigger PatternAnalyzer on SubagentStop
- Modify: `apps/cli/src/ui/commands.ts` — add `/crsi analyze`, `/crsi restore`, `/crsi stats`

**Interfaces:**
- Consumes: `PatternAnalyzer.analyzeAgent()`, `PatternAnalyzer.toToolRule()`, `EffectivenessTracker.recordApplication()`, `ExperienceRuleEngine.register()`, `EffectivenessTracker.evaluate()`, `EffectivenessTracker.getEffectiveness()`

- [ ] **Step 1: Wire PatternAnalyzer + EffectivenessTracker into sub-agent.ts**

In `apps/cli/src/agent/sub-agent.ts`, after the SubagentStop hook callback (around line 77 for background, line 99 for sync), add:

```typescript
import { PatternAnalyzer } from './pattern-analyzer.js'
import { EffectivenessTracker } from './effectiveness-tracker.js'

// Singleton instances (created lazily)
let _patternAnalyzer: PatternAnalyzer | undefined
let _effectivenessTracker: EffectivenessTracker | undefined

function getPatternAnalyzer(): PatternAnalyzer {
  if (!_patternAnalyzer) _patternAnalyzer = new PatternAnalyzer()
  return _patternAnalyzer
}

function getEffectivenessTracker(): EffectivenessTracker {
  if (!_effectivenessTracker) {
    _effectivenessTracker = new EffectivenessTracker()
    _effectivenessTracker.load()
  }
  return _effectivenessTracker
}
```

Then, in the `onComplete` callback for background tasks (after `this.logSuccessExperience` / `this.logFailureExperience` lines), add:

```typescript
// CRSI: trigger pattern analysis after each agent execution
try {
  const analyzer = getPatternAnalyzer()
  const patterns = analyzer.analyzeAgent(agentType)
  if (patterns.length > 0 && this.ruleEngine) {
    for (const pattern of patterns) {
      const toolRule = analyzer.toToolRule(pattern)
      this.ruleEngine.register(toolRule)
    }
  }
} catch {
  // Pattern analysis failure never blocks agent execution
}
```

- [ ] **Step 2: Add /crsi analyze and /crsi stats commands**

In `apps/cli/src/ui/commands.ts`, add:

```typescript
{
  name: 'crsi-analyze',
  command: '/crsi analyze',
  description: 'Manually trigger CRSI pattern analysis across all agents',
  category: 'Tools & Skills',
  handler: async (ctx: CommandContext) => {
    const analyzer = ctx.patternAnalyzer
    const engine = ctx.ruleEngine
    if (!analyzer || !engine) return 'CRSI system is not available.'

    const patterns = analyzer.analyzeAllAgents()
    if (patterns.length === 0) return 'No failure patterns found across agents.'

    let registered = 0
    for (const pattern of patterns) {
      const toolRule = analyzer.toToolRule(pattern)
      engine.register(toolRule)
      registered++
    }

    const lines = [`## CRSI Analysis Complete`, '', `Found ${patterns.length} patterns, ${registered} rules registered.`, '']
    for (const p of patterns) {
      lines.push(`- [${p.category}] \`${p.agentName}\` — ${p.frequency} failures (${p.confidence} confidence)`)
    }
    return lines.join('\n')
  },
},

{
  name: 'crsi-restore',
  command: '/crsi restore',
  description: 'Restore a disabled or degraded CRSI rule',
  category: 'Tools & Skills',
  handler: async (ctx: CommandContext, args?: string) => {
    const engine = ctx.ruleEngine
    if (!engine) return 'CRSI rule engine is not available.'
    if (!args || !args.trim()) return 'Usage: /crsi restore <rule-id>'
    const ruleId = args.trim()
    engine.setRuleEnabled(ruleId, true)
    return `Rule \`${ruleId}\` has been re-enabled.`
  },
},

{
  name: 'crsi-stats',
  command: '/crsi stats',
  description: 'Show CRSI overall effectiveness statistics',
  category: 'Tools & Skills',
  handler: async (ctx: CommandContext) => {
    const engine = ctx.ruleEngine
    const tracker = ctx.effectivenessTracker
    if (!engine) return 'CRSI rule engine is not available.'

    const rules = engine.getActiveRules()
    const lines = ['## CRSI Statistics', '']
    lines.push(`Total active rules: ${rules.length}`)
    lines.push(`Builtin: ${rules.filter(r => r.source === 'builtin').length}`)
    lines.push(`Auto-generated: ${rules.filter(r => r.source === 'pattern-analyzer').length}`)
    lines.push(`Manual: ${rules.filter(r => r.source === 'manual').length}`)

    if (tracker) {
      let totalInterceptions = 0
      let totalSuccesses = 0
      for (const r of rules) {
        const eff = tracker.getEffectiveness(r.id)
        if (eff) {
          totalInterceptions += eff.appliedCount
          totalSuccesses += eff.successAfterCount
        }
      }
      lines.push('')
      lines.push(`Total interceptions: ${totalInterceptions}`)
      lines.push(`Success rate after rules: ${totalInterceptions > 0 ? Math.round(totalSuccesses / totalInterceptions * 100) : 0}%`)
    }

    return lines.join('\n')
  },
},
```

- [ ] **Step 3: Run full test suite**

Run: `cd apps/cli && pnpm test`
Expected: all existing 642+ tests PASS, new tests also PASS (total ~657 tests)

- [ ] **Step 4: Run typecheck**

Run: `cd apps/cli && pnpm typecheck`
Expected: no type errors

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/agent/sub-agent.ts apps/cli/src/ui/commands.ts
git commit -m "feat(crsi): wire full CRSI loop — auto-analysis + stats

PatternAnalyzer triggers after each agent execution, auto-registering
discovered patterns as ToolRules in the RuleEngine. Added /crsi analyze,
/crsi restore, and /crsi stats commands. Full CRSI loop: experience →
pattern → rule → intercept → track → evaluate → auto-evolve.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Feature flags + config integration

**Files:**
- Modify: `apps/cli/src/config/defaults.ts` — add `crsi` section to default config

- [ ] **Step 1: Add CRSI defaults to config**

In `apps/cli/src/config/defaults.ts`, add to the default config object:

```typescript
crsi: {
  ruleInjection: true,
  preToolHook: true,
  autoPatternAnalysis: true,
  autoRuleManagement: true,
},
```

- [ ] **Step 2: Guard all CRSI entry points with feature flags**

In `agent-context.ts` (rule injection), check `config.crsi?.ruleInjection` before extracting rules.
In `rule-engine.ts` and `engine.ts`, check `config.crsi?.preToolHook` before intercepting.
In `sub-agent.ts`, check `config.crsi?.autoPatternAnalysis` before triggering PatternAnalyzer.
In `EffectivenessTracker.evaluate()`, guard auto-degrade with `config.crsi?.autoRuleManagement`.

- [ ] **Step 3: Run typecheck and tests**

Run: `cd apps/cli && pnpm typecheck && pnpm test`
Expected: green

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/config/defaults.ts apps/cli/src/agent/agent-context.ts apps/cli/src/core/rule-engine.ts apps/cli/src/core/engine.ts apps/cli/src/agent/sub-agent.ts apps/cli/src/agent/effectiveness-tracker.ts
git commit -m "feat(crsi): add feature flags for all CRSI subsystems

crsi.ruleInjection, crsi.preToolHook, crsi.autoPatternAnalysis,
crsi.autoRuleManagement — all default true, independently toggleable.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Verification

After all 9 tasks complete, run the full verification:

```bash
cd apps/cli
pnpm typecheck    # must pass with zero errors
pnpm lint         # must pass with zero warnings
pnpm test         # all 642+ existing + 15+ new = ~657 tests, zero failures
pnpm build        # must produce valid binary
```

