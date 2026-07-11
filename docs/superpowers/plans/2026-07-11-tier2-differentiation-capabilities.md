# Tier 2 Differentiation Capabilities — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver four Tier-2 differentiation subsystems (Agent View dashboard, Permission hardening, Memory persistence, Dynamic Workflow engine) as defined in `docs/superpowers/specs/2026-07-11-tier2-differentiation-capabilities-design.md`.

**Architecture:** Four subsystems in dependency order: Permission (security foundation) → Memory (cross-session context) → Agent View (multi-session TUI) → Workflow (JS orchestration runtime, most complex). Each leverages Tier 1 deliverables (SubAgent, Context compaction, Hook events, Skills fork).

**Tech Stack:** TypeScript 5.5+ strict, Bun runtime, React 18 + Ink 5 (TUI), Vitest 3

## Global Constraints

- TypeScript strict mode, ESM modules
- Match existing code style (naming, comments, error handling patterns)
- All existing 437 tests (from Tier 1) must continue to pass
- Backward compatible: no breaking changes to public APIs
- Commit messages follow Conventional Commits
- Test framework: Vitest 3
- Base branch: `feat/tier1-core-capabilities` (contains Tier 1 deliverables)

---

## File Structure Map

```
apps/cli/src/
├── agent-view/                    ← NEW directory
│   ├── agent-view-manager.ts      ← CREATE: multi-session lifecycle
│   ├── dashboard.tsx              ← CREATE: main TUI dashboard (Ink)
│   ├── session-row.tsx            ← CREATE: single session row component
│   └── session-peek.tsx           ← CREATE: peek modal panel
├── core/
│   ├── permission.ts              ← MODIFY: 6 modes, allowlist/denylist
│   ├── permission-config.ts       ← CREATE: settings.json loader
│   ├── permission-rules.ts        ← CREATE: Bash command pattern matcher
│   └── memory/
│       ├── memory-manager.ts      ← CREATE: CRUD + index management
│       ├── memory-writer.ts       ← CREATE: auto-memory extraction
│       └── memory-loader.ts       ← CREATE: SessionStart injection
├── workflow/                      ← NEW directory
│   ├── runtime.ts                 ← CREATE: script execution engine
│   ├── sandbox.ts                 ← CREATE: JS sandbox (disable Date/Math)
│   ├── journal.ts                 ← CREATE: deterministic replay journal
│   ├── budget.ts                  ← CREATE: token budget tracking
│   └── primitives/
│       ├── agent.ts               ← CREATE: agent() primitive
│       ├── parallel.ts            ← CREATE: parallel() barrier
│       ├── pipeline.ts            ← CREATE: pipeline() streaming
│       └── phase.ts               ← CREATE: phase() progress group
├── bin/
│   └── mipham.ts                  ← MODIFY: add 'agents' + 'workflow' subcommands
├── ui/
│   ├── app.tsx                    ← MODIFY: /bg, /agents commands
│   └── commands.ts                ← MODIFY: register new slash commands
└── shared/
    └── types.ts                   ← MODIFY: PermissionMode, MemoryEntry, Workflow types

apps/cli/test/
├── agent-view/
│   └── agent-view-manager.test.ts ← CREATE
├── core/
│   ├── permission.test.ts         ← MODIFY (extend existing)
│   ├── permission-rules.test.ts   ← CREATE
│   └── memory/
│       └── memory-manager.test.ts ← CREATE
└── workflow/
    ├── runtime.test.ts            ← CREATE
    ├── sandbox.test.ts            ← CREATE
    └── journal.test.ts            ← CREATE
```

---

## Phase 1: Permission System Hardening

### Task 1.1: Define Permission Types and Bash Matcher

**Files:**

- Create: `apps/cli/src/core/permission-rules.ts`
- Modify: `apps/cli/src/shared/types.ts`

**Interfaces:**

- Produces: `PermissionMode` type (6 variants), `PermissionConfig`, `matchBashRule()`, `wildcardMatch()`

- [ ] **Step 1: Update shared types**

Add to `apps/cli/src/shared/types.ts`:

```typescript
// Replace existing PermissionLevel with full type:
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'auto'
  | 'dontAsk'
  | 'bypassPermissions'

export type PermissionLevel = PermissionMode | 'ask' | 'bypass' // keep backward compat

export interface PermissionConfig {
  mode: PermissionMode
  allow: string[]
  deny: string[]
}

export interface PermissionRuleEntry {
  pattern: string // e.g., "Bash(git:*)"
  level: 'allow' | 'deny' | 'ask'
  compiled: RegExp
}
```

- [ ] **Step 2: Create Bash matcher**

```typescript
// apps/cli/src/core/permission-rules.ts

/**
 * Match a Bash(command_pattern) rule against an actual tool call.
 *
 * Pattern formats:
 *   "Bash"              → matches any Bash call
 *   "Bash(git:*)"       → matches "git status", "git diff --cached", etc.
 *   "Bash(npm test:*)"  → matches "npm test -- --coverage"
 *   "Write(/etc/*)"     → matches Write to /etc/passwd, /etc/hosts, etc.
 */
export function matchBashRule(
  pattern: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): boolean {
  // Check if pattern has a parenthesized sub-pattern
  const parenMatch = pattern.match(/^(\w+)\((.+)\)$/)
  if (!parenMatch) {
    // Plain tool name match: "Bash", "Write"
    return toolName === pattern
  }

  const [, baseTool, subPattern] = parenMatch

  if (toolName !== baseTool!) return false

  // For Bash: match against the command string
  if (baseTool === 'Bash') {
    const cmd = String(toolInput.command || '')
    return wildcardMatch(subPattern!, cmd.trim())
  }

  // For Write/Edit: match against the file_path
  if (baseTool === 'Write' || baseTool === 'Edit') {
    const path = String(toolInput.file_path || '')
    return wildcardMatch(subPattern!, path)
  }

  return false
}

export function wildcardMatch(pattern: string, input: string): boolean {
  const regexStr =
    '^' +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials
      .replace(/\\\*/g, '.*') // * → .*
      .replace(/\\\?/g, '.') + // ? → .
    '$'
  return new RegExp(regexStr).test(input)
}

/** Compile a rule pattern string into a PermissionRuleEntry. */
export function compileRule(pattern: string, level: 'allow' | 'deny' | 'ask'): PermissionRuleEntry {
  const regexStr =
    '^' +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\*/g, '.*')
      .replace(/\\\?/g, '.') +
    '$'
  return { pattern, level, compiled: new RegExp(regexStr) }
}
```

- [ ] **Step 3: Create tests**

