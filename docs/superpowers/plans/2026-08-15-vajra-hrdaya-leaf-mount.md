# Vajra-Hṛdaya 真叶子挂载 — plan-runner 经 profile bundle 挂载 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补上 M3 组合层的「挂载」缺口——让 bundle 行从「配置行」变成「挂进 ctx 的 Service」，并用真叶子 plan-runner 走通 `loadProfile → assemble → mountProfile → run` 一整条声明式链，完成「plan-runner 经 profile bundle 挂载」的 live 演示。

**Architecture:** 组合层目前只有数据侧（`loadBundle`/`loadProfile`/`assemble`/`dumpConfig`），`BundleLine.kind` 是 `'tool'|'provider'|'skill'`（三缝），没有「要挂的代码」的桥。本里程碑：① `BundleLine.kind` 加 `'service'` 一档；② 新建 `apps/cli/src/vajra/compose/mount.ts`——`ServiceResolver` 回调 + `mountLines(ctx, lines, resolveService)` + `mountProfile(ctx, profile, resolveBundle, resolveService)`（内部 `assemble` → `mountLines`）；③ 测试用 plan-runner 走通整条链。生产 index.tsx 接线仍推迟（同 M2b/M2c/M3 先例，缝是注入出口）。

**Tech Stack:** TypeScript 5.5+ strict（ESM）、Bun/Node 22+、Vitest 3、yaml（已有依赖）。

**Spec:** `docs/superpowers/specs/2026-08-15-vajra-hrdaya-kernel-design.md`（§6 声明式组合「bundle = 配置行 + 要挂的代码」、§7.5 M3 交付、§11 成功标准）

## Global Constraints

- TS strict + ESM；Vitest 3；yaml 用已有 `yaml` 包。
- 测试命令：`cd apps/cli && pnpm test`；typecheck：`cd apps/cli && pnpm typecheck`。
- Conventional Commits；中文注释风格（src 核心文件）；不硬编码凭据；不 dispatch 子代理（implementer）。
- 组合层挂载函数纯（无 IO 副作用；文件读写在 `loadBundle`/`loadProfile` 既有函数，mount 不读盘）。
- 生产 index.tsx 不从 profile 组装（live startup 仍推迟）；`resolveService` 由调用方注入（「要挂的代码」不硬编码在 compose 层）。
- 分支 `feat/vajra-hrdaya-leaf-mount`。

---

## Task 1: mount 能力 + plan-runner 走通声明式链

**Files:**

- Create: `apps/cli/src/vajra/compose/mount.ts`
- Modify: `apps/cli/src/vajra/compose/bundle.ts`（`BundleLine.kind` 加 `'service'`）
- Modify: `apps/cli/src/vajra/compose/index.ts`（re-export `./mount`）
- Test: `apps/cli/test/vajra/compose.test.ts`（扩展）

**Interfaces:**

- Consumes: `Context`/`Mounted`/`Service` 类型（`../index`）；`Bundle`/`BundleLine`/`Profile`（`./bundle`）；`assemble`（`./assemble`）；真叶子 `planRunnerService`/`PLAN_RUNNER_KEY`/`PlanRunner`（`leaf/plan-runner`）；`LLM_KEY`/`replayLlm`/`RecordedTurn`（`providers/llm` / `providers/llm-replay`）。
- Produces: `type ServiceResolver = (line: BundleLine) => Service | undefined`；`mountLines(ctx, lines, resolveService): Mounted[]`；`mountProfile(ctx, profile, resolveBundle, resolveService): Mounted[]`；`BundleLine.kind` 扩为 `'tool' | 'provider' | 'skill' | 'service'`。

- [ ] **Step 1: 写失败测试**

`apps/cli/test/vajra/compose.test.ts` 追加（import 补 `Context`、`LLM_KEY`、`replayLlm`、`RecordedTurn`、`planRunnerService`、`PLAN_RUNNER_KEY`、`PlanRunner`、`mountProfile`、`mountLines`、`ServiceResolver`）：

