# Vajra-Hṛdaya M2c — ctx.skills 技能缝 + 漏缝接入 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收 M2 三缝的最后一缝——`ctx.skills`（技能加载缝），并接上 M2b 遗留的两处「漏缝」（self-critique / SubAgent 绕过 `ctx.llm` 直调 `registry.chat`/`provider.chat`）。

**Architecture:** 完全复刻 M2b `ctx.llm` 缝的形状——Definition（`Skills` 接口）+ Provider（`SkillsLoader implements Skills`）+ Consumer（engine `setSkills` + `skillsProvider ?? skillsLoader` 回退）。漏缝接入同样复刻 `llmChat` 的 strangler-fig：`(llm ?? registry).chat` 回退，默认不改行为。

**Tech Stack:** TypeScript 5.5+ strict（ESM）、Bun/Node 22+、Vitest 3。

**Spec:** `docs/superpowers/specs/2026-08-15-vajra-hrdaya-kernel-design.md`（§5 能力缝三角，M2 三缝映射表：`skills registry → 技能加载缝 ctx.skills`）

## Global Constraints

- TS strict + ESM；Vitest 3；运行时 Bun/Node 22+。
- 测试命令：`cd apps/cli && pnpm test`；typecheck：`cd apps/cli && pnpm typecheck`。
- 提交遵循 Conventional Commits；每个 Task 末尾 implementer 自行 commit（消息用 Step 原文）。
- 缝只升「能力」，不破坏现有 `SkillsLoader`/`ProviderRegistry` 的既有调用（strangler-fig，绿前绿后）。
- 元数据/路由（`getActiveModel`/`switchProvider`/`findModel`/`listModels`）仍留 `ProviderRegistry`（同 M2b 裁决）；缝只升 chat。
- 内核代码沿用中文注释风格；不硬编码凭据；不 dispatch 子代理（implementer）。
- `apps/cli/src/shared` 与 `@mipham/shared` 双份：改类型须同改两份（改 `ToolContext` 加 `llm` 字段时，两处都改）。

---

## Task 1: ctx.skills 技能缝（Skills 接口 + mountSkills + SkillsLoader implements Skills + engine setSkills）

**Files:**
- Create: `apps/cli/src/skills/seam.ts`
- Modify: `apps/cli/src/skills/loader.ts`（`class SkillsLoader implements Skills`）
- Modify: `apps/cli/src/core/engine.ts`（`setSkills` + `skillsProvider` 回退）
- Test: `apps/cli/test/core/engine.test.ts`（换 skills provider 不改 engine）

**Interfaces:**
- Produces: `Skills` 接口（`get`/`list`/`has`/`buildSystemReminder`）、`SKILLS_KEY = 'skills'`、`mountSkills(ctx, skills)`、`ContextManager` 无改动、`engine.setSkills(skills)`。

- [ ] **Step 1: 写失败测试**

`apps/cli/test/core/engine.test.ts` 新增（复用现有 mock registry/context 构造；断言换 skills provider 后 engine 注入的 ToolContext.skillsLoader 是替换后的实现）：

```ts
it('setSkills overrides the skills provider injected into tool context', () => {
  const fakeSkills = {
    get: () => undefined,
    list: () => [],
    has: () => false,
    buildSystemReminder: () => '',
  }
  engine.setSkills(fakeSkills)
  // 断言 engine 注入 ToolContext 的 skillsLoader === fakeSkills（经 setSkills 后回退失效）
  // 用 engine 的 getToolDefinitions / 执行一个 mock 工具读 ctx.skillsLoader 断言之（参考现有 engine.test.ts 如何捕获 tool ctx）
})
```

（具体断言方式依现有 engine.test.ts 的 mock 工具捕获 ctx 手法而定；核心是「换 provider 不改 engine 代码」。）

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/cli && pnpm test engine`
Expected: FAIL——`setSkills`/`seam` 未定义。

- [ ] **Step 3: 最小实现**

`apps/cli/src/skills/seam.ts`：

```ts
import type { Context, Disposer } from '../vajra'
import type { SkillDefinition } from '../shared'

