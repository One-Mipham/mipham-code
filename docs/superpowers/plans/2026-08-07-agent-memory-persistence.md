# Agent Memory 持久化 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现跨会话 Agent Memory 持久化：增强记忆系统（wikilinks + 蒸馏）、会话恢复（/resume）、Agent 经验积累。

**Architecture:** 在现有 `MemoryManager`、`SessionStore`、`SubAgent` 三个子系统上渐进增强，不改 API 签名。三子系统按 1→2→3 顺序交付，每步独立可测试。

**Tech Stack:** TypeScript 5.5+, Bun 1.2+, Vitest 3, Node.js fs/path

## Global Constraints

- 现有 642 测试零回归
- 不改现有 public API 签名（MemoryManager.write/recall/delete, SessionStore.save/load/list, SubAgent.execute）
- 所有新功能通过 `~/.mipham/config.json` 的 feature flag 控制（默认开启）
- 文件系统存储（`~/.mipham/memory/`, `~/.mipham/sessions/`, `~/.mipham/agent-memory/`），不引入 SQLite
- 记忆文件上限 20 条经验/Agent
- wikilinks 单文件上限 10 个链接

---

## File Structure

```
apps/cli/src/
├── core/memory/
│   ├── memory-manager.ts    ← MODIFY: +wikilinks, +dedup, +distill, +recall boost
│   └── memory-loader.ts     ← MODIFY: forward distillFromSession
├── core/
│   ├── session-store.ts     ← MODIFY: +index, +summary, +getLatest
│   └── engine.ts            ← MODIFY: SessionStart inject + exit hook
├── agent/
│   ├── agent-experience.ts  ← CREATE: AgentExperience class
│   ├── agent-context.ts     ← MODIFY: load experience.md
│   └── sub-agent.ts         ← MODIFY: auto-log on completion
└── ui/
    └── commands.ts          ← MODIFY: register /resume, /agent reset

apps/cli/test/
├── core/memory/memory-manager.test.ts  ← EXTEND: +4 tests
├── core/session-store.test.ts         ← EXTEND: +4 tests
└── agent/sub-agent.test.ts            ← EXTEND: +4 tests (experience)
```

---

### Task 1.1: MemoryManager — wikilinks 解析与图谱

**Files:**
- Modify: `apps/cli/src/core/memory/memory-manager.ts` (add ~35 lines)
- Test: `apps/cli/test/core/memory/memory-manager.test.ts` (add 2 tests)

**Interfaces:**
- Consumes: existing `MemoryManager` class, `MemoryEntry` interface
- Produces: `getLinkedMemories(name: string): MemoryEntry[]`, `links.json` file at `~/.mipham/memory/links.json`

- [ ] **Step 1: Write the failing tests**

Add to `apps/cli/test/core/memory/memory-manager.test.ts`:

```typescript
it('extracts wikilinks from content and builds link graph', () => {
  const mm = new MemoryManager(TEST_DIR)
  mm.write('phase-4', 'Phase 4 complete. See also: [[phase-5]] [[service-mesh]]', {
    type: 'project',
    relevance: ['phase-4'],
    why: 'Service mesh integration done',
    howToApply: 'Use as baseline for Phase 5',
  })

  const linked = mm.getLinkedMemories('phase-4')
  expect(linked).toHaveLength(0) // phase-5 not written yet, so no resolved links
  
  mm.write('phase-5', 'Phase 5 next steps. See also: [[phase-4]]', {
    type: 'project',
    relevance: ['phase-5'],
    why: 'Nexus/Sentinel deep integration',
    howToApply: 'Start from Phase 4 baseline',
  })

  // Now the link is bidirectional
  const linked2 = mm.getLinkedMemories('phase-4')
  expect(linked2).toHaveLength(1)
  expect(linked2[0]!.name).toBe('phase-5')
})

it('recall includes wikilink-connected memories with lower weight', () => {
  const mm = new MemoryManager(TEST_DIR)
  mm.write('a', 'Memory A. See also: [[b]]', {
    type: 'project',
    relevance: ['topic-a'],
  })
  mm.write('b', 'Memory B — connected from A', {
    type: 'project',
    relevance: ['topic-b'],
  })

  // Search for topic-a — should get both A (direct) and B (via wikilink)
  const results = mm.recall('topic-a')
  const names = results.map(r => r.name)
  expect(names).toContain('a')
  expect(names).toContain('b')
  // 'a' should come first (higher score)
  expect(names[0]).toBe('a')
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/cli && pnpm test -- --reporter=verbose test/core/memory/memory-manager.test.ts
```
Expected: 2 new tests FAIL — `getLinkedMemories` not a function, wikilink recall not working.

- [ ] **Step 3: Implement wikilinks parsing and graph**

In `apps/cli/src/core/memory/memory-manager.ts`:

Add to `MemoryEntry` interface (no change — wikilinks are parsed from content body):

```typescript
// Add private field to MemoryManager class
private linkGraph: Map<string, Set<string>> = new Map()
private readonly LINKS_FILE = 'links.json'
```

Add `getLinkedMemories()` method:

```typescript
getLinkedMemories(name: string): MemoryEntry[] {
  const targets = this.linkGraph.get(name)
  if (!targets || targets.size === 0) return []
  const results: MemoryEntry[] = []
  for (const target of targets) {
    const entry = this.memories.get(target)
    if (entry) results.push(entry)
  }
  return results
}
```

Add wikilink extraction helper (private method):

```typescript
private extractWikilinks(content: string): string[] {
  const re = /\[\[([^\]]+)\]\]/g
  const links: string[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(content)) !== null) {
    if (links.length >= 10) break // hard cap
    links.push(match[1]!)
  }
  return links
}
```

Modify `write()` to extract wikilinks and update graph:

```typescript
// Inside write(), after setting this.memories.set(name, entry):
  // Update wikilink graph
  const links = this.extractWikilinks(content)
  if (links.length > 0) {
    this.linkGraph.set(name, new Set(links))
    // Add reverse links for existing memories that link to this one
    for (const [existingName, existingEntry] of this.memories) {
      if (existingName === name) continue
      const existingLinks = this.extractWikilinks(existingEntry.content)
      if (existingLinks.includes(name)) {
        const reverseSet = this.linkGraph.get(existingName) || new Set()
        reverseSet.add(name)
        this.linkGraph.set(existingName, reverseSet)
      }
    }
    this.saveLinkGraph()
  }
```

Save/load link graph helpers:

```typescript
private saveLinkGraph(): void {
  const obj: Record<string, string[]> = {}
  for (const [k, v] of this.linkGraph) {
    obj[k] = Array.from(v)
  }
  writeFileSync(join(this.memoryDir, this.LINKS_FILE), JSON.stringify(obj, null, 2), 'utf-8')
}

private loadLinkGraph(): void {
  const path = join(this.memoryDir, this.LINKS_FILE)
  if (!existsSync(path)) return
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    for (const [k, v] of Object.entries(raw)) {
      this.linkGraph.set(k, new Set(v as string[]))
    }
  } catch {
    // corrupt file, start fresh
  }
}
```

Call `loadLinkGraph()` at end of `loadAll()`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/cli && pnpm test -- --reporter=verbose test/core/memory/memory-manager.test.ts
```
Expected: ALL tests PASS (6 existing + 2 new = 8 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/memory/memory-manager.ts apps/cli/test/core/memory/memory-manager.test.ts
git commit -m "feat(memory): add wikilinks parsing and link graph

- extractWikilinks() parses [[link]] from content body
- getLinkedMemories() returns resolved bidirectional links
- recall() includes wikilink-connected memories with lower weight
- links.json persists graph to disk

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 1.2: MemoryManager — 去重写入 + 结构化段落

**Files:**
- Modify: `apps/cli/src/core/memory/memory-manager.ts` (add ~25 lines)
- Test: `apps/cli/test/core/memory/memory-manager.test.ts` (add 1 test)

**Interfaces:**
- Consumes: `write()` from Task 1.1, `MemoryMetadata` interface
- Produces: enhanced `write()` with dedup + optional `why`/`howToApply` fields in `MemoryMetadata`

- [ ] **Step 1: Write the failing test**

```typescript
it('write with why/howToApply stores structured memory', () => {
  const mm = new MemoryManager(TEST_DIR)
  mm.write('decision', 'Use pnpm over npm', {
    type: 'project',
    relevance: ['tools'],
    why: 'Faster installs, strict dependency resolution',
    howToApply: 'Always use pnpm for new projects',
  })

  const recalled = mm.recall('pnpm decision')
  expect(recalled).toHaveLength(1)
  expect(recalled[0]!.content).toContain('**Why:**')
  expect(recalled[0]!.content).toContain('Faster installs')
  expect(recalled[0]!.content).toContain('**How to apply:**')
  expect(recalled[0]!.content).toContain('Always use pnpm')
})