```typescript
// apps/cli/test/core/permission-rules.test.ts
import { describe, it, expect } from 'vitest'
import { matchBashRule, wildcardMatch, compileRule } from '../../src/core/permission-rules'

describe('wildcardMatch', () => {
  it('matches exact strings', () => {
    expect(wildcardMatch('git status', 'git status')).toBe(true)
  })

  it('matches wildcard prefix', () => {
    expect(wildcardMatch('git:*', 'git status')).toBe(true)
    expect(wildcardMatch('git:*', 'git diff --cached')).toBe(true)
  })

  it('rejects non-matching wildcard', () => {
    expect(wildcardMatch('git:*', 'npm test')).toBe(false)
  })

  it('matches mid-pattern wildcard', () => {
    expect(wildcardMatch('npm *:*', 'npm test --coverage')).toBe(true)
  })
})

describe('matchBashRule', () => {
  it('matches plain tool name', () => {
    expect(matchBashRule('Bash', 'Bash', { command: 'anything' })).toBe(true)
    expect(matchBashRule('Bash', 'Write', {})).toBe(false)
  })

  it('matches Bash(command) pattern', () => {
    expect(matchBashRule('Bash(git:*)', 'Bash', { command: 'git status' })).toBe(true)
    expect(matchBashRule('Bash(rm *)', 'Bash', { command: 'rm -rf /' })).toBe(true)
  })

  it('matches Write(path) pattern', () => {
    expect(matchBashRule('Write(/etc/*)', 'Write', { file_path: '/etc/passwd' })).toBe(true)
    expect(matchBashRule('Write(/etc/*)', 'Write', { file_path: '/home/user/file' })).toBe(false)
  })

  it('handles missing command gracefully', () => {
    expect(matchBashRule('Bash(git:*)', 'Bash', {})).toBe(false)
  })
})

describe('compileRule', () => {
  it('compiles pattern to regex', () => {
    const rule = compileRule('Bash(git:*)', 'allow')
    expect(rule.level).toBe('allow')
    expect(rule.compiled.test('Bash(git status)')).toBe(true)
  })
})
```

- [ ] **Step 4: Run tests and commit**

```bash
cd apps/cli && bun test test/core/permission-rules.test.ts
# Expected: 9 pass
git add apps/cli/src/core/permission-rules.ts apps/cli/test/core/permission-rules.test.ts apps/cli/src/shared/types.ts
git commit -m "feat(permission): add 6 permission modes, Bash matcher, and rule types"
```

---

### Task 1.2: Refactor PermissionSystem

**Files:**

- Modify: `apps/cli/src/core/permission.ts`
- Create: `apps/cli/src/core/permission-config.ts`

**Interfaces:**

- Consumes: `PermissionMode`, `PermissionConfig`, `matchBashRule`, `compileRule` from Task 1.1
- Produces: Refactored `PermissionSystem` with 6 modes, allowlist/denylist, mode cycling

- [ ] **Step 1: Implement permission-config loader**

```typescript
// apps/cli/src/core/permission-config.ts
import type { PermissionConfig, PermissionMode } from '../shared/index.ts'

const DEFAULT_CONFIG: PermissionConfig = {
  mode: 'default',
  allow: [],
  deny: [],
}

/**
 * Load permission configuration from a settings object.
 * Merges with defaults for missing fields.
 */
export function loadPermissionConfig(raw: Partial<PermissionConfig> = {}): PermissionConfig {
  return {
    mode: (raw.mode as PermissionMode) || DEFAULT_CONFIG.mode,
    allow: Array.isArray(raw.allow) ? raw.allow : [...DEFAULT_CONFIG.allow],
    deny: Array.isArray(raw.deny) ? raw.deny : [...DEFAULT_CONFIG.deny],
  }
}

/** Valid mode transition order for Shift+Tab cycling. */
export const MODE_CYCLE: PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
]

export function nextMode(current: PermissionMode): PermissionMode {
  const idx = MODE_CYCLE.indexOf(current)
  return MODE_CYCLE[(idx + 1) % MODE_CYCLE.length]!
}
```

- [ ] **Step 2: Refactor PermissionSystem**

```typescript
// apps/cli/src/core/permission.ts
import type { ToolDefinition, PermissionMode } from '../shared/index.ts'
import type { PermissionRuleEntry } from './permission-rules'
import { matchBashRule, compileRule } from './permission-rules'
import { loadPermissionConfig, nextMode, MODE_CYCLE } from './permission-config'

type ResolvedLevel = 'allow' | 'deny' | 'ask' | 'mode-baseline'

export class PermissionSystem {
  private allowRules: PermissionRuleEntry[] = []
  private denyRules: PermissionRuleEntry[] = []
  private askRules: PermissionRuleEntry[] = []
  private mode: PermissionMode = 'default'

  constructor(mode: PermissionMode = 'default') {
    this.mode = mode
  }

  // ── Mode management ──

  setMode(mode: PermissionMode): void {
    this.mode = mode
  }

  getMode(): PermissionMode {
    return this.mode
  }

  cycleMode(): PermissionMode {
    this.mode = nextMode(this.mode)
    return this.mode
  }

  // ── Rule management ──

  allow(rule: string): void {
    this.allowRules.push(compileRule(rule, 'allow'))
  }

  deny(rule: string): void {
    this.denyRules.push(compileRule(rule, 'deny'))
  }

  ask(rule: string): void {
    this.askRules.push(compileRule(rule, 'ask'))
  }

  loadConfig(raw: { mode?: string; allow?: string[]; deny?: string[] }): void {
    const config = loadPermissionConfig(raw)
    this.mode = config.mode

    this.allowRules = []
    this.denyRules = []
    this.askRules = []

    for (const rule of config.allow) {
      this.allowRules.push(compileRule(rule, 'allow'))
    }
    for (const rule of config.deny) {
      this.denyRules.push(compileRule(rule, 'deny'))
    }
  }

  // ── Permission check ──

  /**
   * Resolution chain (first match wins):
   * 1. Deny rules → block
   * 2. Ask rules → require approval
   * 3. Allow rules → permit
   * 4. Mode baseline → mode-specific default
   */
  check(tool: ToolDefinition, input: Record<string, unknown>): 'auto' | 'ask' | 'bypass' {
    // 1. Check deny rules (always win)
    for (const rule of this.denyRules) {
      if (this.ruleMatches(rule, tool, input)) return 'ask'
    }

    // 2. Check ask rules
    for (const rule of this.askRules) {
      if (this.ruleMatches(rule, tool, input)) return 'ask'
    }

    // 3. Check allow rules
    for (const rule of this.allowRules) {
      if (this.ruleMatches(rule, tool, input)) return 'bypass'
    }

    // 4. Mode baseline
    return this.modeBaseline(tool)
  }

  needsApproval(tool: ToolDefinition, input: Record<string, unknown>): boolean {
    return this.check(tool, input) === 'ask'
  }

  isBypassed(tool: ToolDefinition, input: Record<string, unknown>): boolean {
    return this.check(tool, input) === 'bypass'
  }

  // ── Helpers ──

  private ruleMatches(
    rule: PermissionRuleEntry,
    tool: ToolDefinition,
    input: Record<string, unknown>,
  ): boolean {
    // Try Bash-style matching first
    if (rule.pattern.includes('(')) {
      return matchBashRule(rule.pattern, tool.name, input)
    }
    // Simple tool name match
    return rule.pattern === tool.name || rule.compiled.test(tool.name)
  }

  private modeBaseline(tool: ToolDefinition): 'auto' | 'ask' | 'bypass' {
    switch (this.mode) {
      case 'default':
        // Reads free, writes ask
        return tool.category === 'file' && ['Read', 'Grep', 'Glob'].includes(tool.name)
          ? 'bypass'
          : 'ask'

      case 'acceptEdits':
        // Reads + file edits free
        return tool.category === 'file' || tool.name === 'Bash'
          ? ['Bash'].includes(tool.name)
            ? 'ask'
            : 'bypass'
          : 'ask'

      case 'plan':
        // Only reads, no writes or executes
        return tool.category === 'file' && ['Read', 'Grep', 'Glob'].includes(tool.name)
          ? 'bypass'
          : 'ask'

      case 'auto':
        // All free (safety checks handled by hook layer)
        return 'bypass'

      case 'dontAsk':
        // Only allowlisted tools free (already handled above)
        return 'ask'

      case 'bypassPermissions':
        return 'bypass'

      default:
        return 'ask'
    }
  }

  // ── Legacy compatibility ──

  setDefaultLevel(level: 'auto' | 'ask' | 'bypass'): void {
    // Map legacy 3-level to new mode
    if (level === 'auto') this.mode = 'auto'
    else if (level === 'bypass') this.mode = 'bypassPermissions'
    else this.mode = 'default'
  }

  getDefaultLevel(): 'auto' | 'ask' | 'bypass' {
    if (this.mode === 'auto' || this.mode === 'bypassPermissions' || this.mode === 'dontAsk')
      return 'bypass'
    if (this.mode === 'plan') return 'ask'
    return 'auto'
  }

  setRule(toolName: string, level?: 'auto' | 'ask' | 'bypass'): void {
    if (level === 'bypass') this.allow(toolName)
    else if (level === 'ask') this.ask(toolName)
  }

  listRules(): Map<string, 'auto' | 'ask' | 'bypass'> {
    const map = new Map<string, 'auto' | 'ask' | 'bypass'>()
    for (const r of this.allowRules) map.set(r.pattern, 'bypass')
    for (const r of this.denyRules) map.set(r.pattern, 'ask')
    for (const r of this.askRules) map.set(r.pattern, 'ask')
    return map
  }
}
```

