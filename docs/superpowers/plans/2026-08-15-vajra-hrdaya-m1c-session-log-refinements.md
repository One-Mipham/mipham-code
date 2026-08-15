# Vajra-Hṛdaya M1c — Session-Log 收尾 Refinements 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 `SessionLog` 相对 spec §4.2/§4.3 的四处收尾 gap——运行时断言门控、compaction 流位置、`tool/result` 全量 `ToolResult`、`assistant/chunk` 流级回放——让「存源流、派投影」闭环。

**Architecture:** `SessionLog`（append-only JSONL）已是唯一源流；本轮只改「事件形状 + 编解码 + 运行时接线」，不引入新子系统。`tool/result` 与 `compaction/summary` 两个事件从「投影降级」升级为「源流保真」，`assistant/chunk` 新增流级事件。全部改动对旧 JSONL 事件 lenient 向后兼容。

**Tech Stack:** TypeScript 5.5+ strict（ESM）、Bun/Node 22+、Vitest 3。

**Spec:** `docs/superpowers/specs/2026-08-15-vajra-hrdaya-kernel-design.md`（§4.1「存源流、派投影」、§4.2 SessionEvent 流、§4.3「Model-visible means logged」不变量）

## Global Constraints

- TS strict + ESM；测试框架 Vitest 3；运行时 Bun/Node 22+。
- 测试命令：`cd apps/cli && pnpm test`（vitest run）；类型检查：`cd apps/cli && pnpm typecheck`（tsc --noEmit）。
- 提交遵循 Conventional Commits（`feat:`/`fix:`/`test:`）；不自动 commit，等本轮全绿后统一提交。
- SessionLog 是 append-only JSONL（`~/.mipham/sessions/<name>.jsonl`）；事件视为不可变。
- 「绿前绿后」：每个 Task 改完，`pnpm test` 全量通过 + `pnpm typecheck` 零错误才提交。
- 内核代码（`core/session-log.ts`、`core/context.ts`）沿用现有中文注释风格。
- **不硬编码凭据/密钥**；**不改 provider 序列化契约**（`ToolResultContent` 不扩字段——success/error 走 `tool/result` 事件的 `result` 字段，不污染发给 provider 的 message 形状）。
- **旧 JSONL 向后兼容**：`deriveMessages` 对旧事件（`tool/result` 存 `content:string`、`compaction/summary` 无 `replacedCount`）lenient 处理，不得 crash。

---

## Task 1: assertModelVisible 运行时 debug 门控接线

**Files:**

- Modify: `apps/cli/src/core/session-log.ts`（新增门控函数 + 更新 §注释）
- Modify: `apps/cli/src/core/context.ts`（addMessage/seedMessages 写通后接线）
- Test: `apps/cli/test/core/session-log.test.ts`（门控开关测试）
- Test: `apps/cli/test/core/context.test.ts`（运行时接线测试）

**Interfaces:**

- Produces: `setAssertModelVisibleDebug(enabled: boolean): void`、`isAssertModelVisibleDebug(): boolean`（session-log.ts 导出）。

- [ ] **Step 1: 写失败测试**

`apps/cli/test/core/session-log.test.ts` 顶部 import 增加 `setAssertModelVisibleDebug, isAssertModelVisibleDebug`；文件末尾新增 describe：

```ts
describe('assertModelVisible debug gating', () => {
  afterEach(() => setAssertModelVisibleDebug(false))

  it('defaults to off', () => {
    expect(isAssertModelVisibleDebug()).toBe(false)
  })

  it('toggles on and off', () => {
    setAssertModelVisibleDebug(true)
    expect(isAssertModelVisibleDebug()).toBe(true)
    setAssertModelVisibleDebug(false)
    expect(isAssertModelVisibleDebug()).toBe(false)
  })
})
```

`apps/cli/test/core/context.test.ts` 在 `describe('ContextManager log integration')` 内新增：