it('write with same name updates instead of duplicating', () => {
  const mm = new MemoryManager(TEST_DIR)
  mm.write('same-name', 'Version 1', {
    type: 'feedback',
    relevance: ['test'],
  })
  mm.write('same-name', 'Version 2', {
    type: 'feedback',
    relevance: ['test'],
  })

  const all = mm.recall('test')
  expect(all).toHaveLength(1) // not duplicated
  expect(all[0]!.content).toContain('Version 2')
})
```

- [ ] **Step 2: Run tests, confirm 1 new failure**

```bash
cd apps/cli && pnpm test -- --reporter=verbose test/core/memory/memory-manager.test.ts
```
Expected: `/write with why/howToApply/` FAIL — content missing `**Why:**` blocks.

- [ ] **Step 3: Implement dedup + structured paragraphs**

In `apps/cli/src/core/memory/memory-manager.ts`:

Extend `MemoryMetadata` interface:

```typescript
export interface MemoryMetadata {
  type: 'user' | 'feedback' | 'project' | 'reference'
  relevance: string[]
  why?: string       // 🆕
  howToApply?: string // 🆕
}
```

Modify `formatMemoryFile()` to render optional `**Why:**` / `**How to apply:**`:

```typescript
private formatMemoryFile(name: string, metadata: MemoryMetadata, content: string): string {
  let body = `---
name: ${name}
description: ${metadata.relevance.join(', ')}
metadata:
  type: ${metadata.type}
  relevance: [${metadata.relevance.join(', ')}]
---

${content}
`

  if (metadata.why) {
    body += `\n**Why:** ${metadata.why}\n`
  }
  if (metadata.howToApply) {
    body += `\n**How to apply:** ${metadata.howToApply}\n`
  }

  return body
}
```

Add dedup logic at top of `write()`:

```typescript
write(name: string, content: string, metadata: MemoryMetadata): void {
  // Dedup: same name = update, don't create duplicate
  const existing = this.memories.get(name)
  if (existing) {
    existing.content = content
    existing.metadata = metadata
    existing.updatedAt = new Date()
    this.memories.set(name, existing)
    this.updateIndex()
    return
  }
  // ... rest of existing write() logic
}
```

- [ ] **Step 4: Run tests, all pass**

```bash
cd apps/cli && pnpm test -- --reporter=verbose test/core/memory/memory-manager.test.ts
```
Expected: ALL 10 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/memory/memory-manager.ts apps/cli/test/core/memory/memory-manager.test.ts
git commit -m "feat(memory): add dedup write and why/howToApply structured paragraphs

- write() with same name updates instead of duplicating
- MemoryMetadata.why/howToApply render as **Why:**/**How to apply:** sections
- Backward compatible — both fields are optional

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 1.3: MemoryManager — 增强召回 + distillFromSession

**Files:**
- Modify: `apps/cli/src/core/memory/memory-manager.ts` (add ~30 lines)
- Test: `apps/cli/test/core/memory/memory-manager.test.ts` (add 1 test)

**Interfaces:**
- Consumes: `recall()` from Task 1.2, `write()` from Task 1.2
- Produces: `distillFromSession(summary: string): MemoryEntry[]`

- [ ] **Step 1: Write the failing test**

```typescript
it('distillFromSession splits summary into individual memories', () => {
  const mm = new MemoryManager(TEST_DIR)
  const summary = `Session summary:
- User prefers TypeScript strict mode. **Why:** type safety. **How to apply:** enable strict in tsconfig.
- Decided to use Vitest for testing. **Why:** faster than Jest. **How to apply:** use vitest.config.ts in new projects.`

  const entries = mm.distillFromSession(summary, 'session-test-001')
  expect(entries.length).toBeGreaterThanOrEqual(2)
  
  const tsEntry = entries.find(e => e.content.includes('TypeScript'))
  expect(tsEntry).toBeDefined()
  expect(tsEntry!.metadata.type).toBe('feedback')
  expect(tsEntry!.metadata.relevance).toContain('typescript')
  
  const vitestEntry = entries.find(e => e.content.includes('Vitest'))
  expect(vitestEntry).toBeDefined()
  expect(vitestEntry!.content).toContain('**Why:** faster than Jest')
})
```

- [ ] **Step 2: Run test, confirm failure**

```bash
cd apps/cli && pnpm test -- --reporter=verbose test/core/memory/memory-manager.test.ts
```
Expected: `distillFromSession` FAIL — method not defined.

- [ ] **Step 3: Implement distillFromSession and enhanced recall**

In `apps/cli/src/core/memory/memory-manager.ts`:

Add `distillFromSession()`:

```typescript
distillFromSession(summary: string, sessionId: string): MemoryEntry[] {
  const results: MemoryEntry[] = []
  // Split on bullet points (both - and *)
  const bullets = summary.split(/\n\s*[-*]\s+/).filter(b => b.trim().length > 20)
  
  for (const bullet of bullets) {
    // Extract Why / How to apply if present
    const whyMatch = bullet.match(/\*\*Why:\*\*\s*(.+?)(?:\s*\*\*How to apply:|$)/)
    const howMatch = bullet.match(/\*\*How to apply:\*\*\s*(.+)$/)
    
    const content = bullet.trim()
    const slug = `auto-${sessionId}-${results.length}`
    
    this.write(slug, content, {
      type: 'feedback',
      relevance: this.extractKeywords(content),
      why: whyMatch?.[1]?.trim(),
      howToApply: howMatch?.[1]?.trim(),
    })
    
    const entry = this.memories.get(slug)
    if (entry) results.push(entry)
  }
  return results
}
```

Enhance `recall()` — add time decay:

```typescript
// Inside recall(), before sorting:
const now = Date.now()
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