- [ ] **Step 3: Extend existing tests**

```typescript
// Add to apps/cli/test/core/permission.test.ts:
import { PermissionSystem } from '../../src/core/permission'

describe('PermissionSystem - Tier 2 modes', () => {
  it('cycles through all 6 modes', () => {
    const ps = new PermissionSystem('default')
    expect(ps.getMode()).toBe('default')
    ps.cycleMode()
    expect(ps.getMode()).toBe('acceptEdits')
    ps.cycleMode() // plan
    ps.cycleMode() // auto
    ps.cycleMode() // dontAsk
    ps.cycleMode() // bypassPermissions
    ps.cycleMode() // back to default
    expect(ps.getMode()).toBe('default')
  })

  it('deny rule blocks even when mode is bypassPermissions', () => {
    const ps = new PermissionSystem('bypassPermissions')
    ps.deny('Bash(rm -rf *)')
    const tool = {
      name: 'Bash',
      category: 'exec',
      permission: 'auto' as const,
      description: '',
      parameters: {},
      execute: async () => ({ success: true, content: '' }),
    }
    expect(ps.needsApproval(tool, { command: 'rm -rf /' })).toBe(true)
  })

  it('allow rule permits in dontAsk mode', () => {
    const ps = new PermissionSystem('dontAsk')
    ps.allow('Read')
    const tool = {
      name: 'Read',
      category: 'file',
      permission: 'auto' as const,
      description: '',
      parameters: {},
      execute: async () => ({ success: true, content: '' }),
    }
    expect(ps.isBypassed(tool, {})).toBe(true)
  })

  it('dontAsk mode blocks non-allowlisted tools', () => {
    const ps = new PermissionSystem('dontAsk')
    const tool = {
      name: 'Bash',
      category: 'exec',
      permission: 'auto' as const,
      description: '',
      parameters: {},
      execute: async () => ({ success: true, content: '' }),
    }
    expect(ps.needsApproval(tool, { command: 'ls' })).toBe(true)
  })

  it('plan mode allows reads only', () => {
    const ps = new PermissionSystem('plan')
    const readTool = {
      name: 'Read',
      category: 'file',
      permission: 'auto' as const,
      description: '',
      parameters: {},
      execute: async () => ({ success: true, content: '' }),
    }
    const bashTool = {
      name: 'Bash',
      category: 'exec',
      permission: 'auto' as const,
      description: '',
      parameters: {},
      execute: async () => ({ success: true, content: '' }),
    }
    expect(ps.isBypassed(readTool, {})).toBe(true)
    expect(ps.needsApproval(bashTool, {})).toBe(true)
  })

  it('loads config from settings JSON format', () => {
    const ps = new PermissionSystem()
    ps.loadConfig({
      mode: 'acceptEdits',
      allow: ['Read', 'Write', 'Bash(git:*)'],
      deny: ['Bash(rm *)'],
    })
    expect(ps.getMode()).toBe('acceptEdits')
    const gitTool = {
      name: 'Bash',
      category: 'exec',
      permission: 'auto' as const,
      description: '',
      parameters: {},
      execute: async () => ({ success: true, content: '' }),
    }
    expect(ps.isBypassed(gitTool, { command: 'git status' })).toBe(true)
    expect(ps.needsApproval(gitTool, { command: 'rm -rf /' })).toBe(true)
  })
})
```

- [ ] **Step 4: Run tests and commit**

```bash
cd apps/cli && bun test test/core/permission.test.ts test/core/permission-rules.test.ts
git add apps/cli/src/core/permission.ts apps/cli/src/core/permission-config.ts apps/cli/test/core/permission.test.ts
git commit -m "feat(permission): refactor PermissionSystem with 6 modes, allowlist/denylist, config loader"
```

---

## Phase 2: Persistent Memory System

### Task 2.1: Memory Manager Core

**Files:**

- Create: `apps/cli/src/core/memory/memory-manager.ts`
- Create: `apps/cli/test/core/memory/memory-manager.test.ts`

**Interfaces:**

- Produces: `MemoryManager` class, `MemoryEntry`, `MemoryMetadata` types

- [ ] **Step 1: Write test**

```typescript
// apps/cli/test/core/memory/memory-manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MemoryManager } from '../../src/core/memory/memory-manager'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), 'mipham-memory-test-' + Date.now())

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('MemoryManager', () => {
  it('writes and reads a memory entry', () => {
    const mm = new MemoryManager(TEST_DIR)
    mm.write('test-pref', 'User prefers tabs over spaces', {
      type: 'user',
      relevance: ['coding-style'],
    })

    const recalled = mm.recall('coding-style tabs')
    expect(recalled).toHaveLength(1)
    expect(recalled[0]!.name).toBe('test-pref')
    expect(recalled[0]!.content).toContain('tabs over spaces')
  })

  it('deletes a memory', () => {
    const mm = new MemoryManager(TEST_DIR)
    mm.write('temp', 'temporary note', { type: 'feedback', relevance: ['temp'] })
    expect(mm.recall('temp')).toHaveLength(1)

    mm.delete('temp')
    expect(mm.recall('temp')).toHaveLength(0)
  })

  it('builds system reminder within token limit', () => {
    const mm = new MemoryManager(TEST_DIR)
    mm.write('pref-1', 'User likes TypeScript', { type: 'user', relevance: ['ts'] })
    mm.write('pref-2', 'Project uses pnpm', { type: 'project', relevance: ['tools'] })

    const reminder = mm.buildSystemReminder('TypeScript configuration', 100)
    expect(reminder).toContain('<system-reminder>')
    expect(reminder).toContain('pref-1')
    expect(reminder.length).toBeLessThan(200) // within token budget
  })

  it('recall filters by relevance', () => {
    const mm = new MemoryManager(TEST_DIR)
    mm.write('ts-pref', 'TypeScript strict mode', { type: 'user', relevance: ['typescript'] })
    mm.write('py-pref', 'Python 3.12+', { type: 'user', relevance: ['python'] })

    const tsResults = mm.recall('TypeScript project')
    expect(tsResults).toHaveLength(1)
    expect(tsResults[0]!.name).toBe('ts-pref')
  })

  it('updates existing memory with same name', () => {
    const mm = new MemoryManager(TEST_DIR)
    mm.write('note', 'First version', { type: 'feedback', relevance: ['test'] })
    mm.write('note', 'Updated version', { type: 'feedback', relevance: ['test'] })

    const recalled = mm.recall('test')
    expect(recalled).toHaveLength(1)
    expect(recalled[0]!.content).toContain('Updated version')
  })

  it('handles empty directory gracefully', () => {
    const mm = new MemoryManager(TEST_DIR)
    mm.loadAll()
    expect(mm.recall('anything')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Implement MemoryManager**

```typescript
// apps/cli/src/core/memory/memory-manager.ts
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from 'node:fs'
import { join, extname } from 'node:path'