```ts
it('addMessage does not throw when invariant holds (debug on)', () => {
  setAssertModelVisibleDebug(true)
  const cm = new ContextManager({ maxTokens: 100000, compactionThreshold: 0.9 })
  const log = new SessionLog('assert-debug-test')
  cm.setLog(log)
  expect(() => {
    cm.addMessage({ role: 'user', content: 'hi' })
    cm.addMessage({ role: 'assistant', content: 'hello' })
  }).not.toThrow()
})

it('throws when messages diverge from log (debug on)', () => {
  setAssertModelVisibleDebug(true)
  const cm = new ContextManager({ maxTokens: 100000, compactionThreshold: 0.9 })
  const log = new SessionLog('assert-debug-throw-test')
  cm.setLog(log)
  cm.addMessage({ role: 'user', content: 'logged' })
  cm.replaceMessages([{ role: 'user', content: 'NOT-LOGGED' }]) // 绕过日志写通
  expect(() => cm.addMessage({ role: 'user', content: 'trigger' })).toThrow(/not logged/)
})
```

context.test.ts 需在文件顶部 import 补 `setAssertModelVisibleDebug`（from `../../src/core/session-log`，现已有该 import 行，追加即可）。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/cli && pnpm test session-log context`
Expected: FAIL——`setAssertModelVisibleDebug`/`isAssertModelVisibleDebug` 未定义。

- [ ] **Step 3: 最小实现**

`apps/cli/src/core/session-log.ts`：在 `assertModelVisible` 函数后（约 line 160 之后）新增：

```ts
// ── 运行时断言门控 ──
let debugAssertModelVisible = false

/** 开启/关闭运行时「model-visible means logged」断言（默认关闭；hot-path 成本）。 */
export function setAssertModelVisibleDebug(enabled: boolean): void {
  debugAssertModelVisible = enabled
}