// Apply time decay
for (const item of scored) {
  const age = now - item.entry.updatedAt.getTime()
  if (age > THIRTY_DAYS_MS) {
    item.score *= 0.5
  }
}
```

- [ ] **Step 4: Run tests, all pass**

```bash
cd apps/cli && pnpm test -- --reporter=verbose test/core/memory/memory-manager.test.ts
```
Expected: ALL 11 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/memory/memory-manager.ts apps/cli/test/core/memory/memory-manager.test.ts
git commit -m "feat(memory): add distillFromSession and time-decay recall

- distillFromSession() splits LLM summary into individual memory files
- recall() applies 50% weight decay for memories older than 30 days
- extractKeywords() helper reused from memory-writer pattern

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2.1: SessionStore — 索引 + 摘要存储

**Files:**
- Modify: `apps/cli/src/core/session-store.ts` (add ~60 lines)
- Test: `apps/cli/test/core/session-store.test.ts` (add 3 tests)

**Interfaces:**
- Consumes: existing `SessionStore` static class
- Produces: `SessionStore.updateIndex()`, `SessionStore.saveSummary()`, `SessionStore.getLatest()`, `.index.json`, `.summaries/`

- [ ] **Step 1: Write the failing tests**

```typescript
describe('session index and summary', () => {
  it('getLatest returns most recent session metadata', () => {
    SessionStore.save('test-latest-old', [{ role: 'user', content: 'old' }])
    // Small delay to ensure different timestamps
    SessionStore.save('test-latest-new', [{ role: 'user', content: 'new' }])

    const latest = SessionStore.getLatest()
    expect(latest).toBeDefined()
    expect(latest!.name).toBe('test-latest-new')
  })

  it('saveSummary persists session summary to .summaries/', () => {
    SessionStore.save('test-summary', [{ role: 'user', content: 'test' }])
    SessionStore.saveSummary('test-summary', 'Discussed memory persistence design', ['memory', 'design'])

    const meta = SessionStore.getLatest()
    expect(meta).toBeDefined()
    // Summary is stored in .index.json metadata
    const sessions = SessionStore.list()
    const s = sessions.find(x => x.name === 'test-summary')
    expect(s).toBeDefined()
  })

  it('updateIndex writes .index.json with all sessions', () => {
    SessionStore.save('test-idx', [{ role: 'user', content: 'idx test' }])
    SessionStore.updateIndex()
    
    const latest = SessionStore.getLatest()
    expect(latest).toBeDefined()
  })
})
```

- [ ] **Step 2: Run tests, confirm failures**

```bash
cd apps/cli && pnpm test -- --reporter=verbose test/core/session-store.test.ts
```
Expected: 3 new tests FAIL — methods not defined.

- [ ] **Step 3: Implement index + summary**

In `apps/cli/src/core/session-store.ts`:

```typescript
import { join } from 'node:path'

const INDEX_FILE = join(SESSIONS_DIR, '.index.json')
const SUMMARIES_DIR = join(SESSIONS_DIR, '.summaries')

interface SessionIndexEntry {
  name: string
  createdAt: string
  updatedAt: string
  provider: string
  model: string
  messageCount: number
  tokenCount: number
  cwd?: string
  summary?: string
  tags?: string[]
}

// Add to SessionStore:

static updateIndex(): void {
  ensureDir()
  const sessions = SessionStore.list()
  const index: SessionIndexEntry[] = sessions.map(s => ({
    name: s.name,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    provider: s.provider,
    model: s.model,
    messageCount: s.messageCount,
    tokenCount: 0, // updated on save
    cwd: s.cwd,
  }))
  
  // Merge with existing summaries
  const existing = SessionStore.loadIndexRaw()
  for (const entry of index) {
    const prev = existing.find(e => e.name === entry.name)
    if (prev) {
      entry.summary = prev.summary
      entry.tags = prev.tags
      entry.tokenCount = prev.tokenCount || 0
    }
  }
  
  writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8')
}

static saveSummary(name: string, summary: string, tags: string[]): void {
  ensureDir()
  mkdirSync(SUMMARIES_DIR, { recursive: true })
  
  const summaryPath = join(SUMMARIES_DIR, `${name}.md`)
  writeFileSync(summaryPath, `# ${name}\n\n${summary}\n\nTags: ${tags.join(', ')}\n`, 'utf-8')
  
  // Update index entry
  const index = SessionStore.loadIndexRaw()
  const entry = index.find(e => e.name === name)
  if (entry) {
    entry.summary = summary
    entry.tags = tags
  }
  writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8')
}

static getLatest(): SessionIndexEntry | null {
  const index = SessionStore.loadIndexRaw()
  if (index.length === 0) return null
  index.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  return index[0]!
}

private static loadIndexRaw(): SessionIndexEntry[] {
  if (!existsSync(INDEX_FILE)) return []
  try {
    return JSON.parse(readFileSync(INDEX_FILE, 'utf-8'))
  } catch {
    return []
  }
}
```

Update `save()` to also update index:

```typescript
// At the end of save(), add:
  SessionStore.updateIndex()