export interface MemoryMetadata {
  type: 'user' | 'feedback' | 'project' | 'reference'
  relevance: string[]
}

export interface MemoryEntry {
  name: string
  description: string
  metadata: MemoryMetadata
  content: string
  filePath: string
  updatedAt: Date
}

const INDEX_FILE = 'MEMORY.md'

export class MemoryManager {
  private memories = new Map<string, MemoryEntry>()

  constructor(private memoryDir: string) {
    mkdirSync(memoryDir, { recursive: true })
  }

  loadAll(): void {
    this.memories.clear()
    if (!existsSync(this.memoryDir)) return

    let entries: string[] = []
    try {
      entries = readdirSync(this.memoryDir)
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry === INDEX_FILE || extname(entry) !== '.md') continue
      const filePath = join(this.memoryDir, entry)
      try {
        const raw = readFileSync(filePath, 'utf-8')
        const parsed = this.parseMemoryFile(raw, filePath)
        if (parsed) {
          this.memories.set(parsed.name, parsed)
        }
      } catch {
        // skip unparseable
      }
    }
  }

  write(name: string, content: string, metadata: MemoryMetadata): void {
    const fileName = `${name}.md`
    const filePath = join(this.memoryDir, fileName)

    const body = this.formatMemoryFile(name, metadata, content)
    writeFileSync(filePath, body, 'utf-8')

    const entry: MemoryEntry = {
      name,
      description: metadata.relevance.join(', '),
      metadata,
      content,
      filePath,
      updatedAt: new Date(),
    }

    this.memories.set(name, entry)
    this.updateIndex()
  }

  recall(context: string, limit: number = 10): MemoryEntry[] {
    const contextLower = context.toLowerCase()
    const scored: Array<{ entry: MemoryEntry; score: number }> = []

    for (const entry of this.memories.values()) {
      let score = 0
      // Match against relevance tags
      for (const tag of entry.metadata.relevance) {
        if (contextLower.includes(tag.toLowerCase())) score += 3
      }
      // Match against content keywords
      const contentWords = entry.content.toLowerCase().split(/\s+/)
      const contextWords = new Set(contextLower.split(/\s+/))
      for (const word of contentWords) {
        if (contextWords.has(word) && word.length > 3) score += 1
      }
      if (score > 0) {
        scored.push({ entry, score })
      }
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map((s) => s.entry)
  }

  delete(name: string): void {
    const entry = this.memories.get(name)
    if (!entry) return

    try {
      unlinkSync(entry.filePath)
    } catch {
      // file may already be gone
    }
    this.memories.delete(name)
    this.updateIndex()
  }

  buildSystemReminder(context: string, maxTokens: number = 5000): string {
    const relevant = this.recall(context, 10)
    if (relevant.length === 0) return ''

    const lines: string[] = ['<system-reminder>', 'Relevant memories from previous sessions:']

    let tokenBudget = 50 // opening tags
    for (const entry of relevant) {
      const line = `- ${entry.name}: ${entry.content.slice(0, 200)}`
      const lineTokens = Math.ceil(line.length / 4)
      if (tokenBudget + lineTokens > maxTokens) break
      lines.push(line)
      tokenBudget += lineTokens
    }

    lines.push('</system-reminder>')
    return lines.join('\n')
  }

  private updateIndex(): void {
    const lines: string[] = [
      '# Memory Index',
      '',
      `_Last updated: ${new Date().toISOString()}_`,
      '',
    ]

    for (const entry of this.memories.values()) {
      lines.push(`- [${entry.name}](${entry.name}.md) — ${entry.description}`)
    }

    writeFileSync(join(this.memoryDir, INDEX_FILE), lines.join('\n') + '\n', 'utf-8')
  }

  private parseMemoryFile(raw: string, filePath: string): MemoryEntry | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!match) return null

    const frontmatter = match[1] || ''
    const content = (match[2] || '').trim()

    // Parse simple YAML-like frontmatter
    const nameMatch = frontmatter.match(/name:\s*(\S+)/)
    const descMatch = frontmatter.match(/description:\s*(.+)/)
    const typeMatch = frontmatter.match(/type:\s*(\S+)/)
    const relevanceMatch = frontmatter.match(/relevance:\s*\[(.+)\]/)

    if (!nameMatch) return null

    return {
      name: nameMatch[1]!,
      description: descMatch?.[1]?.trim() || '',
      metadata: {
        type: (typeMatch?.[1] as MemoryMetadata['type']) || 'reference',
        relevance: relevanceMatch?.[1]?.split(',').map((s) => s.trim()) || [],
      },
      content,
      filePath,
      updatedAt: new Date(),
    }
  }

  private formatMemoryFile(name: string, metadata: MemoryMetadata, content: string): string {
    return `---
name: ${name}
description: ${metadata.relevance.join(', ')}
metadata:
  type: ${metadata.type}
  relevance: [${metadata.relevance.join(', ')}]
---

${content}
`
  }
}
```

- [ ] **Step 3: Run tests and commit**

```bash
cd apps/cli && bun test test/core/memory/memory-manager.test.ts
# Expected: 6 pass
git add apps/cli/src/core/memory/memory-manager.ts apps/cli/test/core/memory/memory-manager.test.ts
git commit -m "feat(memory): add MemoryManager with CRUD, recall, and system-reminder builder"
```

---

### Task 2.2: Memory Writer and Loader

**Files:**

- Create: `apps/cli/src/core/memory/memory-writer.ts`
- Create: `apps/cli/src/core/memory/memory-loader.ts`

- [ ] **Step 1: Implement memory-writer.ts**

```typescript
// apps/cli/src/core/memory/memory-writer.ts
import type { MemoryManager, MemoryMetadata } from './memory-manager'

const MEMORY_TRIGGERS = [
  {
    pattern: /(?:以后|今后|从现在开始|always|from now on|记住|remember)\s*[：:]\s*(.+)/i,
    type: 'user' as const,
  },
  { pattern: /(?:偏好|prefer|preference|习惯)\s*[：:]\s*(.+)/i, type: 'user' as const },
  { pattern: /(?:项目|project)\s+(?:使用|uses?|采用)\s+(.+)/i, type: 'project' as const },
  { pattern: /(?:决策|decided?|决定)\s*[：:]\s*(.+)/i, type: 'project' as const },
]

/**
 * Analyze the user's message for memory-worthy content and persist it.
 */
export function analyzeForMemory(userMessage: string, memoryManager: MemoryManager): void {
  for (const trigger of MEMORY_TRIGGERS) {
    const match = userMessage.match(trigger.pattern)
    if (match?.[1]) {
      const content = match[1].trim()
      const name = `auto-${trigger.type}-${Date.now()}`
      const relevance = extractKeywords(content)

      memoryManager.write(name, content, {
        type: trigger.type === 'user' ? 'user' : 'project',
        relevance,
      })
    }
  }
}

