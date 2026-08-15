# Vajra-Hṛdaya M2b — LLM 适配缝（ctx.llm）+ llm-replay 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 engine 的 LLM chat 调用从具体 `ProviderRegistry` 解耦为 Vajra 能力缝 `ctx.llm`（Definition/Provider/Consumer），并交付 `llm-replay` 回放器——「换 provider = 换 chat 实现，engine 零 fork 跟随」。

**Architecture:** 缝只升 **chat 能力**（`Llm` 接口），元数据/路由（`getActiveModel`/`switchProvider`/`findModel`/`getDefaultProviderId`）仍留在 `ProviderRegistry`。`ProviderRegistry` 结构上已满足 `Llm`（有 `chat`）；`llm-replay` 提供另一个 `Llm`（record/replay）。engine 注入 `Llm`（`setLlm` + 私有 `llmChat` helper），默认回退 `this.registry`（strangler-fig，生产接线留待真需）。

**Tech Stack:** Bun 1.2+ / TypeScript 5.5+ strict / Vitest 3（globals:true）/ pnpm / Vajra-Hṛdaya 内核（M0 `apps/cli/src/vajra/`，M2 工具缝已落地）

**Spec:** docs/superpowers/specs/2026-08-15-vajra-hrdaya-kernel-design.md（§五 能力缝、§7.4 M2：`ProviderRegistry` → LLM 适配缝 → `ctx.llm`）

## Global Constraints

- TypeScript strict；无分号；`noUncheckedIndexedAccess: true`（索引访问返回 `T | undefined`，必须判空）
- 测试框架 Vitest 3，`globals: true`；测试镜像 src 放在 `apps/cli/test/` 下同结构
- 包管理 pnpm；提交信息遵循 Conventional Commits
- lint/format 在 **仓库根目录**（`pnpm lint` / `pnpm format`），不是 `apps/cli`
- **测试/typecheck 命令约定**：所有 `pnpm test` / `pnpm typecheck` 在 `apps/cli` 目录执行（`pnpm test [path]` 等价 `vitest run [path]`）
- engine 的 `ChatRequest` 类型从 `../providers/registry` 导入；`StreamChunk` 从 `../shared` 导入
- 缝只升 chat；**不得**改动 `getActiveModel`/`switchProvider`/`findModel`/`getDefaultProviderId` 的语义或调用点（它们仍走 `this.registry`）

---

### Task 1: LLM 缝定义 `src/providers/llm.ts`

**Files:**

- Create: `apps/cli/src/providers/llm.ts`
- Test: `apps/cli/test/providers/llm.test.ts`

**Interfaces:**

- Produces: `Llm`（接口，`chat(req: ChatRequest): AsyncGenerator<StreamChunk>`）、`LLM_KEY = 'llm'`、`mountLlm(ctx: Context, llm: Llm): Disposer`（`ctx.provide(LLM_KEY, llm)`）
- Consumes: `Context`/`Disposer`（`../vajra`）、`ChatRequest`（`./registry`）、`StreamChunk`（`../shared`）

- [ ] **Step 1: Write the failing test**

新建 `apps/cli/test/providers/llm.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { Context } from '../../src/vajra'
import type { Llm } from '../../src/providers/llm'
import { LLM_KEY, mountLlm } from '../../src/providers/llm'

function fakeLlm(): Llm {
  return {
    chat: async function* () {
      yield { type: 'stop' as const }
    },
  }
}

describe('llm seam', () => {
  it('mounts under ctx.llm and retrieves it', () => {
    const ctx = new Context()
    const llm = fakeLlm()
    const dispose = mountLlm(ctx, llm)
    expect(ctx.get(LLM_KEY)).toBe(llm)
    expect(ctx.get('llm')).toBe(llm)
    dispose()
    expect(ctx.get('llm')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/providers/llm.test.ts`
Expected: FAIL — `Cannot find module '../../src/providers/llm'`

- [ ] **Step 3: Write minimal implementation**

新建 `apps/cli/src/providers/llm.ts`：