```ts
import { Context } from '../../src/vajra'
import { LLM_KEY } from '../../src/providers/llm'
import { replayLlm, type RecordedTurn } from '../../src/providers/llm-replay'
import {
  planRunnerService,
  PLAN_RUNNER_KEY,
  type PlanRunner,
} from '../../src/vajra/leaf/plan-runner'
import { assemble, dumpConfig, loadBundle, loadProfile } from '../../src/vajra/compose'
import { mountProfile, type ServiceResolver } from '../../src/vajra/compose'

const text = (s: string): RecordedTurn => ({
  req: { model: 'm', messages: [] },
  chunks: [{ type: 'text', content: s }, { type: 'stop' }],
})

it('mounts the plan-runner leaf via a profile bundle', async () => {
  const ctx = new Context()
  ctx.provide(LLM_KEY, replayLlm([text('implemented A'), text('APPROVE')]))

  const bundle: Bundle = {
    name: 'orchestration',
    lines: [{ id: 'plan-runner', kind: 'service', config: {} }],
  }
  const resolveService: ServiceResolver = (line) =>
    line.id === 'plan-runner' ? planRunnerService : undefined

  const mounted = mountProfile(
    ctx,
    { name: 'default', bundles: ['orchestration'] },
    () => bundle,
    resolveService,
  )
  const runner = ctx.get<PlanRunner>(PLAN_RUNNER_KEY)!
  const outcomes = await runner.run({ name: 'p', tasks: [{ id: 't1', description: 'do A' }] })

  expect(outcomes.map((o) => o.status)).toEqual(['done'])
  expect(mounted).toHaveLength(1)
  expect(mounted[0]!.status()).toBe('active')
})

it('loads a bundle + profile from disk and mounts plan-runner (declarative end-to-end)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'leaf-mount-'))
  writeFileSync(
    join(dir, 'orchestration.yml'),
    'name: orchestration\nlines:\n  - id: plan-runner\n    kind: service\n    config: {}\n',
  )
  writeFileSync(join(dir, 'default.yml'), 'name: default\nbundles:\n  - orchestration\n')

  const ctx = new Context()
  ctx.provide(LLM_KEY, replayLlm([text('implemented'), text('APPROVE')]))

  const profile = loadProfile(join(dir, 'default.yml'))
  const resolveBundle = (name: string) => loadBundle(join(dir, `${name}.yml`))
  const resolveService: ServiceResolver = (line) =>
    line.id === 'plan-runner' ? planRunnerService : undefined

  const mounted = mountProfile(ctx, profile, resolveBundle, resolveService)
  const runner = ctx.get<PlanRunner>(PLAN_RUNNER_KEY)!
  const outcomes = await runner.run({ name: 'p', tasks: [{ id: 't1', description: 'do A' }] })

  expect(outcomes.map((o) => o.status)).toEqual(['done'])
  expect(mounted).toHaveLength(1)
  rmSync(dir, { recursive: true, force: true })
})
```

（`Bundle` 类型已在文件顶部 `import type { Bundle, BundleLine, Profile }`，若未导入则补。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm test compose`
Expected: FAIL——`mountProfile` 未定义（模块未导出）。

- [ ] **Step 3: 最小实现**

`apps/cli/src/vajra/compose/bundle.ts`：`kind` 加 `'service'`：

```ts
export type BundleLine = {
  id: string
  kind: 'tool' | 'provider' | 'skill' | 'service'
  config: Record<string, unknown>
}
```

`apps/cli/src/vajra/compose/mount.ts`：

```ts
import type { Context, Mounted, Service } from '..'
import type { Bundle, BundleLine, Profile } from './bundle'
import { assemble } from './assemble'

/** 服务解析器：bundle 行的「要挂的代码」——按行解析出要挂载的 Service；纯数据行（如 package-info）返回 undefined 跳过。 */
export type ServiceResolver = (line: BundleLine) => Service | undefined

/** 按行顺序把解析出的 Service 挂进 ctx（依赖未就位则挂起，语义同 ctx.mount）。 */
export function mountLines(
  ctx: Context,
  lines: BundleLine[],
  resolveService: ServiceResolver,
): Mounted[] {
  const mounted: Mounted[] = []
  for (const line of lines) {
    const service = resolveService(line)
    if (service) mounted.push(ctx.mount(service))
  }
  return mounted
}

/** 从 profile 声明式挂载：assemble → mountLines 一整条链。 */
export function mountProfile(
  ctx: Context,
  profile: Profile,
  resolveBundle: (name: string) => Bundle,
  resolveService: ServiceResolver,
): Mounted[] {
  return mountLines(ctx, assemble(profile, resolveBundle), resolveService)
}
```

`apps/cli/src/vajra/compose/index.ts`：追加 `export * from './mount'`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm test compose`；`cd apps/cli && pnpm test` 全量；`cd apps/cli && pnpm typecheck`。

- [ ] **Step 5: 提交**

```bash
git add apps/cli/src/vajra/compose/mount.ts apps/cli/src/vajra/compose/bundle.ts apps/cli/src/vajra/compose/index.ts apps/cli/test/vajra/compose.test.ts
git commit -m "feat(vajra): mount services via profile bundle — plan-runner 走通声明式链"
```

---

## Self-Review

**Spec coverage（§6/§7.5/§11）：**

- bundle = 「配置行 + 要挂的代码」→ Task 1 `ServiceResolver` + `mountLines`/`mountProfile` ✅
- profile 声明式组合 → `mountProfile` 走 `assemble` 链 ✅
- 「装下一片真叶子」live 演示（plan-runner 经 profile 挂载）→ 两个测试（inline + YAML end-to-end）✅
- `--dump-config` 打印真实树 → 既有 `dumpConfig` 不动（本里程碑只补挂载，不重复 dump）✅

**Placeholder scan：** 无 TBD；每 Step 含确切代码与测试。

**Type consistency：** `ServiceResolver`/`mountLines`/`mountProfile` 命名贯穿一致；`kind` 加 `'service'` 后 `assemble` 的 `partial.kind ?? 'tool'` 回退不变；`Context`/`Mounted`/`Service` 从 `../index` 导入（vajra index 已导出）。

**Deferred（不在本轮）**：生产 index.tsx 从 profile 组装（live startup，同先例推迟）；service registry 用 Map 而非回调（回调更灵活，YAGNI）；`provide` 未 unmount 回收（内核 M0 既有边缘，记后续里程碑）。