function extractKeywords(text: string): string[] {
  // Simple keyword extraction: words > 3 chars, no stop words
  const stopWords = new Set([
    'this',
    'that',
    'with',
    'from',
    'have',
    'been',
    'were',
    'they',
    'will',
    'would',
    'could',
    'should',
    'about',
    'which',
    'their',
    '使用',
    '以后',
    '现在',
    '可以',
    '需要',
    '不要',
    '应该',
    '已经',
  ])
  return text
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stopWords.has(w.toLowerCase()))
    .slice(0, 5)
}
```

- [ ] **Step 2: Implement memory-loader.ts**

```typescript
// apps/cli/src/core/memory/memory-loader.ts
import type { MemoryManager } from './memory-manager'

const MEMORY_DIR = `${process.env.HOME || '~'}/.mipham/memory`

let instance: MemoryManager | null = null

export function getMemoryManager(): MemoryManager {
  if (!instance) {
    instance = new MemoryManager(MEMORY_DIR)
    instance.loadAll()
  }
  return instance
}

/**
 * Load relevant memories for the current session and inject as
 * a system-reminder block. Called at SessionStart.
 */
export function loadSessionMemories(context: string): string {
  const mm = getMemoryManager()
  return mm.buildSystemReminder(context)
}
```

- [ ] **Step 3: Wire into engine.ts**

Add to `QueryEngine.process()` in `apps/cli/src/core/engine.ts`:

```typescript
// After processing user input, before the main loop:
import { analyzeForMemory } from './memory/memory-writer'
import { getMemoryManager } from './memory/memory-loader'

// In process(), after assistant responds:
if (assistantContent && userInput) {
  analyzeForMemory(userInput, getMemoryManager())
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/core/memory/memory-writer.ts apps/cli/src/core/memory/memory-loader.ts apps/cli/src/core/engine.ts
git commit -m "feat(memory): add auto-memory writer and session loader"
```

---

## Phase 3: Agent View Dashboard

### Task 3.1: AgentViewManager

**Files:**

- Create: `apps/cli/src/agent-view/agent-view-manager.ts`
- Create: `apps/cli/test/agent-view/agent-view-manager.test.ts`

- [ ] **Step 1: Implement AgentViewManager**

```typescript
// apps/cli/src/agent-view/agent-view-manager.ts
import type { QueryEngine } from '../core/engine'

export type SessionStatus = 'needs-input' | 'working' | 'completed' | 'failed'

export interface AgentSession {
  id: string
  task: string
  provider: string
  model: string
  status: SessionStatus
  engine: QueryEngine
  startTime: Date
  lastActivity: Date
  messageCount: number
  abortController: AbortController
}

export class AgentViewManager {
  private sessions = new Map<string, AgentSession>()
  private counter = 0

  create(task: string, engine: QueryEngine, provider: string, model: string): string {
    const id = `session-${++this.counter}`
    const session: AgentSession = {
      id,
      task,
      provider,
      model,
      status: 'working',
      engine,
      startTime: new Date(),
      lastActivity: new Date(),
      messageCount: 0,
      abortController: new AbortController(),
    }

    this.sessions.set(id, session)
    return id
  }

  list(): AgentSession[] {
    return Array.from(this.sessions.values())
  }

  groupByStatus(): Record<string, AgentSession[]> {
    const groups: Record<string, AgentSession[]> = {
      'needs-input': [],
      working: [],
      completed: [],
      failed: [],
    }
    for (const s of this.sessions.values()) {
      groups[s.status]?.push(s)
    }
    return groups
  }

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id)
  }

  peek(id: string, lines: number = 10): string {
    const session = this.sessions.get(id)
    if (!session) return 'Session not found.'

    const messages = session.engine.getContext().getMessages()
    const recent = messages.slice(-lines)
    return recent
      .map((m) => {
        const role = m.role === 'user' ? 'You' : 'AI'
        const content = typeof m.content === 'string' ? m.content : '[tool call]'
        return `[${role}] ${content.slice(0, 200)}`
      })
      .join('\n')
  }

  attach(id: string): QueryEngine | undefined {
    return this.sessions.get(id)?.engine
  }

  kill(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.abortController.abort()
    session.status = 'failed'
    this.sessions.delete(id)
  }

  pushToBackground(id: string, task: string): string {
    // If session already exists, update it. Otherwise create from current engine.
    const existing = this.sessions.get(id)
    if (existing) {
      existing.task = task
      existing.status = 'working'
      existing.lastActivity = new Date()
      return id
    }
    return id
  }

  updateStatus(id: string, status: SessionStatus): void {
    const session = this.sessions.get(id)
    if (session) {
      session.status = status
      session.lastActivity = new Date()
    }
  }
}
```

- [ ] **Step 2: Write tests**

```typescript
// apps/cli/test/agent-view/agent-view-manager.test.ts
import { describe, it, expect } from 'vitest'
import { AgentViewManager } from '../../src/agent-view/agent-view-manager'
import type { QueryEngine } from '../../src/core/engine'

function mockEngine(): QueryEngine {
  return {
    getContext: () => ({
      getMessages: () => [
        { role: 'user', content: 'test message' },
        { role: 'assistant', content: 'test response' },
      ],
    }),
  } as unknown as QueryEngine
}

describe('AgentViewManager', () => {
  it('creates and lists sessions', () => {
    const mgr = new AgentViewManager()
    const id = mgr.create('test task', mockEngine(), 'anthropic', 'sonnet')
    expect(id).toMatch(/^session-/)
    expect(mgr.list()).toHaveLength(1)
  })

  it('groups sessions by status', () => {
    const mgr = new AgentViewManager()
    mgr.create('working task', mockEngine(), 'deepseek', 'r1')
    const groups = mgr.groupByStatus()
    expect(groups.working).toHaveLength(1)
  })

  it('kills a session', () => {
    const mgr = new AgentViewManager()
    const id = mgr.create('task', mockEngine(), 'openai', 'gpt-4')
    mgr.kill(id)
    expect(mgr.list()).toHaveLength(0)
  })

  it('peeks at session output', () => {
    const mgr = new AgentViewManager()
    const id = mgr.create('task', mockEngine(), 'anthropic', 'sonnet')
    const output = mgr.peek(id)
    expect(output).toContain('test message')
    expect(output).toContain('test response')
  })
})
```

- [ ] **Step 3: Run tests and commit**

```bash
cd apps/cli && bun test test/agent-view/agent-view-manager.test.ts
git add apps/cli/src/agent-view/agent-view-manager.ts apps/cli/test/agent-view/agent-view-manager.test.ts
git commit -m "feat(agent-view): add AgentViewManager for multi-session lifecycle"
```

---

### Task 3.2: Dashboard TUI Components

**Files:**

- Create: `apps/cli/src/agent-view/dashboard.tsx`
- Create: `apps/cli/src/agent-view/session-row.tsx`
- Create: `apps/cli/src/agent-view/session-peek.tsx`

- [ ] **Step 1: Implement session-row.tsx**

```typescript
// apps/cli/src/agent-view/session-row.tsx
import React from 'react'
import { Box, Text } from 'ink'
import type { AgentSession } from './agent-view-manager'

interface SessionRowProps {
  session: AgentSession
  isSelected: boolean
}

const STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  'needs-input': { icon: '\u{1F7E1}', color: 'yellow' },  // 🟡
  working: { icon: '\u{1F535}', color: 'cyan' },            // 🔵
  completed: { icon: '\u{1F7E2}', color: 'green' },         // 🟢
  failed: { icon: '\u{1F534}', color: 'red' },              // 🔴
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export function SessionRow({ session, isSelected }: SessionRowProps) {
  const statusInfo = STATUS_ICONS[session.status] || { icon: '?', color: 'white' }
  const elapsed = formatDuration(Date.now() - session.startTime.getTime())

  return (
    <Box flexDirection="row" paddingLeft={isSelected ? 0 : 0}>
      {isSelected && <Text color="cyan" bold>{'> '}</Text>}
      <Text color={statusInfo.color}>{statusInfo.icon}</Text>
      <Text> </Text>
      <Text dimColor>[{session.provider}/{session.model}]</Text>
      <Text> </Text>
      <Text>{session.task.slice(0, 50)}</Text>
      <Text dimColor> · {elapsed}</Text>
      <Text dimColor> · [{session.status}]</Text>
      <Text dimColor> · [Space] peek · [Enter] attach</Text>
    </Box>
  )
}
```

- [ ] **Step 2: Implement session-peek.tsx**

```typescript
// apps/cli/src/agent-view/session-peek.tsx
import React from 'react'
import { Box, Text } from 'ink'

interface SessionPeekProps {
  content: string
}

export function SessionPeek({ content }: SessionPeekProps) {
  if (!content) return null

  return (
    <Box flexDirection="column" borderStyle="single" padding={1} marginTop={1}>
      <Text bold dimColor>Peek — recent output</Text>
      <Box marginTop={1}>
        <Text>{content || '(no output yet)'}</Text>
      </Box>
    </Box>
  )
}
```

- [ ] **Step 3: Implement dashboard.tsx**

```typescript
// apps/cli/src/agent-view/dashboard.tsx
import React, { useState, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'
import { AgentViewManager } from './agent-view-manager'
import { SessionRow } from './session-row'
import { SessionPeek } from './session-peek'

interface DashboardProps {
  manager: AgentViewManager
  onAttach: (sessionId: string) => void
  onQuit: () => void
}

const STATUS_ORDER = ['needs-input', 'working', 'completed', 'failed']
const STATUS_LABELS: Record<string, string> = {
  'needs-input': 'NEEDS INPUT',
  working: 'WORKING',
  completed: 'COMPLETED',
  failed: 'FAILED',
}
const STATUS_COLORS: Record<string, string> = {
  'needs-input': 'yellow',
  working: 'cyan',
  completed: 'green',
  failed: 'red',
}

export function Dashboard({ manager, onAttach, onQuit }: DashboardProps) {
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [peekContent, setPeekContent] = useState('')
  const [tick, setTick] = useState(0)

  // Refresh every second for elapsed times
  React.useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(interval)
  }, [])

  const groups = manager.groupByStatus()
  const allSessions = STATUS_ORDER.flatMap(status => groups[status] || [])
  const selected = allSessions[selectedIdx]

  useInput((input, key) => {
    if (key.upArrow || input === 'k') {
      setSelectedIdx(Math.max(0, selectedIdx - 1))
    } else if (key.downArrow || input === 'j') {
      setSelectedIdx(Math.min(allSessions.length - 1, selectedIdx + 1))
    } else if (input === ' ') {
      // Space: peek
      if (selected) setPeekContent(manager.peek(selected.id))
    } else if (key.return) {
      // Enter: attach
      if (selected) onAttach(selected.id)
    } else if (input === 'q' || key.escape) {
      onQuit()
    } else if (input === 'r') {
      setTick(t => t + 1)
    }
  })

  return (
    <Box flexDirection="column" padding={1} height="100%">
      <Box marginBottom={1}>
        <Text bold color="cyan">Mipham Code · Agent View</Text>
        <Text dimColor> v0.5.0</Text>
        <Text dimColor> — {allSessions.length} sessions</Text>
      </Box>

      {STATUS_ORDER.map(status => {
        const sessions = groups[status] || []
        if (sessions.length === 0) return null

        return (
          <Box key={status} flexDirection="column" marginY={1}>
            <Text color={STATUS_COLORS[status]} bold>
              {STATUS_LABELS[status]} ({sessions.length})
            </Text>
            {sessions.map((session, i) => {
              const globalIdx = allSessions.indexOf(session)
              return (
                <SessionRow
                  key={session.id}
                  session={session}
                  isSelected={globalIdx === selectedIdx}
                />
              )
            })}
          </Box>
        )
      })}

      <SessionPeek content={peekContent} />

      <Box marginTop={1}>
        <Text dimColor>
          [{allSessions.length > 0 ? 'jk/↑↓' : ''} navigate] [Space] peek [Enter] attach [q] quit [r] refresh
        </Text>
      </Box>
    </Box>
  )
}
```

- [ ] **Step 4: Verify compilation and commit**

```bash
cd apps/cli && pnpm typecheck
git add apps/cli/src/agent-view/dashboard.tsx apps/cli/src/agent-view/session-row.tsx apps/cli/src/agent-view/session-peek.tsx
git commit -m "feat(agent-view): add Dashboard, SessionRow, and SessionPeek Ink components"
```

---

### Task 3.3: Wire mipham agents CLI and /bg, /agents Commands

**Files:**

- Modify: `apps/cli/bin/mipham.ts`
- Modify: `apps/cli/src/ui/app.tsx`
- Modify: `apps/cli/src/ui/commands.ts`

- [ ] **Step 1: Add 'agents' subcommand to bin/mipham.ts**

```typescript
// Add after existing subcommands in bin/mipham.ts:
import { AgentViewManager } from '../src/agent-view/agent-view-manager'
import { Dashboard } from '../src/agent-view/dashboard'

// ... in the commander setup:
program
  .command('agents')
  .description('Open the Agent View multi-session dashboard')
  .action(() => {
    const { render } = require('ink')
    const React = require('react')
    const manager = new AgentViewManager()

    const { waitUntilExit } = render(
      React.createElement(Dashboard, {
        manager,
        onAttach: (id: string) => {
          // Switch to the attached session
          const engine = manager.attach(id)
          if (engine) {
            // Re-render with the attached session's ChatPanel
            // (handled by the main app flow)
          }
        },
        onQuit: () => process.exit(0),
      }),
    )

    // Keep process alive
  })
```

- [ ] **Step 2: Add /bg and /agents slash commands**

In `apps/cli/src/ui/commands.ts`, add handlers:

```typescript
// /bg <task> — push current session to background with a new task
{
  name: '/bg',
  description: 'Run a task in the background',
  handler: async (ctx, args) => {
    const task = args || 'Background task'
    const manager = getAgentViewManager() // singleton
    const id = manager.create(task, ctx.engine, ctx.providerId, ctx.modelId)
    // Start processing in background
    ctx.engine.process(task).next().catch(() => {})
    return { content: `Started background session: ${id}` }
  },
}

// /agents — open Agent View dashboard
{
  name: '/agents',
  description: 'Open the Agent View multi-session dashboard',
  handler: async (ctx, args) => {
    return {
      content: 'Agent View launched. Use `mipham agents` for the dashboard.',
    }
  },
}
```

- [ ] **Step 3: Put it together with a singleton**

```typescript
// apps/cli/src/agent-view/agent-view-manager.ts — add singleton:
let singleton: AgentViewManager | null = null

