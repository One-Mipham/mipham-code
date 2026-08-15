# Vajra-Hṛdaya M1b — SessionStore 持久化翻转（save→append / load→derive + 旧格式回退）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让会话真正通过 append-only 的 `SessionEvent` 日志持久化——`SessionStore` 从「整文件快照写 `{metadata,messages}`」翻转为「追加写原始事件流」，`load`/`list` 派投影，旧格式文件回退兼容；真实 sessionId 接线（含 resume 不重复写通）。

**Architecture:** 持久化走 `SessionLog.save()/open()`（M1 已有 flush 游标幂等 append）。`session/start` 事件扩展携带 `provider/model/cwd` 元数据。`SessionStore` 新增 `saveLog`/`loadLog`，`load`/`list` 双格式检测。resume 用 `ContextManager.restoreLog(log)`（设 log 为源、messages 为投影，不重复写通）。

**Tech Stack:** TypeScript 5.5+ strict（no-semicolon、`noUncheckedIndexedAccess`）、Vitest 3（globals:true）。

**Spec:** [docs/superpowers/specs/2026-08-15-vajra-hrdaya-kernel-design.md](../specs/2026-08-15-vajra-hrdaya-kernel-design.md)（§4.1 持久化翻转 + §7.3 M1）

## Global Constraints

- TypeScript strict，ESM，**no-semicolon**；Prettier + ESLint 在 repo 根。
- `noUncheckedIndexedAccess: true`：数组索引加 `!` 或先判空。
- Vitest 3 globals:true，测试镜像 src 路径。
- Conventional Commits。
- **零破坏**：`SessionStore.save/load/list/delete/autoSave` 的既有测试必须全绿（它们编码了 round-trip 契约）。`save`（旧快照）保留作旧格式写入，`load`/`list` 双格式读。
- 命令：测试 `cd apps/cli && pnpm test`；类型 `cd apps/cli && pnpm typecheck`；lint/format 在 repo 根。
- `SessionLog` 定义于 `src/core/session-log.ts`（`SessionEvent`、`messageToEvents`、`deriveMessages`、`SessionLog`、`assertModelVisible`、`replayMessages/forkEvents/resumeMessages`）。`SessionStore` 定义于 `src/core/session-store.ts`。

---

### Task 1: session/start 扩展元数据 + SessionLog 路径消毒

**Files:**

- Modify: `apps/cli/src/core/session-log.ts`
- Modify: `apps/cli/src/core/session-store.ts`（`filePath` 复用消毒函数）
- Test: `apps/cli/test/core/session-log.test.ts`（追加）

**Interfaces:**

- Produces: `sanitizeSessionName(name)`（导出）、`session/start` 变体新增 `provider?/model?/cwd?`。Task 2–5 依赖。

- [ ] **Step 1: 写失败测试**

在 `session-log.test.ts` 追加（顶部 import `sanitizeSessionName`）：

```ts
import { sanitizeSessionName } from '../../src/core/session-log'
// …文件末尾追加：
describe('sanitizeSessionName', () => {
  it('replaces path-special chars with underscores', () => {
    expect(sanitizeSessionName('../etc/passwd')).toBe('____etc_passwd')
  })
  it('hashes over-long names deterministically', () => {
    const long = 'x'.repeat(120)
    const a = sanitizeSessionName(long)
    const b = sanitizeSessionName(long)
    expect(a).toBe(b)
    expect(a.length).toBeLessThan(100)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/cli && pnpm test session-log`
Expected: FAIL（`sanitizeSessionName` 未导出）

- [ ] **Step 3: 写实现**

`session-log.ts` 顶部 import 加 `import { createHash } from 'node:crypto'`；`session/start` 变体改为：

```ts
| { type: 'session/start'; at: number; sessionId: string; provider?: string; model?: string; cwd?: string }
```

在 `LOG_DIR` 定义后加：

```ts
/** 将会话名消毒为安全文件名（与 SessionStore 共用；防路径穿越）。 */
export function sanitizeSessionName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (safe.length > 100) {
    const hash = createHash('sha256').update(safe).digest('hex').slice(0, 16)
    return `${safe.slice(0, 80)}-${hash}`
  }
  return safe
}
```

`SessionLog.save()` 与 `open()` 中的路径拼接改为用消毒名：

```ts
const path = join(LOG_DIR, `${sanitizeSessionName(this.name)}.jsonl`)
```

`session-store.ts` 的 `filePath` 改为复用（顶部加 `import { sanitizeSessionName } from './session-log'`）：

```ts
function filePath(name: string): string {
  return join(SESSIONS_DIR, `${sanitizeSessionName(name)}.jsonl`)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/cli && pnpm test session-log session-store`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/session-log.ts apps/cli/src/core/session-store.ts apps/cli/test/core/session-log.test.ts