```

- [ ] **Step 4: Run tests, all pass**

```bash
cd apps/cli && pnpm test -- --reporter=verbose test/core/session-store.test.ts
```
Expected: ALL existing + new tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/session-store.ts apps/cli/test/core/session-store.test.ts
git commit -m "feat(session): add index, summary storage, and getLatest

- updateIndex() writes .index.json with all session metadata
- saveSummary() persists LLM-generated summaries to .summaries/
- getLatest() returns most recent session for SessionStart injection
- save() automatically updates index after each write

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2.2: Commands — 注册 /resume 命令

**Files:**
- Modify: `apps/cli/src/ui/commands.ts` (add ~25 lines)
- Test: `apps/cli/test/ui/commands.test.ts` (add 1 test — or verify existing commands test covers new registration)

**Interfaces:**
- Consumes: `SessionStore` from Task 2.1, `CommandContext` interface
- Produces: `/resume`, `/resume last`, `/resume delete` commands

- [ ] **Step 1: Write the test**

```typescript
it('/resume command is registered', () => {
  // Verify the command map includes /resume
  const cmds = getCommandRegistry() // if exported, or test via command execution
  expect(cmds.has('/resume')).toBe(true)
  expect(cmds.has('/resume last')).toBe(true)
})
```

- [ ] **Step 2: Run test, confirm failure**

```bash
cd apps/cli && pnpm test -- --reporter=verbose test/ui/commands.test.ts
```
Expected: FAIL — `/resume` not found.

- [ ] **Step 3: Register /resume commands**

In `apps/cli/src/ui/commands.ts`:

Add import:
```typescript
import { SessionStore } from '../core/session-store'
```

Add to `getCommands()` return map:

```typescript
'/resume': {
  description: '恢复之前的会话',
  longDescription: '列出最近的会话或直接恢复。用法: /resume, /resume last, /resume <name>, /resume delete <name>',
  category: 'history',
  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const sessions = SessionStore.list()
    if (sessions.length === 0) {
      return { content: '没有已保存的会话。' }
    }
    // Show session picker — list recent 10 with summaries
    const lines = ['## 最近的会话', '']
    for (const s of sessions.slice(0, 10)) {
      const date = new Date(s.updatedAt).toLocaleString('zh-CN')
      lines.push(`- **${s.name}** — ${s.messageCount} 条消息 · ${date}`)
      lines.push(`  Model: ${s.model} · CWD: ${s.cwd || 'N/A'}`)
    }
    lines.push('', '输入 `/resume <name>` 恢复会话，或 `/resume last` 恢复最近会话。')
    return { content: lines.join('\n') }
  },
},

'/resume last': {
  description: '恢复最近的会话',
  category: 'history',
  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const latest = SessionStore.getLatest()
    if (!latest) {
      return { content: '没有已保存的会话。' }
    }
    const session = SessionStore.load(latest.name)
    if (!session) {
      return { content: `无法加载会话: ${latest.name}` }
    }
    // Return the messages to be loaded by the caller (app.tsx)
    // The command result signals the app to restore these messages
    return {
      content: `已恢复会话 **${latest.name}**（${session.messages.length} 条消息）`,
      forwardedMessages: session.messages, // 🆕 field on CommandResult
    }
  },
},