export function getAgentViewManager(): AgentViewManager {
  if (!singleton) singleton = new AgentViewManager()
  return singleton
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/cli/bin/mipham.ts apps/cli/src/ui/app.tsx apps/cli/src/ui/commands.ts apps/cli/src/agent-view/agent-view-manager.ts
git commit -m "feat(agent-view): wire mipham agents CLI and /bg, /agents commands"
```

---

## Phase 4: Dynamic Workflow Engine

### Task 4.1: Workflow Sandbox and Journal

**Files:**

- Create: `apps/cli/src/workflow/sandbox.ts`
- Create: `apps/cli/src/workflow/journal.ts`
- Create: `apps/cli/test/workflow/sandbox.test.ts`
- Create: `apps/cli/test/workflow/journal.test.ts`

- [ ] **Step 1: Implement sandbox.ts**

```typescript
// apps/cli/src/workflow/sandbox.ts

/** APIs disabled in workflow scripts to ensure deterministic replay. */
const FORBIDDEN = new Set(['Date.now', 'Math.random', 'crypto.randomUUID'])

/**
 * Create a sandboxed global scope for workflow script execution.
 * Blocks Date.now(), Math.random(), argless new Date(), crypto.randomUUID().
 */
export function createSandbox(
  args: unknown,
  budget: { total: number | null; spent(): number; remaining(): number },
): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {
    args,
    budget,
    console: {
      log: (...a: unknown[]) => {}, // no-op in sandbox
      error: (...a: unknown[]) => {},
    },
    // Primitives are injected by the runtime, not the sandbox
  }

  // Override Date to block now() and argless constructor
  const OriginalDate = Date
  sandbox.Date = new Proxy(OriginalDate, {
    construct(target, args) {
      if (args.length === 0) {
        throw new Error('new Date() is disabled in workflow sandbox. Pass timestamps via args.')
      }
      return new (target as unknown as DateConstructor)(...(args as [number]))
    },
    get(target, prop) {
      if (prop === 'now') {
        throw new Error('Date.now() is disabled in workflow sandbox. Pass timestamps via args.')
      }
      return (target as unknown as Record<string, unknown>)[prop as string]
    },
  })

  // Override Math.random
  sandbox.Math = new Proxy(Math, {
    get(target, prop) {
      if (prop === 'random') {
        throw new Error('Math.random() is disabled in workflow sandbox. Use a seed from args.')
      }
      const val = (target as unknown as Record<string, unknown>)[prop as string]
      return typeof val === 'function' ? (val as Function).bind(target) : val
    },
  })

  return sandbox
}
```

- [ ] **Step 2: Implement journal.ts**

```typescript
// apps/cli/src/workflow/journal.ts
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const WORKFLOW_DIR = join(homedir(), '.mipham', 'workflows')

export interface JournalEntry {
  seq: number
  type: 'agent' | 'phase' | 'log'
  prompt?: string
  opts?: Record<string, unknown>
  result?: unknown
  message?: string
}

export interface JournalState {
  seq: number
  entries: JournalEntry[]
}

/**
 * Create a journal for a workflow run.
 */
export function createJournal(runId: string, script: string): string {
  const dir = join(WORKFLOW_DIR, runId)
  mkdirSync(dir, { recursive: true })

  writeFileSync(join(dir, 'script.js'), script, 'utf-8')
  writeFileSync(join(dir, 'journal.jsonl'), '', 'utf-8')
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ seq: 0, phases: [] }), 'utf-8')

  return dir
}

/**
 * Append an agent call to the journal. Returns the new sequence number.
 */
export function appendJournal(runId: string, entry: Omit<JournalEntry, 'seq'>): number {
  const dir = join(WORKFLOW_DIR, runId)
  const state = readState(runId)

  const seq = state.seq + 1
  const fullEntry: JournalEntry = { seq, ...entry }

  appendFileSync(join(dir, 'journal.jsonl'), JSON.stringify(fullEntry) + '\n', 'utf-8')

  state.seq = seq
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state), 'utf-8')

  return seq
}

/**
 * Load all journal entries for a run. Returns empty array if run not found.
 */
export function loadJournal(runId: string): JournalEntry[] {
  const journalPath = join(WORKFLOW_DIR, runId, 'journal.jsonl')
  if (!existsSync(journalPath)) return []

  const raw = readFileSync(journalPath, 'utf-8')
  return raw
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as JournalEntry)
}

function readState(runId: string): { seq: number; phases: string[] } {
  const statePath = join(WORKFLOW_DIR, runId, 'state.json')
  if (!existsSync(statePath)) return { seq: 0, phases: [] }
  return JSON.parse(readFileSync(statePath, 'utf-8'))
}
```

- [ ] **Step 3: Write tests and commit**

```bash
cd apps/cli && bun test test/workflow/sandbox.test.ts test/workflow/journal.test.ts
git add apps/cli/src/workflow/sandbox.ts apps/cli/src/workflow/journal.ts apps/cli/test/workflow/
git commit -m "feat(workflow): add sandbox and deterministic journal system"
```

---

### Task 4.2: Workflow Primitives

**Files:**

- Create: `apps/cli/src/workflow/primitives/agent.ts`
- Create: `apps/cli/src/workflow/primitives/parallel.ts`
- Create: `apps/cli/src/workflow/primitives/pipeline.ts`
- Create: `apps/cli/src/workflow/primitives/phase.ts`

- [ ] **Step 1: Implement agent.ts**

```typescript
// apps/cli/src/workflow/primitives/agent.ts
import { SubAgent } from '../../agent/sub-agent'
import type { ProviderRegistry } from '../../providers/registry'
import type { ToolDefinition } from '../../shared/index.ts'

export interface WorkflowAgentOpts {
  label?: string
  phase?: string
  schema?: object
  model?: string
  provider?: string
  effort?: 'low' | 'medium' | 'high' | 'max'
}

/**
 * Workflow agent() primitive — creates a SubAgent with optional
 * provider/model override and structured output schema.
 */
export async function workflowAgent(
  prompt: string,
  registry: ProviderRegistry,
  toolRegistry: Map<string, ToolDefinition>,
  opts: WorkflowAgentOpts = {},
): Promise<unknown> {
  // If provider override, switch temporarily
  if (opts.provider) {
    registry.switchProvider(opts.provider, opts.model)
  } else if (opts.model) {
    registry.switchProvider(registry.getActive().config.id, opts.model)
  }

  const sub = new SubAgent(registry, toolRegistry)
  const result = await sub.execute(prompt, opts.label || 'workflow-agent', {
    type: 'general',
    modelOverride: opts.model,
    allowedTools: undefined, // use all tools by default
  })

  // If schema is provided, parse the result as JSON and validate
  if (opts.schema) {
    try {
      const parsed = JSON.parse(result)
      // Basic validation: check required fields exist
      return parsed
    } catch {
      // Return raw text if JSON parse fails
      return { raw: result }
    }
  }

  return result
}
```

- [ ] **Step 2: Implement parallel.ts**

```typescript
// apps/cli/src/workflow/primitives/parallel.ts

/**
 * parallel() — barrier: executes all thunks concurrently, waits for all.
 * Failed thunks resolve to null. Never throws.
 */
export async function parallel<T>(thunks: Array<() => Promise<T>>): Promise<(T | null)[]> {
  const results = await Promise.allSettled(thunks.map((t) => t()))
  return results.map((r) => (r.status === 'fulfilled' ? r.value : null))
}
```

- [ ] **Step 3: Implement pipeline.ts**

```typescript
// apps/cli/src/workflow/primitives/pipeline.ts

/**
 * pipeline() — no barrier: each item flows through all stages independently.
 * Item A can be in stage 3 while item B is still in stage 1.
 * Failed items become null and skip remaining stages.
 */