/** 技能加载缝的 capability —— 读能力。换 provider = 换技能来源，engine 零 fork 跟随。 */
export interface Skills {
  get(name: string): SkillDefinition | undefined
  list(): SkillDefinition[]
  has(name: string): boolean
  buildSystemReminder(maxTokens?: number): string
}

/** 缝键：ctx.skills。 */
export const SKILLS_KEY = 'skills'

/** 把一个 Skills（如 SkillsLoader 或测试替身）挂载为 ctx.skills。 */
export function mountSkills(ctx: Context, skills: Skills): Disposer {
  return ctx.provide(SKILLS_KEY, skills)
}
```

`apps/cli/src/skills/loader.ts`：类声明改为 `export class SkillsLoader implements Skills`，顶部 `import type { Skills } from './seam'`。方法签名已满足（`get`/`list`/`has`/`buildSystemReminder`），无需改方法体。

`apps/cli/src/core/engine.ts`：
- 顶部 `import type { Skills } from '../skills/seam'`。
- 字段区（`private skillsLoader?: SkillsLoader` 旁）加 `private skillsProvider?: Skills`。
- `setSkillsLoader` 旁新增：

```ts
  /** 注入技能加载缝（ctx.skills）。未设置时回退 this.skillsLoader（strangler-fig）。 */
  setSkills(provider: Skills): void {
    this.skillsProvider = provider
  }
```

- line 1061 的 ToolContext 注入改为用回退后的 provider：

```ts
        skillsLoader: this.skillsProvider ?? this.skillsLoader,
```

（`skillsLoader` 字段类型是 `SkillsLoader`；`skillsProvider ?? skillsLoader` 结果类型为 `Skills`，ToolContext.skillsLoader 字段类型需收窄为 `Skills`——**改 `ToolContext.skillsLoader` 类型为 `Skills`**（`apps/cli/src/shared/types.ts` + `packages/shared/src/types.ts` 两处同步）。`SkillsLoader` 仍可赋值给 `Skills`（implements），既有代码不变。）

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/cli && pnpm test engine`，再 `cd apps/cli && pnpm test` 全量，最后 `cd apps/cli && pnpm typecheck`。

- [ ] **Step 5: 提交**

```bash
git add apps/cli/src/skills/seam.ts apps/cli/src/skills/loader.ts apps/cli/src/core/engine.ts apps/cli/src/shared/types.ts packages/shared/src/types.ts apps/cli/test/core/engine.test.ts
git commit -m "feat(skills): mount SkillsLoader as ctx.skills seam (Skills interface + engine setSkills)"
```

---

## Task 2: self-critique 漏缝接入（critique 走 llm 缝）

**Files:**
- Modify: `apps/cli/src/core/self-critique.ts`（`critique()` 加 `llm?` 参数）
- Modify: `apps/cli/src/core/engine.ts`（line 1035 调用传 `this.llm`）
- Test: `apps/cli/test/core/self-critique.test.ts`（存在则扩展；否则 engine.test.ts 内）

**Interfaces:**
- Produces: `SelfCritique.critique(name, params, registry, llm?)`；`llm` 缺省时回退 `registry.chat`。

- [ ] **Step 1: 写失败测试**

断言：传入一个 llm 替身（记录调用）时，`critique` 走替身而非 registry 的 chat。若 self-critique.test.ts 已存在则扩展之；否则在 engine.test.ts 内用 mock registry 验证「传 llm 时 registry.chat 不被调用」。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/cli && pnpm test self-critique engine`（视文件而定）
Expected: FAIL。

- [ ] **Step 3: 最小实现**

`apps/cli/src/core/self-critique.ts`：
- 顶部 `import type { Llm } from '../providers/llm'`。
- `critique` 签名：`async critique(toolName, params, registry: ProviderRegistry, llm?: Llm)`（`llm` 默认回退 registry）。
- line 147 改：`for await (const chunk of (llm ?? registry).chat({ ... }))`。

`apps/cli/src/core/engine.ts` line 1035 改：

```ts
      const critiqueResult = await selfCritique.critique(name, effectiveParams, this.registry, this.llm)
```

（`this.llm` 是 engine 的私有 Llm 字段，M2b 已加；未设置时为 undefined → self-critique 回退 registry，行为不变。）

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/cli && pnpm test`，`cd apps/cli && pnpm typecheck`。