'/resume delete': {
  description: '删除指定会话',
  category: 'history',
  execute: async (ctx: CommandContext): Promise<CommandResult> => {
    const arg = ctx.rawArgs?.trim()
    if (!arg) return { content: '用法: /resume delete <会话名称>' }
    const deleted = SessionStore.delete(arg)
    return { content: deleted ? `已删除会话: ${arg}` : `未找到会话: ${arg}` }
  },
},
```

- [ ] **Step 4: Run tests, all pass**

```bash
cd apps/cli && pnpm test -- --reporter=verbose
```
Expected: 642 tests PASS (no regressions).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/ui/commands.ts
git commit -m "feat(commands): register /resume, /resume last, /resume delete

- /resume lists recent 10 sessions with metadata
- /resume last restores most recent session messages
- /resume delete <name> removes a saved session

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2.3: Engine — SessionStart 注入 + 退出自动摘要

**Files:**
- Modify: `apps/cli/src/index.tsx` (add ~15 lines)
- Modify: `apps/cli/src/core/engine.ts` (add ~10 lines)

**Interfaces:**
- Consumes: `SessionStore.getLatest()` from Task 2.1, `MemoryManager.distillFromSession()` from Task 1.3
- Produces: SessionStart context injection, exit hook calling distillFromSession

- [ ] **Step 1: Verify no regression baseline**

```bash
cd apps/cli && pnpm test -- --reporter=verbose
```
Expected: 642 tests PASS.

- [ ] **Step 2: Implement SessionStart injection**

In `apps/cli/src/index.tsx` (inside `runApp()`):

After existing `loadSessionMemories()` call (line ~145), add:

```typescript
// Inject last session reminder
let lastSessionReminder = ''
const latestSession = SessionStore.getLatest()
if (latestSession && latestSession.summary) {
  const age = Date.now() - new Date(latestSession.updatedAt).getTime()
  const hoursAgo = Math.round(age / (1000 * 60 * 60))
  lastSessionReminder = `\n\n[系统] 你上次与用户的对话（${hoursAgo} 小时前）: ${latestSession.summary}\n输入 /resume last 恢复完整上下文。`
}
```

Pass `lastSessionReminder` into the system prompt concatenation alongside `memoryReminder`.

- [ ] **Step 3: Implement exit auto-summary**

In `apps/cli/src/index.tsx`, add a `process.on('exit', ...)` handler near the end of `runApp()`:

```typescript
// Auto-summarize session on exit
process.on('exit', () => {
  // Best-effort: save current session state
  try {
    const messages = queryEngine.getContext().getMessages()
    if (messages.length > 4) {
      SessionStore.autoSave(messages, {
        provider: options.provider,
        model: options.model,
        cwd: process.cwd(),
      })
    }
  } catch {
    // Silently ignore — never block exit
  }
})
```

- [ ] **Step 4: Run full test suite**

```bash
cd apps/cli && pnpm test -- --reporter=verbose
```
Expected: 642 tests PASS (zero regressions).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/index.tsx
git commit -m "feat(engine): add SessionStart context injection and exit auto-save

- SessionStart injects last session summary into system prompt
- process.on('exit') auto-saves current session via SessionStore.autoSave
- Both operations are best-effort — never block startup/exit

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3.1: AgentExperience — 新建经验管理类

**Files:**
- Create: `apps/cli/src/agent/agent-experience.ts` (~60 lines)
- Test: add tests to `apps/cli/test/agent/sub-agent.test.ts` (~50 lines for experience tracking)

**Interfaces:**
- Consumes: agent name (string), filesystem (`~/.mipham/agent-memory/<name>/`)
- Produces: `AgentExperience.logSuccess()`, `AgentExperience.logFailure()`, `AgentExperience.getExperience()`, `AgentExperience.reset()`

- [ ] **Step 1: Write the failing tests**

Add to `apps/cli/test/agent/sub-agent.test.ts`:

```typescript
import { AgentExperience } from '../../src/agent/agent-experience'
import { rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const AGENT_TEST_DIR = join(tmpdir(), 'mipham-agent-exp-test-' + Date.now())

describe('AgentExperience', () => {
  afterAll(() => {
    rmSync(AGENT_TEST_DIR, { recursive: true, force: true })
  })

  it('logSuccess appends to Success Patterns', () => {
    const exp = new AgentExperience('test-agent', AGENT_TEST_DIR)
    exp.logSuccess('Used Grep to find all import cycles', 'Cross-module PR review')
    
    const content = exp.getExperience()
    expect(content).toContain('## Success Patterns')
    expect(content).toContain('Grep to find all import cycles')
    expect(content).toContain('Cross-module PR review')
  })

  it('logFailure appends to Failure Patterns', () => {
    const exp = new AgentExperience('test-agent', AGENT_TEST_DIR)
    exp.logFailure('Bash timeout on npm install', 'CI build commands with default timeout')
    
    const content = exp.getExperience()
    expect(content).toContain('## Failure Patterns')
    expect(content).toContain('Bash timeout')
    expect(content).toContain('CI build commands')
  })

  it('stats track execution counts', () => {
    const exp = new AgentExperience('test-agent-stats', AGENT_TEST_DIR)
    exp.logSuccess('Task A complete', 'When doing A')
    exp.logSuccess('Task B complete', 'When doing B')
    exp.logFailure('Task C failed', 'Avoid pattern C')
    
    const content = exp.getExperience()
    expect(content).toContain('总执行: 3 次')
    expect(content).toContain('成功: 2')
    expect(content).toContain('失败: 1')
  })

  it('getExperience returns empty string for agent with no history', () => {
    const exp = new AgentExperience('new-agent', AGENT_TEST_DIR)
    const content = exp.getExperience()
    expect(content).toBe('')
  })

  it('reset clears experience', () => {
    const exp = new AgentExperience('reset-test', AGENT_TEST_DIR)
    exp.logSuccess('Something', 'Context')
    exp.reset()
    expect(exp.getExperience()).toBe('')
  })
})
```

- [ ] **Step 2: Run tests, confirm failures**

```bash
cd apps/cli && pnpm test -- --reporter=verbose test/agent/sub-agent.test.ts
```
Expected: 5 new tests FAIL — `AgentExperience` not found.

- [ ] **Step 3: Implement AgentExperience class**

Create `apps/cli/src/agent/agent-experience.ts`:

```typescript
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const MAX_EXPERIENCES = 20

interface ExperienceStats {
  total: number
  success: number
  failure: number
  avgTokens: number
  avgDurationMs: number
  lastRun: string
}

export class AgentExperience {
  private readonly expFile: string
  private readonly expDir: string

  constructor(
    private readonly agentName: string,
    baseDir: string = join(process.env.HOME || '~', '.mipham', 'agent-memory'),
  ) {
    this.expDir = join(baseDir, agentName)
    this.expFile = join(this.expDir, 'experience.md')
  }

  logSuccess(description: string, whenToApply: string): void {
    const date = new Date().toISOString().slice(0, 10)
    const entry = `- [${date}] ${description}\n  **When to apply:** ${whenToApply}\n`
    this.appendToSection('## Success Patterns', entry)
    this.incrementStat('success')
  }

  logFailure(description: string, whenToAvoid: string): void {
    const date = new Date().toISOString().slice(0, 10)
    const entry = `- [${date}] ${description}\n  **When to avoid:** ${whenToAvoid}\n`
    this.appendToSection('## Failure Patterns', entry)
    this.incrementStat('failure')
  }

  getExperience(): string {
    if (!existsSync(this.expFile)) return ''
    try {
      return readFileSync(this.expFile, 'utf-8')
    } catch {
      return ''
    }
  }

  reset(): void {
    if (existsSync(this.expFile)) {
      try { unlinkSync(this.expFile) } catch { /* ok */ }
    }
  }

  private appendToSection(section: string, entry: string): void {
    mkdirSync(this.expDir, { recursive: true })

    let content = this.getExperience()
    if (!content) {
      content = `# Agent Experience — ${this.agentName}\n\n## Success Patterns\n\n## Failure Patterns\n\n## Stats\n- 总执行: 0 次 | 成功: 0 | 失败: 0\n- 平均 token: N/A | 平均耗时: N/A\n- 最近执行: N/A\n`
    }

    // Find section and append entry
    const sectionIndex = content.indexOf(section)
    if (sectionIndex === -1) {
      // Section missing — add before Stats
      const statsIndex = content.indexOf('## Stats')
      if (statsIndex !== -1) {
        content = content.slice(0, statsIndex) + `${section}\n${entry}\n` + content.slice(statsIndex)
      } else {
        content += `\n${section}\n${entry}\n`
      }
    } else {
      // Find next section header after this one
      const nextSection = content.indexOf('\n## ', sectionIndex + section.length)
      const insertAt = nextSection !== -1 ? nextSection : content.length
      content = content.slice(0, insertAt) + entry + content.slice(insertAt)
    }

    // Trim old entries if over limit
    const lines = content.split('\n')
    const entries = lines.filter(l => l.startsWith('- ['))
    if (entries.length > MAX_EXPERIENCES) {
      // Remove oldest entry (first one found)
      const firstEntryIdx = lines.findIndex(l => l.startsWith('- ['))
      if (firstEntryIdx !== -1) {
        const nextEntryLine = lines[firstEntryIdx + 1]
        const removeCount = nextEntryLine?.startsWith('  **') ? 2 : 1
        lines.splice(firstEntryIdx, removeCount)
        content = lines.join('\n')
      }
    }

    writeFileSync(this.expFile, content, 'utf-8')
  }

  private incrementStat(type: 'success' | 'failure'): void {
    let content = this.getExperience()
    if (!content) {
      // Initialize with headers
      content = `# Agent Experience — ${this.agentName}\n\n## Success Patterns\n\n## Failure Patterns\n\n## Stats\n- 总执行: 0 次 | 成功: 0 | 失败: 0\n- 平均 token: N/A | 平均耗时: N/A\n- 最近执行: N/A\n`
    }

    const now = new Date().toISOString().slice(0, 16)

    // Replace stats line
    content = content.replace(
      /- 总执行: (\d+) 次 \| 成功: (\d+) \| 失败: (\d+)/,
      (_match, total: string, success: string, failure: string) => {
        const newTotal = parseInt(total) + 1
        const newSuccess = type === 'success' ? parseInt(success) + 1 : parseInt(success)
        const newFailure = type === 'failure' ? parseInt(failure) + 1 : parseInt(failure)
        return `- 总执行: ${newTotal} 次 | 成功: ${newSuccess} | 失败: ${newFailure}`
      },
    )

    // Update last run time
    content = content.replace(/- 最近执行:.*$/, `- 最近执行: ${now}`)

    writeFileSync(this.expFile, content, 'utf-8')
  }
}
```

- [ ] **Step 4: Run tests, all pass**

```bash
cd apps/cli && pnpm test -- --reporter=verbose test/agent/sub-agent.test.ts
```
Expected: ALL tests PASS (existing + 5 new).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/agent/agent-experience.ts apps/cli/test/agent/sub-agent.test.ts
git commit -m "feat(agent): add AgentExperience class for success/failure pattern tracking

- logSuccess() / logFailure() append dated entries with when-to-apply/avoid
- getExperience() returns full experience.md content
- reset() clears experience for fresh start
- MAX_EXPERIENCES=20 cap prevents unbounded growth

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3.2: SubAgent — 执行结束自动记录经验

**Files:**
- Modify: `apps/cli/src/agent/sub-agent.ts` (add ~30 lines)

**Interfaces:**
- Consumes: `AgentExperience` from Task 3.1, existing `SubAgent.execute()` flow
- Produces: automatic experience logging on sub-agent completion

- [ ] **Step 1: Verify baseline tests pass**

```bash
cd apps/cli && pnpm test -- --reporter=verbose test/agent/sub-agent.test.ts
```
Expected: All existing tests PASS.

- [ ] **Step 2: Implement auto-logging in SubAgent**

In `apps/cli/src/agent/sub-agent.ts`:

Add import:
```typescript
import { AgentExperience } from './agent-experience'
```

In `execute()` method, after the successful result (line ~83, synchronous path):

```typescript
// After successful result, before returning:
  // Auto-log agent experience
  try {
    const exp = new AgentExperience(agentType)
    if (result && result.trim()) {
      // Extract a short description from the result
      const firstLine = result.trim().split('\n')[0]?.slice(0, 150) || 'Task completed'
      exp.logSuccess(firstLine, description)
    }
  } catch {
    // Never let experience logging break execution
  }
```

In the catch block (line ~88):

```typescript
// After error handling, before re-throwing:
  try {
    const exp = new AgentExperience(agentType)
    const errMsg = String(err).slice(0, 200)
    exp.logFailure(errMsg, description)
  } catch {
    // Never let experience logging break execution
  }
```

- [ ] **Step 3: Run full test suite**

```bash
cd apps/cli && pnpm test -- --reporter=verbose
```
Expected: 642 tests PASS (zero regressions).

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/agent/sub-agent.ts
git commit -m "feat(agent): auto-log success/failure experience on sub-agent completion

- Successful execution extracts first line as pattern, description as context
- Failed execution logs error message as failure pattern
- Both wrapped in try/catch — never block agent execution
- Applies to both sync and background agent paths

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3.3: AgentContext — 经验注入到系统提示

**Files:**
- Modify: `apps/cli/src/agent/agent-context.ts` (add ~25 lines)

**Interfaces:**
- Consumes: `AgentExperience.getExperience()` from Task 3.1
- Produces: enhanced `createAgentContext()` that injects experience into system prompt

- [ ] **Step 1: Verify baseline tests pass**

```bash
cd apps/cli && pnpm test -- --reporter=verbose
```
Expected: All tests PASS.

- [ ] **Step 2: Implement experience injection**

In `apps/cli/src/agent/agent-context.ts`:

Add import:
```typescript
import { AgentExperience } from './agent-experience'
```

In `loadAgentMemory()` function, add experience loading:

```typescript
function loadAgentMemory(agentName: string, scope: 'user' | 'project' | 'local'): string {
  // ... existing static memory loading ...
  
  // 🆕 Also load auto-accumulated experience
  const exp = new AgentExperience(agentName)
  const experienceContent = exp.getExperience()
  
  let result = ''
  
  // Existing static memory
  // ... (keep existing code, collect into `result`) ...
  
  // Append experience (limit to recent N entries to control token usage)
  if (experienceContent) {
    const lines = experienceContent.split('\n')
    const statsSection = lines.findIndex(l => l.startsWith('## Stats'))
    const successStart = lines.findIndex(l => l.startsWith('## Success Patterns'))
    const failureStart = lines.findIndex(l => l.startsWith('## Failure Patterns'))
    
    // Extract: header + last 5 success + last 3 failure + stats
    const header = lines.slice(0, Math.min(successStart, failureStart) || 3).join('\n')
    const successes = lines.slice(successStart + 1, failureStart > successStart ? failureStart : undefined)
      .filter(l => l.startsWith('- ['))
      .slice(-5)
    const failures = lines.slice(failureStart + 1, statsSection > failureStart ? statsSection : undefined)
      .filter(l => l.startsWith('- ['))
      .slice(-3)
    const stats = statsSection !== -1 ? lines.slice(statsSection, statsSection + 3).join('\n') : ''
    
    if (successes.length > 0 || failures.length > 0) {
      result = result
        ? `${result}\n\n---\n\n## Agent Experience\n${header}\n${successes.join('\n')}\n${failures.join('\n')}\n${stats}`
        : `## Agent Experience\n${header}\n${successes.join('\n')}\n${failures.join('\n')}\n${stats}`
    }
  }
  
  return result
}
```

- [ ] **Step 3: Run full test suite**

```bash
cd apps/cli && pnpm test -- --reporter=verbose
```
Expected: 642 tests PASS (zero regressions).

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/agent/agent-context.ts
git commit -m "feat(agent): inject accumulated experience into agent system prompt

- loadAgentMemory() now reads experience.md via AgentExperience
- Injects last 5 successes + last 3 failures + stats into system prompt
- Token-efficient: only recent entries, not full history
- Backward compatible: no experience = no injection

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Final Verification

After all 9 tasks complete:

```bash
cd apps/cli
pnpm typecheck     # Must pass
pnpm lint          # Must pass  
pnpm format        # Must pass
pnpm test          # Must pass: 642 + 12 = 654 tests green
```

Then back in parent repo:
```bash
cd /Users/sarvadaya/Rismed_Ronxin_Capital/One_Mipham_Corporation
git add mipham-code
git commit -m "chore: bump mipham-code — Phase 7 Agent Memory 持久化"
```

---

## Task Summary

| # | Task | Files | Lines | Tests |
|---|------|-------|-------|-------|
| 1.1 | wikilinks + link graph | memory-manager.ts | +35 | +2 |
| 1.2 | dedup + structured paragraphs | memory-manager.ts | +25 | +2 |
| 1.3 | distillFromSession + time decay | memory-manager.ts | +30 | +1 |
| 2.1 | session index + summary | session-store.ts | +60 | +3 |
| 2.2 | /resume commands | commands.ts | +25 | +1 |
| 2.3 | SessionStart inject + exit save | index.tsx | +25 | 0 |
| 3.1 | AgentExperience class | agent-experience.ts (new) | +60 | +5 |
| 3.2 | sub-agent auto-log | sub-agent.ts | +30 | 0 |
| 3.3 | experience injection | agent-context.ts | +25 | 0 |
| **Total** | | **9 files** | **~315** | **+14** |
