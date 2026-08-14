# Vajra-Hṛdaya M1 — 会话日志归一（SessionLog + deriveMessages + replay）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引入 append-only 的 `SessionLog`（`SessionEvent` 流）+ `deriveMessages` 纯投影 + replay/fork/resume 消费器，收掉「测试可观测性」旧账——给定日志 + 回放器，replay 即回归测试（无需真实 API key）。

**Architecture:** 纯数据/日志层落在 `apps/cli/src/core/session-log.ts`，零依赖 vajra 内核（SessionLog 是数据层，不是 DI service；vajra 集成推迟到 M2 registry 升缝）。`messageToEvents` 与 `deriveMessages` 是一对**字节级互逆**的编解码器（round-trip 是正确性锚点）。ContextManager 通过 `setLog()` 可选持有日志，`addMessage` 追加事件（写通镜像），压缩只改投影缓存、日志永不删除——满足 spec §4.1「存源流、派投影」。

**Tech Stack:** TypeScript 5.5+ strict（no-semicolon、`noUncheckedIndexedAccess: true`）、Vitest 3（globals: true）。

**Spec:** [docs/superpowers/specs/2026-08-15-vajra-hrdaya-kernel-design.md](../specs/2026-08-15-vajra-hrdaya-kernel-design.md)（§四 会话日志单一事实源 + §7.3 M1）

## Global Constraints

- TypeScript strict 模式，ESM；代码风格 **no-semicolon**（现有代码与 CI 绿为证），Prettier + ESLint（flat config）在 **repo 根目录** 强制（非 apps/cli）。
- tsconfig `noUncheckedIndexedAccess: true`：数组索引必须加 `!` 断言或先判空（边界由显式守卫保证时才加 `!`）。
- 测试：Vitest 3，globals: true，测试文件镜像 src 路径（`test/core/session-log.test.ts`）。
- 提交信息遵循 Conventional Commits（`feat(session-log): …` / `fix(session-log): …`）。
- **零迁移纪律**：Task 1–4 只新增文件，不碰任何现有 `src/` 文件；Task 5–6 对 `context.ts`/`index.tsx` 的改动必须是**可加可不加**（log 未 attach 时行为不变）。
- 命令：测试 `cd apps/cli && pnpm test`（单文件 `pnpm test session-log`）；类型 `cd apps/cli && pnpm typecheck`；lint/format 在 repo 根 `pnpm lint` / `pnpm format`。
- `Message` 类型定义于 `src/shared/types.ts`（`role: 'system'|'user'|'assistant'`，`content: string | ContentBlock[]`，`reasoning_content?: string`）；`ContentBlock` = Text | Image | ToolUse | ToolResult | Thinking。

---

### Task 1: SessionEvent 类型 + messageToEvents/deriveMessages 编解码对

**Files:**

- Create: `apps/cli/src/core/session-log.ts`
- Test: `apps/cli/test/core/session-log.test.ts`

**Interfaces:**

- Consumes: `Message`, `ContentBlock`, `ToolUseContent`, `ToolResultContent` from `../shared/types`.
- Produces: `SessionEvent`（联合类型）、`messageToEvents(msg, at?)`、`deriveMessages(events)`——Task 2–5 依赖。

**规格**（spec §4.2 裁剪：M1 只做消息级 replay，`assistant/chunk` 原始流块推迟）：

- [ ] **Step 1: 写失败测试**

```ts
// test/core/session-log.test.ts
import { describe, it, expect } from 'vitest'
import { messageToEvents, deriveMessages } from '../../src/core/session-log'
import type { Message } from '../../src/shared/types'

describe('messageToEvents ↔ deriveMessages round-trip', () => {
  const samples: Message[] = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there!', reasoning_content: 'thinking...' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'read', input: { file_path: '/a' } }],
      reasoning_content: '',
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '…' },
        { type: 'text', text: 'done' },
      ],
    },
  ]

  it('round-trips each sample byte-identically', () => {
    for (const m of samples) {
      expect(deriveMessages(messageToEvents(m))).toEqual([m])
    }
  })

  it('round-trips a full turn sequence preserving order', () => {
    const seq = samples
    const events = seq.flatMap((m) => messageToEvents(m, 1000))
    expect(deriveMessages(events)).toEqual(seq)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/cli && pnpm test session-log`