- [ ] **Step 5: 提交**

```bash
git add apps/cli/src/core/self-critique.ts apps/cli/src/core/engine.ts apps/cli/test/core/self-critique.test.ts apps/cli/test/core/engine.test.ts
git commit -m "feat(self-critique): route critique chat through injected Llm seam"
```

---

## Task 3: SubAgent 漏缝接入（llm 参数 + ToolContext.llm + agent 工具接线）

**Files:**
- Modify: `apps/cli/src/agent/sub-agent.ts`（构造加 `llm?` + line 335 走缝）
- Modify: `apps/cli/src/shared/types.ts` + `packages/shared/src/types.ts`（ToolContext 加 `llm?`）
- Modify: `apps/cli/src/core/engine.ts`（ToolContext 注入 `llm: this.llm`）
- Modify: `apps/cli/src/tools/agent/agent.ts`（SubAgent 传 `ctx.llm`）
- Test: `apps/cli/test/agent/sub-agent.test.ts`（存在则扩展）

**Interfaces:**
- Produces: `SubAgent` 构造 `(registry, toolRegistry, permission?, hookEngine?, ruleEngine?, llm?)`；line 335 `(this.llm ?? this.registry).chat(...)`。

- [ ] **Step 1: 写失败测试**

断言：SubAgent 构造时传 llm 替身，`execute` 的 chat 走替身而非 registry 的 active provider。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/cli && pnpm test sub-agent`
Expected: FAIL。

- [ ] **Step 3: 最小实现**

`apps/cli/src/agent/sub-agent.ts`：
- `import type { Llm } from '../providers/llm'`。
- 构造加尾参 `private llm?: Llm`。
- line 335 改：`for await (const chunk of (this.llm ?? this.registry).chat({ ... }))`。
- line 192-194 的 `provider`/null 检查：`provider` 现仅用于 chat，改走后 `provider` 只用于空守卫——保留守卫（`if (!this.registry.getActive()) throw`），删除 `provider` 变量对 chat 的引用（避免 unused），或保留 `provider` 仅作守卫。以 eslint 无 warning 为准。

`apps/cli/src/shared/types.ts` + `packages/shared/src/types.ts`：`ToolContext` 加：

```ts
  llm?: import('../providers/llm').Llm
```

（注意两文件路径前缀一致。）

`apps/cli/src/core/engine.ts` ToolContext 注入（line 1062 附近）加：

```ts
        llm: this.llm,
```

`apps/cli/src/tools/agent/agent.ts`：`new SubAgent(..., ctx.llm)`（`ctx` 是 ToolContext，`ctx.llm` 可能 undefined → SubAgent 回退 registry，行为不变）。

**Ruling（记录到 ledger）**：command/workflow/fork-executor 三处 SubAgent 构造点本轮暂不传 llm（它们不走 ToolContext，需各自的 ctx 迁移）——保持 `registry` 回退，行为不变。留待各自路径迁 ctx 时一并接入。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/cli && pnpm test`，`cd apps/cli && pnpm typecheck`。

- [ ] **Step 5: 提交**

```bash
git add apps/cli/src/agent/sub-agent.ts apps/cli/src/shared/types.ts packages/shared/src/types.ts apps/cli/src/core/engine.ts apps/cli/src/tools/agent/agent.ts apps/cli/test/agent/sub-agent.test.ts
git commit -m "feat(sub-agent): route sub-agent chat through injected Llm seam"
```

---

## Self-Review

**Spec coverage（§5 三缝映射）：**
- `ctx.skills`（技能加载缝）→ Task 1 ✅
- M2b 遗留「self-critique/SubAgent 漏缝」→ Task 2 + Task 3 ✅
- `ctx.llm`/`ctx.tools` 已由 M2b/M2 落地（本轮不动）✅

**Placeholder scan：** 无 TBD/TODO；每 Step 含确切签名与命令。

**Type consistency：** `Skills`/`SKILLS_KEY`/`mountSkills`/`setSkills` 贯穿 Task 1 一致；`llm` 参数命名贯穿 Task 2/3 一致；`ToolContext.llm` 两处 shared 同步。