git commit -m "feat(session-log): sanitize session name + extend session/start metadata"
```

---

### Task 2: SessionStore.saveLog + loadLog

**Files:**

- Modify: `apps/cli/src/core/session-store.ts`
- Test: `apps/cli/test/core/session-store.test.ts`（追加）

**Interfaces:**

- Consumes: `SessionLog`、`sanitizeSessionName`、`deriveMessages`（Task 1）。
- Produces: `SessionStore.saveLog(name, log, meta?)`、`SessionStore.loadLog(name)`。

- [ ] **Step 1: 写失败测试**

在 `session-store.test.ts` 追加（顶部 import `SessionLog`）：

```ts
import { SessionLog } from '../../src/core/session-log'
// …describe 内追加：
describe('saveLog / loadLog', () => {
  it('persists a log and reloads it with events intact', () => {
    const log = new SessionLog('test-savelog')
    log.append({ type: 'session/start', at: 1, sessionId: 'test-savelog', provider: 'anthropic' })
    log.append({ type: 'user/message', at: 1, message: { role: 'user', content: 'hi' } })
    SessionStore.saveLog('test-savelog', log, { provider: 'anthropic', model: 'm' })

    const reloaded = SessionStore.loadLog('test-savelog')
    expect(reloaded).not.toBeNull()
    expect(reloaded!.events()).toHaveLength(2)
    expect(reloaded!.events()[0]).toMatchObject({
      type: 'session/start',
      sessionId: 'test-savelog',
    })
  })

  it('saveLog adds a session/start event if missing, and is idempotent', () => {
    const log = new SessionLog('test-savelog2')
    log.append({ type: 'user/message', at: 1, message: { role: 'user', content: 'hi' } })
    SessionStore.saveLog('test-savelog2', log, { provider: 'p' })
    SessionStore.saveLog('test-savelog2', log, { provider: 'p' })

    const reloaded = SessionStore.loadLog('test-savelog2')
    expect(reloaded!.events()).toHaveLength(2) // session/start + user/message, 无重复
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/cli && pnpm test session-store`
Expected: FAIL（`saveLog` 未定义）

- [ ] **Step 3: 写实现**

```ts
/** 追加持久化一个 SessionLog（幂等：只写新事件）。缺失 session/start 时补一个。 */
static saveLog(
  name: string,
  log: SessionLog,
  meta?: { provider?: string; model?: string; cwd?: string },
): void {
  ensureDir()
  const events = log.events()
  if (!events.some((e) => e.type === 'session/start')) {
    log.append({ type: 'session/start', at: Date.now(), sessionId: name, ...meta })
  }
  log.save()
  try {
    const messages = deriveMessages(log.events())
    SessionStore.updateIndexEntry(name, {
      name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      provider: meta?.provider || 'unknown',
      model: meta?.model || 'unknown',
      messageCount: messages.length,
      cwd: meta?.cwd,
    })
  } catch {
    // index 更新 best-effort
  }
}

/** 从磁盘重开一个 SessionLog（不存在返回空 log）。 */
static loadLog(name: string): SessionLog {
  return SessionLog.open(name)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/cli && pnpm test session-store`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/session-store.ts apps/cli/test/core/session-store.test.ts
git commit -m "feat(session-store): add saveLog/loadLog append-only persistence"
```

---

### Task 3: SessionStore.load 双格式（旧格式回退 + 新格式 derive）

**Files:**

- Modify: `apps/cli/src/core/session-store.ts`
- Test: `apps/cli/test/core/session-store.test.ts`（追加）

**Interfaces:**

- Consumes: `SessionLog`、`deriveMessages`（Task 1/2）。
- Produces: `load(name)` 双格式；私有 `logToStoredSession(name, log)`。

- [ ] **Step 1: 写失败测试**

```ts
describe('load old-format fallback + new-format derive', () => {
  it('loads a new-format (event log) session', () => {
    const log = new SessionLog('test-load-new')
    log.append({
      type: 'session/start',
      at: 1,
      sessionId: 'test-load-new',
      provider: 'openai',
      model: 'gpt',
    })
    log.append({ type: 'user/message', at: 1, message: { role: 'user', content: 'Hello' } })
    log.append({ type: 'assistant/message', at: 1, message: { role: 'assistant', content: 'Hi' } })
    SessionStore.saveLog('test-load-new', log)

    const loaded = SessionStore.load('test-load-new')
    expect(loaded).not.toBeNull()
    expect(loaded!.messages).toHaveLength(2)
    expect(loaded!.messages[0]!.content).toBe('Hello')
    expect(loaded!.metadata.provider).toBe('openai')
    expect(loaded!.metadata.model).toBe('gpt')
  })

  it('still loads an old-format (snapshot) session', () => {
    SessionStore.save('test-load-old', [{ role: 'user', content: 'legacy' }], {
      provider: 'anthropic',
    })
    const loaded = SessionStore.load('test-load-old')
    expect(loaded).not.toBeNull()
    expect(loaded!.messages).toHaveLength(1)
    expect(loaded!.metadata.provider).toBe('anthropic')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/cli && pnpm test session-store`
Expected: FAIL（新格式 load 失败）

- [ ] **Step 3: 写实现**

`load` 重写 + 加私有 helper（`filePath` 之上的 `statSync` 已 import）：

```ts
static load(name: string): StoredSession | null {
  const path = filePath(name)
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf-8')
    // 旧格式：单 JSON 对象 {metadata, messages}
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && 'metadata' in parsed && Array.isArray((parsed as { messages?: unknown }).messages)) {
      return parsed as StoredSession
    }
  } catch {
    // 多行 JSONL → 新格式，走事件解析
  }
  return logToStoredSession(name, SessionLog.open(name))
}

private static logToStoredSession(name: string, log: SessionLog): StoredSession | null {
  const events = log.events()
  const start = events.find((e) => e.type === 'session/start') as
    | { type: 'session/start'; at: number; sessionId: string; provider?: string; model?: string; cwd?: string }
    | undefined
  const messages = deriveMessages(events)
  const stat = statSync(filePath(name))
  return {
    metadata: {
      name,
      createdAt: stat.mtime.toISOString(),
      updatedAt: stat.mtime.toISOString(),
      provider: start?.provider || 'unknown',
      model: start?.model || 'unknown',
      messageCount: messages.length,
      cwd: start?.cwd,
    },
    messages,
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/cli && pnpm test session-store`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/session-store.ts apps/cli/test/core/session-store.test.ts
git commit -m "feat(session-store): dual-format load with old-snapshot fallback"
```

---

### Task 4: SessionStore.list 双格式

**Files:**

- Modify: `apps/cli/src/core/session-store.ts`
- Test: `apps/cli/test/core/session-store.test.ts`（追加）

**Interfaces:**

- Consumes: `load`（Task 3，双格式）。

- [ ] **Step 1: 写失败测试**

```ts
describe('list dual-format', () => {
  it('lists both new-format and old-format sessions', () => {
    const log = new SessionLog('test-list-new')
    log.append({ type: 'session/start', at: 1, sessionId: 'test-list-new', provider: 'openai' })
    log.append({ type: 'user/message', at: 1, message: { role: 'user', content: 'a' } })
    SessionStore.saveLog('test-list-new', log)
    SessionStore.save('test-list-old', [{ role: 'user', content: 'b' }])

    const names = SessionStore.list().map((s) => s.name)
    expect(names).toContain('test-list-new')
    expect(names).toContain('test-list-old')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/cli && pnpm test session-store`
Expected: FAIL（旧 list 对新格式抛错/漏列）

- [ ] **Step 3: 写实现**

`list` 重写为复用 `load`：

```ts
static list(): SessionMetadata[] {
  ensureDir()
  try {
    const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.jsonl'))
    const sessions: SessionMetadata[] = []
    for (const file of files) {
      const name = file.replace('.jsonl', '')
      const session = SessionStore.load(name)
      if (session?.metadata) sessions.push(session.metadata)
    }
    sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    return sessions
  } catch {
    return []
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/cli && pnpm test session-store`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/session-store.ts apps/cli/test/core/session-store.test.ts
git commit -m "feat(session-store): dual-format list"
```

---

### Task 5: ContextManager.restoreLog + 真实 sessionId 接线

**Files:**

- Modify: `apps/cli/src/core/context.ts`
- Modify: `apps/cli/src/index.tsx`
- Modify: `apps/cli/src/ui/commands.ts`（`/cd` 保存处）
- Test: `apps/cli/test/core/context.test.ts`（追加）

**Interfaces:**

- Consumes: `SessionLog`、`deriveMessages`、`saveLog/loadLog`（Task 1–4）。
- Produces: `ContextManager.restoreLog(log)`。

- [ ] **Step 1: 写失败测试**

`context.test.ts` 追加（import `deriveMessages`）：

```ts
import { SessionLog, deriveMessages } from '../../src/core/session-log'
// …describe 内追加：
it('restoreLog sets log as source without re-appending', () => {
  const log = new SessionLog('restore-test')
  log.append({ type: 'session/start', at: 1, sessionId: 'restore-test' })
  log.append({ type: 'user/message', at: 1, message: { role: 'user', content: 'hi' } })
  log.append({ type: 'assistant/message', at: 1, message: { role: 'assistant', content: 'yo' } })

  const cm = new ContextManager({ maxTokens: 100000, compactionThreshold: 0.9 })
  cm.restoreLog(log)
  expect(cm.getMessages()).toEqual([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'yo' },
  ])
  expect(deriveMessages(cm.getLog()!.events())).toHaveLength(2) // 未重复写通
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/cli && pnpm test context`
Expected: FAIL（`restoreLog` 未定义）

- [ ] **Step 3: 写实现**

`context.ts` 顶部 import 加 `deriveMessages`：

```ts
import { SessionLog, messageToEvents, deriveMessages } from './session-log'
```

类内加方法（在 `getLog()` 后）：

```ts
/** 从已持久化的日志恢复：设 log 为源，messages 为投影（不重复写通）。 */
restoreLog(log: SessionLog): void {
  this.log = log
  this.messages = deriveMessages(log.events())
  this.reEstimateTokens()
}
```

- [ ] **Step 4: 接线 index.tsx**

`index.tsx:332` 改为（`sessionName` 在 :288 已定义，`defaultProvider`/`defaultModel` 可用）：

```ts
const sessionLog = new SessionLog(sessionName)
sessionLog.append({
  type: 'session/start',
  at: Date.now(),
  sessionId: sessionName,
  provider: defaultProvider,
  model: defaultModel,
  cwd: process.cwd(),
})
context.setLog(sessionLog)
```

`index.tsx:339-355` resume 块改为（`SessionStore.load(options.resume)` → `loadLog` + `restoreLog`）：

```ts
if (options.resume) {
  const log = SessionStore.loadLog(options.resume)
  const events = log.events()
  if (events.length > 0) {
    const start = events.find((e) => e.type === 'session/start') as
      { type: 'session/start'; cwd?: string } | undefined
    if (start?.cwd && existsSync(start.cwd)) {
      try {
        process.chdir(start.cwd)
      } catch {
        /* cwd 可能已不存在 */
      }
    }
    context.restoreLog(log)
    context.setSystemPrompt(instructions.buildSystemPrompt(config.permission as string))
  }
}
```

`index.tsx:564` 会话结束保存改为：

```ts
if (context.getMessageCount() > 0) {
  const log = context.getLog()
  if (log) {
    SessionStore.saveLog(sessionName, log, {
      provider: defaultProvider,
      model: defaultModel,
      cwd: process.cwd(),
    })
  } else {
    SessionStore.save(sessionName, context.getMessages(), {
      provider: defaultProvider,
      model: defaultModel,
      cwd: process.cwd(),
    })
  }
}
```

`commands.ts` `/cd` 保存处（约 :2843）同步改为 saveLog（best-effort，`ctx.engine.getContext().getLog()` 可用时）：

```ts
const log = ctx.engine.getContext().getLog()
if (log) {
  SessionStore.saveLog(ctx.sessionId, log, {
    provider: saved.metadata.provider,
    model: saved.metadata.model,
    cwd: resolved,
  })
} else {
  SessionStore.save(ctx.sessionId, saved.messages, {
    provider: saved.metadata.provider,
    model: saved.metadata.model,
    cwd: resolved,
  })
}
```

> 注：`commands.ts` 内 `ctx.engine.getContext()` 需确认可访问（commands 已有 `ctx.engine.getContext().getMessages()` 用法，见 grep，可安全取 log）。若 `saved` 为 null（无旧会话）则跳过。

- [ ] **Step 5: typecheck + 全量测试 + commit**

Run: `cd apps/cli && pnpm typecheck` → 0 errors
Run: `cd apps/cli && pnpm test` → 全绿
Commit: `git add -A && git commit -m "feat(cli): wire real sessionId persistence via saveLog/restoreLog"`

---

## Self-Review

**Spec coverage**（§4.1 持久化翻转）：`save→append`（Task 2 saveLog）、`load→derive`（Task 3）、旧格式回退（Task 3 fallback）、真实 sessionId（Task 5）、resume 不重复写通（Task 5 restoreLog）。路径穿越修复（Task 1 sanitizeSessionName）超出 spec 但为 M1 遗留安全 bug，一并修。

**Placeholder scan**：无 TBD/TODO；每 Step 含实际代码。

**Type consistency**：`saveLog(name, log, meta?)`、`loadLog(name)`、`restoreLog(log)`、`sanitizeSessionName(name)` 在各 Task 一致；`session/start` 新增 `provider?/model?/cwd?` 在 Task 1/2/3/5 一致。

**Explicit deferrals（M1c）**：`assertModelVisible` 运行时 debug 门控接线、`compaction/summary` 流位置记录、`tool/result` 升级 `result:ToolResult`（success/error）、`assistant/chunk` 流级 replay。