Expected: FAIL（模块不存在，`Cannot find module`）

- [ ] **Step 3: 写最小实现**

```ts
// src/core/session-log.ts
import type { Message, ToolUseContent, ToolResultContent } from '../shared/types'

export type SessionEvent =
  | { type: 'session/start'; at: number; sessionId: string }
  | { type: 'user/message'; at: number; message: Message }
  | { type: 'assistant/message'; at: number; message: Message }
  | { type: 'tool/call'; at: number; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool/result'; at: number; id: string; content: string }
  | { type: 'context/inject'; at: number; source: string; text: string }
  | { type: 'compaction/summary'; at: number; summary: string }

export function messageToEvents(msg: Message, at = 0): SessionEvent[] {
  if (msg.role === 'user') {
    if (Array.isArray(msg.content)) {
      const results = msg.content.filter((b) => b.type === 'tool_result') as ToolResultContent[]
      if (results.length > 0 && results.length === msg.content.length) {
        return results.map((r) => ({
          type: 'tool/result',
          at,
          id: r.tool_use_id,
          content: r.content,
        }))
      }
      return [{ type: 'user/message', at, message: msg }]
    }
    return [{ type: 'user/message', at, message: msg }]
  }
  if (msg.role === 'assistant') {
    if (Array.isArray(msg.content)) {
      const uses = msg.content.filter((b) => b.type === 'tool_use') as ToolUseContent[]
      if (uses.length > 0 && uses.length === msg.content.length) {
        return uses.map((u) => ({ type: 'tool/call', at, id: u.id, name: u.name, input: u.input }))
      }
      return [{ type: 'assistant/message', at, message: msg }]
    }
    return [{ type: 'assistant/message', at, message: msg }]
  }
  return [] // system 消息不产事件（引擎 system prompt 走独立通道）
}

export function deriveMessages(events: SessionEvent[]): Message[] {
  const out: Message[] = []
  for (const e of events) {
    if (e.type === 'user/message' || e.type === 'assistant/message') {
      out.push(e.message)
    } else if (e.type === 'tool/call') {
      out.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: e.id, name: e.name, input: e.input }],
        reasoning_content: '',
      })
    } else if (e.type === 'tool/result') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: e.id, content: e.content }],
      })
    } else if (e.type === 'context/inject') {
      out.push({ role: 'user', content: e.text })
    } else if (e.type === 'compaction/summary') {
      out.push({ role: 'user', content: `[Earlier conversation summary]: ${e.summary}` })
    }
    // 'session/start' → 无消息
  }
  return out
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/cli && pnpm test session-log`
Expected: PASS（round-trip 5 样例 + 序列）

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/session-log.ts apps/cli/test/core/session-log.test.ts
git commit -m "feat(session-log): add SessionEvent type + messageToEvents/deriveMessages codec"
```

---

### Task 2: SessionLog 类（append-only + JSONL 持久化）

**Files:**

- Modify: `apps/cli/src/core/session-log.ts`
- Test: `apps/cli/test/core/session-log.test.ts`（追加 describe）

**Interfaces:**

- Consumes: `SessionEvent`、`messageToEvents`（Task 1）。
- Produces: `SessionLog` 类——`append(event)`、`events(): SessionEvent[]`（不可变快照）、`SessionLog.open(name): SessionLog`、`save(name)`。Task 4–6 依赖。

**规格**（spec §4.2 落盘格式沿用 session-store 的 JSONL，但改 append 追加）：

- [ ] **Step 1: 写失败测试**

```ts
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { SessionLog, messageToEvents } from '../../src/core/session-log'

const HOME = process.env.HOME || '~'
const LOG_DIR = join(HOME, '.mipham', 'sessions')