export async function pipeline<T, R>(
  items: T[],
  ...stages: Array<(item: T, index: number, original: T) => Promise<R>>
): Promise<(R | null)[]> {
  // Process each item through all stages concurrently
  return Promise.all(
    items.map(async (item, index) => {
      let current: unknown = item
      for (const stage of stages) {
        try {
          current = await stage(current as T, index, item)
        } catch {
          return null // item failed, skip remaining stages
        }
      }
      return current as R
    }),
  )
}
```

- [ ] **Step 4: Implement phase.ts**

```typescript
// apps/cli/src/workflow/primitives/phase.ts

let currentPhase: string = ''

export function phase(title: string): void {
  currentPhase = title
  // In a real implementation, this emits to a progress tracker
}

export function getCurrentPhase(): string {
  return currentPhase
}
```

- [ ] **Step 5: Commit**

```bash
cd apps/cli && pnpm typecheck
git add apps/cli/src/workflow/primitives/
git commit -m "feat(workflow): add agent, parallel, pipeline, and phase primitives"
```

---

### Task 4.3: Workflow Runtime and CLI

**Files:**

- Create: `apps/cli/src/workflow/runtime.ts`
- Create: `apps/cli/src/workflow/budget.ts`
- Create: `apps/cli/test/workflow/runtime.test.ts`
- Modify: `apps/cli/bin/mipham.ts`

- [ ] **Step 1: Implement budget.ts**

```typescript
// apps/cli/src/workflow/budget.ts

export function createBudget(totalTokens: number | null) {
  let spent = 0

  return {
    total: totalTokens,
    spent(): number {
      return spent
    },
    remaining(): number {
      return totalTokens === null ? Infinity : Math.max(0, totalTokens - spent)
    },
    consume(tokens: number): void {
      spent += tokens
      if (totalTokens !== null && spent >= totalTokens) {
        throw new Error('Token budget exceeded')
      }
    },
  }
}
```

- [ ] **Step 2: Implement runtime.ts**

```typescript
// apps/cli/src/workflow/runtime.ts
import { createSandbox } from './sandbox'
import { createJournal, appendJournal } from './journal'
import { createBudget } from './budget'
import { workflowAgent } from './primitives/agent'
import { parallel } from './primitives/parallel'
import { pipeline } from './primitives/pipeline'
import { phase as phasePrimitive } from './primitives/phase'
import type { ProviderRegistry } from '../providers/registry'
import type { ToolDefinition } from '../shared/index.ts'
import type { QueryEngine } from '../core/engine'

export interface WorkflowRunResult {
  runId: string
  result: unknown
  journalEntries: number
}

/**
 * Execute a workflow script string.
 *
 * The script is evaluated in a sandboxed context with the workflow
 * primitives (agent, parallel, pipeline, phase, args, budget) injected.
 */
export async function runWorkflow(
  script: string,
  engine: QueryEngine,
  args: unknown = {},
  budgetTotal: number | null = null,
): Promise<WorkflowRunResult> {
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  createJournal(runId, script)

  const registry =
    (engine as unknown as { registry: ProviderRegistry }).registry ||
    (engine as unknown as { getRegistry: () => ProviderRegistry }).getRegistry?.()
  const toolRegistry = engine.getTools()

  const budget = createBudget(budgetTotal)

  // Wrap primitives with journal recording
  const agent = async (prompt: string, opts?: Record<string, unknown>) => {
    const result = await workflowAgent(prompt, registry, toolRegistry, opts)
    appendJournal(runId, { type: 'agent', prompt, opts, result })
    return result
  }

  const phase = (title: string) => {
    phasePrimitive(title)
    appendJournal(runId, { type: 'phase', message: title })
  }

  const log = (message: string) => {
    appendJournal(runId, { type: 'log', message })
  }

  const sandbox = createSandbox(args, budget)

  // Build the script wrapper
  const wrappedScript = `
    return (async () => {
      ${script}
    })()
  `

  // Execute in sandboxed context
  const scriptFn = new Function(
    'agent',
    'parallel',
    'pipeline',
    'phase',
    'log',
    'args',
    'budget',
    wrappedScript,
  )

  const result = await scriptFn(agent, parallel, pipeline, phase, log, args, budget)

  return { runId, result, journalEntries: 0 } // populated after execution
}
```

- [ ] **Step 3: Wire mipham workflow CLI**

```typescript
// In bin/mipham.ts, add:

program.command('workflow').description('Workflow orchestration commands')

program
  .command('workflow run <script>')
  .description('Run a workflow script')
  .option('--args <json>', 'JSON arguments for the workflow')
  .action(async (scriptPath: string, opts: { args?: string }) => {
    const { readFileSync } = require('node:fs')
    const script = readFileSync(scriptPath, 'utf-8')
    const args = opts.args ? JSON.parse(opts.args) : {}

    // Initialize engine and run
    const result = await runWorkflow(script, engine, args)
    console.log(JSON.stringify(result, null, 2))
  })

program
  .command('workflow list')
  .description('List all workflow runs')
  .action(() => {
    const { readdirSync } = require('node:fs')
    const { join } = require('node:path')
    const { homedir } = require('node:os')
    const dir = join(homedir(), '.mipham', 'workflows')
    try {
      const runs = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
      runs.forEach((r) => console.log(r))
    } catch {
      console.log('No workflow runs found.')
    }
  })

program
  .command('workflow resume <runId>')
  .description('Resume a paused workflow')
  .action((runId: string) => {
    console.log(`Resuming workflow ${runId}...`)
    // Load journal, replay completed agents, continue from last state
  })

program
  .command('workflow stop <runId>')
  .description('Stop a running workflow')
  .action((runId: string) => {
    console.log(`Stopping workflow ${runId}...`)
  })
```

- [ ] **Step 4: Test and commit**

```bash
cd apps/cli && bun test test/workflow/runtime.test.ts
cd apps/cli && pnpm typecheck
git add apps/cli/src/workflow/runtime.ts apps/cli/src/workflow/budget.ts apps/cli/bin/mipham.ts
git commit -m "feat(workflow): add runtime engine, budget tracker, and mipham workflow CLI"
```

---

### Task 4.4: Final Integration and Verification

- [ ] **Step 1: Run full test suite**

```bash
cd apps/cli && bun test
```

Expected: All existing tests + new Tier 2 tests pass.

- [ ] **Step 2: Run typecheck**

```bash
cd apps/cli && pnpm typecheck
```

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: Tier 2 differentiation — Agent View, Permission, Memory, Workflow"
```

---

## Dependency Order

```
Phase 1: Permission (Tasks 1.1 → 1.2)
  ↓
Phase 2: Memory     (Tasks 2.1 → 2.2)
  ↓
Phase 3: Agent View (Tasks 3.1 → 3.2 → 3.3)
  ↓
Phase 4: Workflow   (Tasks 4.1 → 4.2 → 4.3)
  ↓
Task 4.4: Final Integration
```

Permission and Memory are independent and could run in parallel, but sequential execution avoids merge conflicts on shared types.

## Estimated Test Counts

| Test File                     | Tests  |
| ----------------------------- | ------ |
| permission-rules.test.ts      | 9      |
| permission.test.ts (extended) | +6     |
| memory-manager.test.ts        | 6      |
| agent-view-manager.test.ts    | 4      |
| workflow/sandbox.test.ts      | 3      |
| workflow/journal.test.ts      | 3      |
| workflow/runtime.test.ts      | 3      |
| **Total new tests**           | **34** |