```ts
import type { Context, Disposer } from '../vajra'
import type { ChatRequest } from './registry'
import type { StreamChunk } from '../shared'

/** LLM 适配缝的 capability —— chat 能力。换 provider = 换 chat 实现，engine 零 fork 跟随。 */
export interface Llm {
  chat(req: ChatRequest): AsyncGenerator<StreamChunk>
}

/** 缝键：ctx.llm。 */
export const LLM_KEY = 'llm'

/** 把一个 Llm（如 ProviderRegistry 或 llm-replay）挂载为 ctx.llm。 */
export function mountLlm(ctx: Context, llm: Llm): Disposer {
  return ctx.provide(LLM_KEY, llm)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/providers/llm.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/providers/llm.ts apps/cli/test/providers/llm.test.ts
git commit -m "feat(providers): add Llm seam definition (ctx.llm)"
```

---

### Task 2: engine 注入 Llm 缝（setLlm + llmChat）

**Files:**

- Modify: `apps/cli/src/core/engine.ts`
- Test: `apps/cli/test/core/engine.test.ts`（新增用例，复用现有 `mockProviderRegistry`）

**Interfaces:**

- Produces: `QueryEngine.setLlm(llm: Llm): void`、私有 `llmChat(req: ChatRequest): AsyncGenerator<StreamChunk>`（`yield* (this.llm ?? this.registry).chat(req)`）
- Consumes: `Llm`（`../providers/llm`）、`ChatRequest`（`../providers/registry`，如未导入需补 `import type`）
- **改动点**：engine 5 处 `this.registry.chat({...})` → `this.llmChat({...})`（仅换调用对象，参数对象字面量不变）

- [ ] **Step 1: Write the failing test**

在 `apps/cli/test/core/engine.test.ts` 的 `describe('process — basic conversation')`（或 `describe('QueryEngine')` 内）新增：

```ts
it('routes chat through the injected Llm seam when setLlm is called', async () => {
  const registry = mockProviderRegistry(async function* () {
    yield { type: 'text', content: 'from-registry' }
    yield { type: 'stop' }
  })
  const engine = new QueryEngine(registry, mockContext(), makeToolMap([]))

  engine.setLlm({
    chat: async function* () {
      yield { type: 'text', content: 'from-seam' }
      yield { type: 'stop' }
    },
  })

  const chunks: StreamChunk[] = []
  for await (const chunk of engine.process('hi')) {
    chunks.push(chunk)
  }

  expect(chunks.some((c) => c.type === 'text' && c.content === 'from-seam')).toBe(true)
  expect(chunks.some((c) => c.type === 'text' && c.content === 'from-registry')).toBe(false)
})
```

（`StreamChunk` 已在 engine.test.ts 顶部 import；`setLlm` 尚不存在。）

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/core/engine.test.ts`
Expected: FAIL — `Property 'setLlm' does not exist on type 'QueryEngine'`

- [ ] **Step 3: Write minimal implementation**

在 `apps/cli/src/core/engine.ts`：

1. 顶部 import 补（如 `ChatRequest` 未导入）：

```ts
import type { Llm } from '../providers/llm'
import type { ChatRequest } from '../providers/registry'
```

2. 在类内新增字段（放在 `private registry: ProviderRegistry` 附近）：

```ts
  /** 注入的 LLM chat 缝。未设置时回退 this.registry（strangler-fig）。 */
  private llm?: Llm
```

3. 新增 setter 与 helper（放在 `getRegistry()` 附近）：

```ts
  /** 注入 LLM 适配缝（换 chat 实现）。 */
  setLlm(llm: Llm): void {
    this.llm = llm
  }

  /** 统一 chat 出口：优先走注入的 Llm 缝，否则回退 registry。 */
  private async *llmChat(req: ChatRequest): AsyncGenerator<StreamChunk> {
    yield* (this.llm ?? this.registry).chat(req)
  }