/** 运行时断言当前是否开启。 */
export function isAssertModelVisibleDebug(): boolean {
  return debugAssertModelVisible
}
```

同时把 `assertModelVisible` 上方的 JSDoc 注释（line 148-149）末尾的「运行时 hot-path 接线（debug 门控）推迟到 M1b」删除，改为「运行时接线见 ContextManager（debug 门控，默认关闭）」。

`apps/cli/src/core/context.ts`：

- line 7 import 改为：`import { SessionLog, messageToEvents, deriveMessages, assertModelVisible, isAssertModelVisibleDebug } from './session-log'`
- `addMessage`（line 134-136 写通之后、`this.checkCompression()` 之前）插入：

```ts
if (this.log && isAssertModelVisibleDebug()) {
  assertModelVisible(this.log.events(), this.messages)
}
```

- `seedMessages`（line 153 `this.reEstimateTokens()` 之后）插入同样的两行断言：

```ts
if (this.log && isAssertModelVisibleDebug()) {
  assertModelVisible(this.log.events(), this.messages)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/cli && pnpm test session-log context`
Expected: PASS（新增 4 测试绿；既有 context/session-log 测试零回归）。

- [ ] **Step 5: 提交**

```bash
git add apps/cli/src/core/session-log.ts apps/cli/src/core/context.ts apps/cli/test/core/session-log.test.ts apps/cli/test/core/context.test.ts
git commit -m "feat(session-log): wire assertModelVisible runtime assertion behind debug gate"
```

---

## Task 2: compaction/summary 流位置记录（replacedCount）

**Files:**

- Modify: `apps/cli/src/core/session-log.ts`（事件加 `replacedCount` + deriveMessages 位置投影）
- Modify: `apps/cli/src/core/context.ts`（compact 记录 replacedCount）
- Test: `apps/cli/test/core/session-log.test.ts`、`apps/cli/test/core/context.test.ts`

**Interfaces:**

- Produces: `compaction/summary` 事件形状变为 `{ type: 'compaction/summary'; at: number; summary: string; replacedCount: number }`（`replacedCount` = 被摘要替换掉的前缀消息数 = `toDrop.length`）。

- [ ] **Step 1: 写失败测试**

`session-log.test.ts` 新增 describe：

```ts
describe('compaction/summary stream position', () => {
  it('replaces the dropped prefix with the summary at its position', () => {
    const events: SessionEvent[] = [
      { type: 'user/message', at: 1, message: { role: 'user', content: 'm1' } },
      { type: 'assistant/message', at: 2, message: { role: 'assistant', content: 'm2' } },
      { type: 'user/message', at: 3, message: { role: 'user', content: 'm3' } },
      { type: 'assistant/message', at: 4, message: { role: 'assistant', content: 'm4' } },
      { type: 'compaction/summary', at: 5, summary: 'S', replacedCount: 3 },
    ]
    expect(deriveMessages(events)).toEqual([
      { role: 'user', content: '[Earlier conversation summary]: S' },
      { role: 'assistant', content: 'm4' },
    ])
  })

  it('old summary events (no replacedCount) still append at end', () => {
    const events = [
      { type: 'user/message', at: 1, message: { role: 'user', content: 'm1' } },
      { type: 'compaction/summary', at: 2, summary: 'S' },
    ] as unknown as SessionEvent[] // 模拟旧 JSONL 解析（无 replacedCount）
    expect(deriveMessages(events)).toEqual([
      { role: 'user', content: 'm1' },
      { role: 'user', content: '[Earlier conversation summary]: S' },
    ])
  })
})
```

`context.test.ts` 的 `describe('ContextManager log integration')` 内新增：

```ts
it('compact records replacedCount and deriveMessages reproduces post-compaction projection', async () => {
  const cm = new ContextManager({ maxTokens: 100000, compactionThreshold: 0.9 })
  const log = new SessionLog('compact-position-test')
  cm.setLog(log)
  cm.setSummarizer(async () => 'summarized content')
  for (let i = 0; i < 31; i++) {
    cm.addMessage({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg${i}` })
  }
  await cm.compact('test')
  const derived = deriveMessages(log.events())
  expect(derived[0]).toEqual({
    role: 'user',
    content: '[Earlier conversation summary]: summarized content',
  })
  expect(derived).toHaveLength(21) // 1 摘要 + 20 保留
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/cli && pnpm test session-log context`
Expected: FAIL——事件字面量 `{ type: 'compaction/summary', at, summary, replacedCount }` 类型不匹配（replacedCount 尚不在类型里）。

- [ ] **Step 3: 最小实现**

`apps/cli/src/core/session-log.ts`：

- line 21 事件形状改为：

```ts
  | { type: 'compaction/summary'; at: number; summary: string; replacedCount: number }
```

- `deriveMessages` 的 `compaction/summary` 分支（line 70-71）改为：

```ts
    } else if (e.type === 'compaction/summary') {
      // replacedCount = 被摘要替换的前缀消息数；旧 JSONL 无此字段则退回「追加末尾」
      const n = (e as { replacedCount?: number }).replacedCount ?? 0
      if (n > 0) {
        out.splice(0, n)
        out.unshift({ role: 'user', content: `[Earlier conversation summary]: ${e.summary}` })
      } else {
        out.push({ role: 'user', content: `[Earlier conversation summary]: ${e.summary}` })
      }
    }
```

`apps/cli/src/core/context.ts` line 184 改为：

```ts
if (this.log)
  this.log.append({
    type: 'compaction/summary',
    at: Date.now(),
    summary,
    replacedCount: toDrop.length,
  })
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/cli && pnpm test session-log context`
Expected: PASS（新增 3 测试绿；`assertModelVisible` 的摘要豁免仍生效）。

- [ ] **Step 5: 提交**

```bash
git add apps/cli/src/core/session-log.ts apps/cli/src/core/context.ts apps/cli/test/core/session-log.test.ts apps/cli/test/core/context.test.ts
git commit -m "feat(session-log): record compaction summary stream position (replacedCount)"
```

---

## Task 3: tool/result 升级 result:ToolResult

**Files:**

- Modify: `apps/cli/src/core/session-log.ts`（事件形状 + messageToEvents/deriveMessages）
- Modify: `apps/cli/src/core/context.ts`（新增 addToolResult）
- Modify: `apps/cli/src/core/engine.ts`（工具结果走 addToolResult）
- Test: `apps/cli/test/core/session-log.test.ts`、`apps/cli/test/core/context.test.ts`

**Interfaces:**

- Produces: `ContextManager.addToolResult(toolUseId: string, result: ToolResult): void`。
- `ToolResult`（`../shared/types`）：`{ success: boolean; content: string; error?: string }`。
- 投影内容规则（与 engine 现状 line 610 一致）：`success ? content : (error || content)`。

- [ ] **Step 1: 写失败测试**

`session-log.test.ts` 新增 describe：

```ts
describe('tool/result carries full ToolResult', () => {
  it('messageToEvents derives success:true best-effort from a tool_result block', () => {
    const m: Message = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'body' }],
    }
    expect(deriveMessages(messageToEvents(m))).toEqual([m])
  })

  it('deriveMessages reproduces error content for a failed tool', () => {
    const events: SessionEvent[] = [
      {
        type: 'tool/result',
        at: 1,
        id: 't1',
        result: { success: false, content: 'partial', error: 'boom' },
      },
    ]
    expect(deriveMessages(events)).toEqual([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom' }] },
    ])
  })

  it('deriveMessages reproduces content for a successful tool', () => {
    const events: SessionEvent[] = [
      { type: 'tool/result', at: 1, id: 't1', result: { success: true, content: 'ok' } },
    ]
    expect(deriveMessages(events)).toEqual([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ])
  })

  it('backward-compat: old tool/result with content:string still derives', () => {
    const events = [
      { type: 'tool/result', at: 1, id: 't1', content: 'legacy' },
    ] as unknown as SessionEvent[]
    expect(deriveMessages(events)).toEqual([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'legacy' }] },
    ])
  })
})
```

`context.test.ts` 的 `describe('ContextManager log integration')` 内新增：

```ts
it('addToolResult records full result and derives projection', () => {
  const cm = new ContextManager({ maxTokens: 100000, compactionThreshold: 0.9 })
  const log = new SessionLog('tool-result-test')
  cm.setLog(log)
  cm.addToolResult('t1', { success: false, content: 'partial', error: 'boom' })
  expect(cm.getMessages()).toEqual([
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom' }] },
  ])
  const raw = log.events().find((e) => e.type === 'tool/result')
  expect(raw).toMatchObject({ id: 't1', result: { success: false, error: 'boom' } })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/cli && pnpm test session-log context`
Expected: FAIL——`tool/result` 事件类型无 `result` 字段，`addToolResult` 未定义。

- [ ] **Step 3: 最小实现**

`apps/cli/src/core/session-log.ts`：

- line 4 import 追加 `ToolResult`：`import type { Message, ToolUseContent, ToolResultContent, ToolResult } from '../shared/types'`
- line 19 事件形状改为：

```ts
  | { type: 'tool/result'; at: number; id: string; result: ToolResult }
```

- `messageToEvents` 的 tool_result 拆分（line 28-31）改为：

```ts
if (results.length === 1 && results.length === msg.content.length) {
  const r = results[0]!
  return [
    { type: 'tool/result', at, id: r.tool_use_id, result: { success: true, content: r.content } },
  ]
}
```

- `deriveMessages` 的 `tool/result` 分支（line 63-67）改为：

```ts
    } else if (e.type === 'tool/result') {
      // 兼容旧 JSONL（存 content:string）；新格式存 result:ToolResult（含 success/error）
      const eo = e as unknown as { id: string; result?: ToolResult; content?: string }
      const result: ToolResult = eo.result ?? { success: true, content: eo.content ?? '' }
      const content = result.success ? result.content : result.error || result.content
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: e.id, content }],
      })
    }
```

`apps/cli/src/core/context.ts`：

- line 1 import 改为：`import type { Message, ToolResult } from '../shared/index.ts'`
- 在 `addMessage` 之后（line 140 之后）新增方法：

```ts
  /** 记录工具执行结果（全量 ToolResult 含 success/error）到日志，并写投影消息（不重复走 messageToEvents 拆分）。 */
  addToolResult(toolUseId: string, result: ToolResult): void {
    const content = result.success ? result.content : result.error || result.content
    const msg: Message = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
    }
    this.messages.push(msg)
    this.estimatedTokens += this.estimateTokens(JSON.stringify(msg.content))
    if (this.log) this.log.append({ type: 'tool/result', at: Date.now(), id: toolUseId, result })
    this.checkCompression()
  }
```

`apps/cli/src/core/engine.ts`：把工具结果写投影的两段 `context.addMessage({ role:'user', content:[{type:'tool_result',...}] })` 替换为 `context.addToolResult(toolUse.id, result)`。共两处：主循环 line 604-613、以及 sub-agent/other 路径的同类 `addMessage`（若存在，仅替换「工具结果 user 消息」那一段，不动 assistant tool_use 消息）。改动后原 `result.success ? result.content : result.error || result.content` 表达式由 `addToolResult` 内部统一处理。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/cli && pnpm test session-log context engine`（如 engine 测试文件存在）
Expected: PASS；随后 `cd apps/cli && pnpm typecheck` 零错误。

- [ ] **Step 5: 提交**

```bash
git add apps/cli/src/core/session-log.ts apps/cli/src/core/context.ts apps/cli/src/core/engine.ts apps/cli/test/core/session-log.test.ts apps/cli/test/core/context.test.ts
git commit -m "feat(session-log): upgrade tool/result event to full ToolResult (success/error)"
```

---

## Task 4: assistant/chunk 流级 replay

**Files:**

- Modify: `apps/cli/src/core/session-log.ts`（事件类型 + deriveMessages 跳过 + replayChunks）
- Modify: `apps/cli/src/core/context.ts`（新增 recordChunk）
- Modify: `apps/cli/src/core/engine.ts`（流循环记录 text chunk）
- Test: `apps/cli/test/core/session-log.test.ts`、`apps/cli/test/core/context.test.ts`

**Interfaces:**

- Produces: `ContextManager.recordChunk(chunk: string): void`；`replayChunks(log: SessionLog): string[]`。

- [ ] **Step 1: 写失败测试**

`session-log.test.ts` 新增 describe（顶部 import 追加 `replayChunks`）：

```ts
describe('assistant/chunk stream replay', () => {
  it('replayChunks extracts raw chunk strings in order', () => {
    const log = new SessionLog('chunk-test')
    log.append({ type: 'assistant/chunk', at: 1, chunk: 'Hel' })
    log.append({ type: 'assistant/chunk', at: 2, chunk: 'lo ' })
    log.append({ type: 'assistant/chunk', at: 3, chunk: 'world' })
    log.append({
      type: 'assistant/message',
      at: 4,
      message: { role: 'assistant', content: 'Hello world' },
    })
    expect(replayChunks(log)).toEqual(['Hel', 'lo ', 'world'])
  })

  it('deriveMessages ignores chunks (message comes from assistant/message)', () => {
    const events: SessionEvent[] = [
      { type: 'assistant/chunk', at: 1, chunk: 'Hel' },
      { type: 'assistant/chunk', at: 2, chunk: 'lo' },
      { type: 'assistant/message', at: 3, message: { role: 'assistant', content: 'Hello' } },
    ]
    expect(deriveMessages(events)).toEqual([{ role: 'assistant', content: 'Hello' }])
  })
})
```

`context.test.ts` 的 `describe('ContextManager log integration')` 内新增：

```ts
it('recordChunk appends chunks to log but not to projection', () => {
  const cm = new ContextManager({ maxTokens: 100000, compactionThreshold: 0.9 })
  const log = new SessionLog('chunk-ctx-test')
  cm.setLog(log)
  cm.recordChunk('Hel')
  cm.recordChunk('lo')
  expect(cm.getMessages()).toEqual([])
  expect(log.events().filter((e) => e.type === 'assistant/chunk')).toHaveLength(2)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/cli && pnpm test session-log context`
Expected: FAIL——`assistant/chunk` 事件类型不存在、`replayChunks`/`recordChunk` 未定义。

- [ ] **Step 3: 最小实现**

`apps/cli/src/core/session-log.ts`：

- 事件联合（line 18 后）新增：

```ts
  | { type: 'assistant/chunk'; at: number; chunk: string }
```

- `deriveMessages` 新增分支（放在 `assistant/message` 分支后）：

```ts
    } else if (e.type === 'assistant/chunk') {
      // 无消息：原始块由 assistant/message 汇总，chunk 仅供 replayChunks 流级回放
    }
```

- 文件末尾新增：

```ts
/** replay：从日志抽取原始 assistant 流块（保 replay 保真）。 */
export function replayChunks(log: SessionLog): string[] {
  return log
    .events()
    .filter(
      (e): e is Extract<SessionEvent, { type: 'assistant/chunk' }> => e.type === 'assistant/chunk',
    )
    .map((e) => e.chunk)
}
```

- 删除文件顶部 line 6 的整条 `// M1b 待对齐：…` 注释（本 Task 完成四处收尾后已过时）。

`apps/cli/src/core/context.ts`：在 `addToolResult` 之后新增：

```ts
  /** 记录原始 assistant 流块（保 replay 保真）；不写入投影 messages。 */
  recordChunk(chunk: string): void {
    if (this.log) this.log.append({ type: 'assistant/chunk', at: Date.now(), chunk })
  }
```

`apps/cli/src/core/engine.ts`：流循环 line 487-489 的 text 分支改为：

```ts
if (chunk.type === 'text' && chunk.content) {
  assistantContent += chunk.content
  this.context.recordChunk(chunk.content)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/cli && pnpm test session-log context`，再 `cd apps/cli && pnpm typecheck`
Expected: PASS + 零 typecheck 错误。

- [ ] **Step 5: 提交**

```bash
git add apps/cli/src/core/session-log.ts apps/cli/src/core/context.ts apps/cli/src/core/engine.ts apps/cli/test/core/session-log.test.ts apps/cli/test/core/context.test.ts
git commit -m "feat(session-log): add assistant/chunk stream-level replay (recordChunk + replayChunks)"
```

---

## Self-Review

**Spec coverage（对照 spec §4.2/§4.3/§4.1）：**

- §4.2 `tool/result` 含 `result: ToolResult` → Task 3 ✅
- §4.2 `assistant/chunk` 原始块保 replay 保真 → Task 4 ✅
- §4.3 运行时 fail-loud 断言 → Task 1 ✅
- §4.1「存源流、派投影」压缩变投影 → Task 2（`replacedCount` 让 `deriveMessages` 派 post-compaction 投影）✅
- `system-prompt/section`（spec §4.2 末项）**不在本轮**——system prompt 走独立通道，留待 M2c/M3（已在上游 M1 决策明确）。

**Placeholder scan：** 无 TBD/TODO；每个 Step 含可执行代码与确切命令。

**Type consistency：** `addToolResult`/`recordChunk`/`replayChunks`/`setAssertModelVisibleDebug`/`isAssertModelVisibleDebug` 命名贯穿各 Task 一致；`ToolResult` 从 `../shared/types` 与 `../shared/index.ts` 双入口导入（`shared/index.ts` re-export types，二者等价）。