describe('SessionLog append-only', () => {
  const name = `test-log-${Date.now()}`
  afterEach(() => {
    rmSync(join(LOG_DIR, `${name}.jsonl`), { force: true })
  })

  it('appends events and returns an immutable snapshot', () => {
    const log = new SessionLog(name)
    const a = { type: 'user/message', at: 1, message: { role: 'user', content: 'hi' } } as const
    log.append(a)
    const snap = log.events()
    expect(snap).toHaveLength(1)
    snap.push(a) // mutation of the snapshot must not affect the log
    expect(log.events()).toHaveLength(1)
  })

  it('persists to JSONL and reopens byte-identically', () => {
    const log = new SessionLog(name, { now: () => 1 })
    log.append({ type: 'session/start', at: 1, sessionId: name })
    log.append({ type: 'user/message', at: 1, message: { role: 'user', content: 'hi' } })
    log.append(messageToEvents({ role: 'assistant', content: 'ok' }, 1)[0]!)
    log.save()

    expect(existsSync(join(LOG_DIR, `${name}.jsonl`))).toBe(true)
    const reopened = SessionLog.open(name)
    expect(reopened.events()).toEqual(log.events())
  })

  it('open on missing file returns empty log', () => {
    const log = SessionLog.open('test-log-nonexistent-xyz')
    expect(log.events()).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/cli && pnpm test session-log`
Expected: FAIL（`SessionLog` 未导出）

- [ ] **Step 3: 写最小实现**

在 `session-log.ts` 追加（顶部加 `import { appendFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'`、`import { join } from 'node:path'`）：

```ts
const HOME = process.env.HOME || '~'
const LOG_DIR = join(HOME, '.mipham', 'sessions')

export class SessionLog {
  private buf: SessionEvent[] = []
  private now: () => number

  constructor(
    private name: string,
    opts?: { now?: () => number },
  ) {
    this.now = opts?.now ?? (() => Date.now())
  }

  append(event: SessionEvent): void {
    this.buf.push(event)
  }

  /** 不可变快照（浅拷贝，事件本身视为不可变）。 */
  events(): SessionEvent[] {
    return [...this.buf]
  }

  /** 追加写入 JSONL（每行一个事件，不重写整文件）。 */
  save(): void {
    mkdirSync(LOG_DIR, { recursive: true })
    for (const e of this.buf) {
      appendFileSync(join(LOG_DIR, `${this.name}.jsonl`), JSON.stringify(e) + '\n', 'utf-8')
    }
  }

  /** 从既有 JSONL 打开，逐行解析为事件。 */
  static open(name: string): SessionLog {
    const log = new SessionLog(name)
    const path = join(LOG_DIR, `${name}.jsonl`)
    if (!existsSync(path)) return log
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        log.buf.push(JSON.parse(trimmed) as SessionEvent)
      } catch {
        // 跳过损坏行
      }
    }
    return log
  }
}
```

> 注：`appendFileSync` 逐事件追加是 O(n) 每次 save；M1 的 save 是低频（会话结束/命令触发），非热路径，可接受。若未来需要高效，改 `writeFileSync` 全量 + 内存去重（M1b 与 SessionStore 持久化翻转一并考虑）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/cli && pnpm test session-log`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/session-log.ts apps/cli/test/core/session-log.test.ts
git commit -m "feat(session-log): add append-only SessionLog with JSONL persistence"
```

---

### Task 3: 不变量 assertModelVisible（model-visible means logged）

**Files:**

- Modify: `apps/cli/src/core/session-log.ts`
- Test: `apps/cli/test/core/session-log.test.ts`（追加 describe）

**Interfaces:**

- Consumes: `deriveMessages`（Task 1）、`SessionEvent`。
- Produces: `assertModelVisible(log, messages)`、`isCompactionSummary(msg)`（Task 5 的 compact 集成用它检测豁免）。

**规格**（spec §4.3：凡进入模型请求的内容必须能从日志重放；M1 口径 = 子序列匹配，压缩摘要豁免）：

- [ ] **Step 1: 写失败测试**

```ts
import { assertModelVisible } from '../../src/core/session-log'

describe('assertModelVisible', () => {
  const ev = (m: Message) => messageToEvents(m, 0)

  it('passes when messages are a subsequence of the derived log', () => {
    const log = [
      ...ev({ role: 'user', content: 'a' }),
      ...ev({ role: 'assistant', content: 'b' }),
      ...ev({ role: 'user', content: 'c' }),
    ]
    expect(() =>
      assertModelVisible(log, [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'c' },
      ]),
    ).not.toThrow()
  })

  it('throws when a message is not logged', () => {
    const log = ev({ role: 'user', content: 'a' })
    expect(() => assertModelVisible(log, [{ role: 'user', content: 'NOT-LOGGED' }])).toThrow(
      /not logged/,
    )
  })

  it('exempts compaction summaries', () => {
    const log = ev({ role: 'user', content: 'a' })
    expect(() =>
      assertModelVisible(log, [{ role: 'user', content: '[Earlier conversation summary]: …' }]),
    ).not.toThrow()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/cli && pnpm test session-log`
Expected: FAIL（`assertModelVisible` 未导出）

- [ ] **Step 3: 写最小实现**

```ts
const SUMMARY_PREFIX = '[Earlier conversation summary]:'

export function isCompactionSummary(m: Message): boolean {
  return m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(SUMMARY_PREFIX)
}

function messagesEqual(a: Message, b: Message): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 断言 messages 是 deriveMessages(log) 的子序列（压缩摘要豁免）。失败即抛错（fail-loud）。 */
export function assertModelVisible(log: SessionEvent[], messages: Message[]): void {
  const derived = deriveMessages(log)
  let di = 0
  for (const m of messages) {
    if (isCompactionSummary(m)) continue
    while (di < derived.length && !messagesEqual(derived[di]!, m)) di++
    if (di >= derived.length) {
      throw new Error(`Model-visible message not logged: ${JSON.stringify(m).slice(0, 200)}`)
    }
    di++
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/cli && pnpm test session-log`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/session-log.ts apps/cli/test/core/session-log.test.ts
git commit -m "feat(session-log): add model-visible invariant assertModelVisible"
```

---

### Task 4: replay / fork / resume 消费器

**Files:**

- Modify: `apps/cli/src/core/session-log.ts`
- Test: `apps/cli/test/core/session-log.test.ts`（追加 describe）

**Interfaces:**

- Consumes: `SessionLog`（Task 2）、`deriveMessages`（Task 1）。
- Produces: `replayMessages(log)`、`forkEvents(events, uptoIndex)`、`resumeMessages(log)`（Task 6 及未来 fork/resume 依赖）。

**规格**（spec §4.4：fork/resume/replay/transcript/telemetry/persistence 全从同一流派生；replay 即回归测试）：

- [ ] **Step 1: 写失败测试**

```ts
import { replayMessages, forkEvents, resumeMessages } from '../../src/core/session-log'

describe('replay / fork / resume', () => {
  const turn = (at: number) => [
    { type: 'user/message', at, message: { role: 'user', content: 'q' } } as SessionEvent,
    { type: 'assistant/message', at, message: { role: 'assistant', content: 'a' } } as SessionEvent,
  ]

  it('replayMessages derives the full message history from a log', () => {
    const log = new SessionLog('replay-test')
    turn(1).forEach((e) => log.append(e))
    turn(2).forEach((e) => log.append(e))
    expect(replayMessages(log)).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ])
  })

  it('forkEvents truncates the log at a prefix index', () => {
    const events = [...turn(1), ...turn(2)]
    expect(forkEvents(events, 2)).toEqual(turn(1))
  })

  it('resumeMessages equals replayMessages (alias for streaming resume)', () => {
    const log = new SessionLog('resume-test')
    turn(1).forEach((e) => log.append(e))
    expect(resumeMessages(log)).toEqual(replayMessages(log))
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/cli && pnpm test session-log`
Expected: FAIL（消费器未导出）

- [ ] **Step 3: 写最小实现**

```ts
/** replay：从日志派生完整消息历史（回归测试可断言其确定性）。 */
export function replayMessages(log: SessionLog): Message[] {
  return deriveMessages(log.events())
}

/** fork：截取日志前缀（到 uptoIndex，含）作为子会话继承的基。 */
export function forkEvents(events: SessionEvent[], uptoIndex: number): SessionEvent[] {
  return events.slice(0, uptoIndex)
}

/** resume：从日志恢复消息历史（与 replay 同源；独立命名便于语义区分）。 */
export function resumeMessages(log: SessionLog): Message[] {
  return deriveMessages(log.events())
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/cli && pnpm test session-log`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/session-log.ts apps/cli/test/core/session-log.test.ts
git commit -m "feat(session-log): add replay/fork/resume consumers"
```

---

### Task 5: ContextManager 写通集成（可选 log + addMessage 追加）

**Files:**

- Modify: `apps/cli/src/core/context.ts`
- Test: `apps/cli/test/core/context.test.ts`（追加 describe）

**Interfaces:**

- Consumes: `SessionLog`、`messageToEvents`、`assertModelVisible`（Task 1–3）。
- Produces: `ContextManager.setLog(log?)`、`getLog()`。`addMessage`/`seedMessages` 在有 log 时追加事件；`compact()` 追加 `compaction/summary` 事件。

**规格**（spec §4.1/§7.3：日志是源，messages 是投影缓存；压缩只改投影、日志不删）：

- [ ] **Step 1: 写失败测试**

在 `test/core/context.test.ts` 追加（顶部加 import）：

```ts
import { SessionLog, deriveMessages } from '../../src/core/session-log'

describe('ContextManager log integration', () => {
  it('addMessage appends events to an attached log', () => {
    const cm = new ContextManager({ maxTokens: 100000, compactionThreshold: 0.9 })
    const log = new SessionLog('cm-test')
    cm.setLog(log)
    cm.addMessage({ role: 'user', content: 'hi' })
    cm.addMessage({ role: 'assistant', content: 'hello' })
    expect(deriveMessages(log.events())).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
  })

  it('behaves unchanged when no log is attached', () => {
    const cm = new ContextManager({ maxTokens: 100000, compactionThreshold: 0.9 })
    cm.addMessage({ role: 'user', content: 'hi' })
    expect(cm.getMessages()).toEqual([{ role: 'user', content: 'hi' }])
    expect(cm.getLog()).toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/cli && pnpm test context`
Expected: FAIL（`setLog` 不存在）

- [ ] **Step 3: 写最小实现**

在 `context.ts` 顶部加 import，类内加字段与方法：

```ts
import { SessionLog, messageToEvents } from './session-log'
```

类内（构造器后）：

```ts
private log?: SessionLog

/** 附加一个 append-only 会话日志；addMessage/seedMessages 将写通镜像到日志。 */
setLog(log?: SessionLog): void {
  this.log = log
}

getLog(): SessionLog | undefined {
  return this.log
}
```

`addMessage` 改（在 `this.checkCompression()` 前追加）：

```ts
addMessage(msg: Message): void {
  this.messages.push(msg)
  this.estimatedTokens += this.estimateTokens(
    typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
  )
  if (this.log) {
    for (const e of messageToEvents(msg, Date.now())) this.log.append(e)
  }
  this.checkCompression()
}
```

`seedMessages` 改（在 `this.reEstimateTokens()` 前追加）：

```ts
seedMessages(messages: Message[]): void {
  if (messages.length === 0) return
  this.messages.push(...messages)
  if (this.log) {
    for (const m of messages) for (const e of messageToEvents(m, Date.now())) this.log.append(e)
  }
  this.reEstimateTokens()
}
```

`compact()` 改（在返回 `{ before, after }` 前追加——只在走 summarizer 分支时记录摘要事件）：

```ts
if (this.summarizer && toDrop.length >= 4) {
  try {
    const summary = await this.summarizer(toDrop, heading)
    const summaryMsg: Message = {
      role: 'user',
      content: `[Earlier conversation summary]: ${summary}`,
    }
    this.messages = [summaryMsg, ...this.messages.slice(-keep)]
    if (this.log) this.log.append({ type: 'compaction/summary', at: Date.now(), summary })
  } catch {
    /* 原有 fallback 不变 */
  }
}
```

> 注：`compact()` 的 LLM 摘要分支已有 `try { … summary … } catch { … }` 结构；仅在成功路径、`this.messages` 被替换成摘要那行之后追加 log.append。其余分支（truncation）不产摘要事件（truncation 只是丢弃投影，日志已含全部原始事件）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/cli && pnpm test context`
Expected: PASS（新 describe + 既有 context 测试全绿）

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/context.ts apps/cli/test/core/context.test.ts
git commit -m "feat(context): write-through mirror to optional SessionLog"
```

---

### Task 6: 主 app 接线 + 全量绿

**Files:**

- Modify: `apps/cli/src/index.tsx`（构造处 attach 一个内存 SessionLog）
- Test: 无新增（跑全量）

**Interfaces:**

- Consumes: `SessionLog`、`ContextManager.setLog`（Task 2、5）。

**规格**：让真实会话在内存中捕获日志，使 replay/fork/resume 在真实会话可用（持久化到 `~/.mipham/sessions/<name>.jsonl` 的接线与 SessionStore 翻转推迟到 M1b）。

- [ ] **Step 1: 定位构造点**

`src/index.tsx` 中 `const context = new ContextManager({...})`（约 :326）之后，`new QueryEngine(...)`（约 :470）之前，插入：

```ts
import { SessionLog } from './core/session-log'
// …在 context 构造后：
context.setLog(new SessionLog('session'))
```

> 注：会话真实 id 是运行时 `engine.setSessionId(id)` 注入（构造后），M1 用一个占位名 `'session'` 让日志可用即可；按真实 id 持久化/重开留待 M1b。若 :326 附近已有同文件 import 区块，遵循现有 import 分组风格。

- [ ] **Step 2: typecheck**

Run: `cd apps/cli && pnpm typecheck`
Expected: 无新错误

- [ ] **Step 3: 全量测试**

Run: `cd apps/cli && pnpm test`
Expected: 全绿（既有 ~1335 tests + 新增 session-log/context tests），0 失败

- [ ] **Step 4: lint + format（repo 根）**

Run: `pnpm lint` 然后 `pnpm format`
Expected: 无新错误（若 format 改动，纳入本次提交）

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/index.tsx
git commit -m "feat(cli): attach in-memory SessionLog at app startup"
```

---

## Self-Review

**Spec coverage**（对照 spec §四 + §7.3）：

- §4.2 SessionEvent 流 → Task 1（`assistant/chunk` 原始流块明确推迟，plan 已注明）。
- §4.1「存源流、派投影」+ §4.3 不变量 → Task 2/3/5。
- §4.4 消费者（fork/resume/replay）→ Task 4。
- §7.3「ContextManager 从源降级为投影」→ Task 5 做的是**写通镜像 + 日志不删**（messages 仍是投影缓存，日志成为持久源）；完整的「压缩走日志投影」是 M2/M1b 范畴，plan 已明确 defer。
- §7.3「fork/resume 测试」→ Task 4；「model-visible means logged 断言测试」→ Task 3；「replay 确定性测试」→ Task 4。

**Placeholder scan**：无 TBD/TODO；每个 Step 含实际代码。

**Type consistency**：`SessionEvent` 七变体、`messageToEvents(msg, at=0)`、`deriveMessages(events)`、`SessionLog(name, opts?)` 的方法名在各 Task 间一致；`setLog`/`getLog` 在 Task 5/6 一致。

**Explicit deferrals（M1b）**：`assistant/chunk` 流级 replay、SessionStore 持久化翻转（save→append/load→derive + 旧格式回退）、按真实 sessionId 持久化。