```

4. 将 5 处 `this.registry.chat({` 改为 `this.llmChat({`（对象字面量参数不变）。5 处位于：
   - 摘要（约 366 行，`setupContextSummarizer` 内）
   - 主循环（约 796 行）
   - 约 877 行
   - `chatWithFallback` attempt 1（约 1189 行）
   - `chatWithFallback` fallback（约 1228 行）

   > 注意：`chatWithFallback` 中 `this.registry.getActive()`/`getDefaultProviderId()`/`switchProvider()`/`get(defaultId)` 等元数据/路由调用**保持不变**，只改 `chat` 那两处。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/core/engine.test.ts`
Expected: PASS（既有用例 + 新增 seam 用例）

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/engine.ts apps/cli/test/core/engine.test.ts
git commit -m "feat(engine): inject Llm chat seam (setLlm + llmChat), default to registry"
```

---

### Task 3: llm-replay 回放器 `src/providers/llm-replay.ts`

**Files:**

- Create: `apps/cli/src/providers/llm-replay.ts`
- Test: `apps/cli/test/providers/llm-replay.test.ts`

**Interfaces:**

- Produces: `RecordedTurn { req: ChatRequest; chunks: StreamChunk[] }`、`recordLlm(inner: Llm): { llm: Llm; turns: RecordedTurn[] }`、`replayLlm(turns: RecordedTurn[]): Llm`
- Consumes: `Llm`（`./llm`）、`ChatRequest`（`./registry`）、`StreamChunk`（`../shared`）

- [ ] **Step 1: Write the failing test**

新建 `apps/cli/test/providers/llm-replay.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import type { StreamChunk } from '../../src/shared'
import { recordLlm, replayLlm } from '../../src/providers/llm-replay'

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const c of gen) out.push(c)
  return out
}

describe('llm-replay', () => {
  it('records then replays deterministically (no network)', async () => {
    const { llm, turns } = recordLlm({
      chat: async function* () {
        yield { type: 'text', content: 'A' }
        yield { type: 'stop' }
      },
    })

    const recorded = await collect(llm.chat({ model: 'm', messages: [] }))
    expect(turns).toHaveLength(1)
    expect(turns[0]!.chunks).toEqual(recorded)

    const replay = replayLlm(turns)
    const replayed = await collect(replay.chat({ model: 'x', messages: [] }))
    expect(replayed).toEqual(recorded)
  })

  it('replay exhausts quietly when out of turns', async () => {
    const replay = replayLlm([])
    const out = await collect(replay.chat({ model: 'm', messages: [] }))
    expect(out).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/providers/llm-replay.test.ts`
Expected: FAIL — `Cannot find module '../../src/providers/llm-replay'`

- [ ] **Step 3: Write minimal implementation**

新建 `apps/cli/src/providers/llm-replay.ts`：

```ts
import type { Llm } from './llm'
import type { ChatRequest } from './registry'
import type { StreamChunk } from '../shared'

export interface RecordedTurn {
  req: ChatRequest
  chunks: StreamChunk[]
}

/** 包装一个 Llm：委托的同时记录每轮 (req, chunks)。 */
export function recordLlm(inner: Llm): { llm: Llm; turns: RecordedTurn[] } {
  const turns: RecordedTurn[] = []
  const llm: Llm = {
    async *chat(req) {
      const chunks: StreamChunk[] = []
      for await (const chunk of inner.chat(req)) {
        chunks.push(chunk)
        yield chunk
      }
      turns.push({ req, chunks })
    },
  }
  return { llm, turns }
}

/** 回放已记录的 turns（确定性、无网络）。按顺序消费，超出则静默结束。 */
export function replayLlm(turns: RecordedTurn[]): Llm {
  let cursor = 0
  return {
    async *chat() {
      const turn = turns[cursor++]
      if (!turn) return
      for (const chunk of turn.chunks) yield chunk
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/providers/llm-replay.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/providers/llm-replay.ts apps/cli/test/providers/llm-replay.test.ts
git commit -m "feat(providers): add llm-replay recorder/replayer for provider-swap tests"
```

---

### Task 4: 「换实现」集成测试（Definition/Provider/Consumer 三角闭环）

**Files:**

- Test: `apps/cli/test/core/engine-llm-seam.test.ts`（新建，或并入 engine.test.ts）

**Interfaces:**

- Consumes: Task 1 `mountLlm`/`LLM_KEY`、Task 2 `setLlm`、Task 3 `recordLlm`/`replayLlm`、engine.test 的 `mockProviderRegistry`/`mockContext`/`makeToolMap`（如新建文件，需从 engine.test.ts 复制这三个 helper）

- [ ] **Step 1: Write the failing test**

新建 `apps/cli/test/core/engine-llm-seam.test.ts`（复制 engine.test.ts 顶部的 `mockProviderRegistry`/`mockContext`/`makeToolMap` 三个 helper + 相关 import）：

```ts
import { describe, it, expect } from 'vitest'
import type { StreamChunk } from '../../src/shared/index.ts'
import { QueryEngine } from '../../src/core/engine'
import { ContextManager } from '../../src/core/context'
import { Context } from '../../src/vajra'
import { mountLlm } from '../../src/providers/llm'
import { recordLlm, replayLlm } from '../../src/providers/llm-replay'

// ... 复制 mockProviderRegistry / mockContext / makeToolMap helper ...

describe('ctx.llm seam — 换实现（engine 零 fork 跟随）', () => {
  it('swapping ctx.llm to a replay makes the engine follow it', async () => {
    // 1. 录制一次「真实」chat
    const { llm: realLlm, turns } = recordLlm({
      chat: async function* () {
        yield { type: 'text', content: 'recorded-response' }
        yield { type: 'stop' }
      },
    })
    const recorded: StreamChunk[] = []
    for await (const c of realLlm.chat({ model: 'm', messages: [] })) recorded.push(c)
    expect(turns).toHaveLength(1)

    // 2. 把回放器挂到 ctx.llm（换实现）
    const ctx = new Context()
    mountLlm(ctx, replayLlm(turns))

    // 3. engine 注入该缝
    const engine = new QueryEngine(mockProviderRegistry(), mockContext(), makeToolMap([]))
    engine.setLlm(ctx.get('llm')!)

    // 4. engine 的 chat 走回放器，而非 registry 的 mock
    const chunks: StreamChunk[] = []
    for await (const chunk of engine.process('hi')) chunks.push(chunk)

    expect(chunks.some((c) => c.type === 'text' && c.content === 'recorded-response')).toBe(true)
    expect(chunks.some((c) => c.type === 'text' && c.content === 'Hello!')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/core/engine-llm-seam.test.ts`
Expected: 若并入 engine.test.ts 则 FAIL 于断言（`setLlm` 尚未接线会走 registry 返回 'Hello!'）；若新建文件则先 FAIL 于 helper 缺失 → 复制 helper 后 FAIL 于断言

- [ ] **Step 3: Verify implementation already satisfies it**

Task 2 已实现 `setLlm`；本任务无需改 src（纯集成测试），仅需让测试通过。

- [ ] **Step 4: Run test + full suite + typecheck**

Run: `pnpm test test/core/engine-llm-seam.test.ts`，再 `pnpm test`（全量）与 `pnpm typecheck`
Expected: 新增用例 PASS；全量 1372+ 通过 / 2 跳过 / 0 失败；typecheck 0 错

- [ ] **Step 5: Commit**

```bash
git add apps/cli/test/core/engine-llm-seam.test.ts
git commit -m "test(engine): prove ctx.llm provider-swap (llm-replay) — engine follows zero-fork"
```

---

## Self-Review

**Spec coverage（§五 + §7.4 M2）:**

- ✅ `ProviderRegistry` → LLM 适配缝 `ctx.llm`：Task 1（Definition）+ Task 2（Consumer：engine 注入 `Llm`）
- ✅ provider 换实现测试（llm-replay 替真 API）：Task 3（回放器）+ Task 4（换实现集成测试，engine 零 fork）
- ⏳ `ctx.skills`（技能缝）——推迟 M2c
- ⏳ 生产接线（index.tsx 提供 `ctx.llm`）——推迟：engine 默认回退 `this.registry`，缝是注入出口，留待真需（如「replay 模式」命令）

**Placeholder scan:** 无 TBD/TODO；每任务含具体代码与测试。

**Type consistency:** `Llm`/`LLM_KEY`/`mountLlm`（Task 1）由 Task 2/3/4 引用一致；`setLlm`/`llmChat`（Task 2）由 Task 4 消费；`recordLlm`/`replayLlm`（Task 3）由 Task 4 消费；`ChatRequest` 从 `./registry` 导入，`StreamChunk` 从 `../shared` 导入，全程一致。

**风险与回退：** strangler-fig——engine 默认 `this.llm ?? this.registry`，`setLlm` 未调用时行为与改前完全一致；元数据/路由（getActiveModel/switchProvider/findModel）零改动。5 处 chat 站点仅换调用对象，参数字面量不变。
