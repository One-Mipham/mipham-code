# Vajra-Hṛdaya M0 内核原语 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 Vajra-Hṛdaya 内核四原语（Context 服务仓库、可逆效应、事件四派发、Service 生命周期），纯库零迁移。

**Architecture:** 一个纯 TypeScript 库，放在 `apps/cli/src/vajra/`，与现有代码零耦合。四个原语由三个源文件 + 一个类型文件承载，各自独立可测。事件「模式」在类型层声明为契约（派发方法只能对声明了对应 mode 的事件调用），依赖注入走 `Service.inject` 声明 + `mount` 状态机解析。

**Tech Stack:** TypeScript 5.5+（strict）、Bun 1.2+、Vitest 3（globals/node 环境）

**Spec:** `docs/superpowers/specs/2026-08-15-vajra-hrdaya-kernel-design.md`

## Global Constraints

- TypeScript `strict` 模式，ESM 模块（与现有 `apps/cli` 一致）
- 测试：Vitest 3，`globals: true`，`environment: 'node'`，文件放 `test/vajra/*.test.ts`，import 走 `../../src/vajra/...`
- lint/format：ESLint（flat）+ Prettier，CI 强制（提交前 `pnpm lint` / `pnpm format`）
- 提交信息遵循 Conventional Commits（`feat(vajra): ...`）
- 工作目录：`apps/cli`（所有命令在此目录执行）
- 分支：`feat/vajra-hrdaya-m0`
- **零迁移**：M0 不改任何 `src/` 现有文件，现有测试（约 1300）必须全绿
- 内核不进 `packages/`（YAGNI，等第二消费者出现再抽）

---

### Task 1: Context 骨架 — 服务仓库 + scope

**Files:**

- Create: `apps/cli/src/vajra/context.ts`
- Create: `apps/cli/src/vajra/events.ts`（先建空类型文件，Task 3 填充）
- Test: `apps/cli/test/vajra/context.test.ts`

**Interfaces:**

- Produces: `class Context`，方法 `provide<T>(key, value): Disposer`、`get<T>(key): T | undefined`、`has(key): boolean`、`scope(key): Context`；`type Disposer = () => void`

- [ ] **Step 1: 写失败测试**

`apps/cli/test/vajra/context.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Context } from '../../src/vajra/context'

describe('Context service repository', () => {
  it('provides and gets a service by key', () => {
    const ctx = new Context()
    ctx.provide('llm', { name: 'deepseek' })
    expect(ctx.get('llm')).toEqual({ name: 'deepseek' })
    expect(ctx.get('missing')).toBeUndefined()
  })

  it('provide returns a disposer that removes the service', () => {
    const ctx = new Context()
    const off = ctx.provide('tmp', 1)
    expect(ctx.has('tmp')).toBe(true)
    off()
    expect(ctx.has('tmp')).toBe(false)
  })

  it('scope() creates a child that falls back to parent and can shadow', () => {
    const root = new Context()
    root.provide('cfg', { x: 1 })
    const child = root.scope('agent-1')
    expect(child.get('cfg')).toEqual({ x: 1 })
    child.provide('cfg', { x: 2 })
    expect(child.get('cfg')).toEqual({ x: 2 })
    expect(root.get('cfg')).toEqual({ x: 1 })
  })

  it('has() checks local then parent', () => {
    const root = new Context()
    root.provide('a', 1)
    const child = root.scope('agent-1')
    expect(child.has('a')).toBe(true)
    expect(child.has('b')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/vajra/context.test.ts`
Expected: FAIL — `Cannot find module '../../src/vajra/context'`

- [ ] **Step 3: 写最小实现**

`apps/cli/src/vajra/context.ts`:

```ts
export type Disposer = () => void

export class Context {
  private services = new Map<string, unknown>()
  readonly parent?: Context

  constructor(parent?: Context) {
    this.parent = parent
  }

  provide<T>(key: string, value: T): Disposer {
    this.services.set(key, value)
    return () => {
      this.services.delete(key)
    }
  }

  get<T>(key: string): T | undefined {
    return (this.services.get(key) as T | undefined) ?? this.parent?.get<T>(key)
  }

  has(key: string): boolean {
    return this.services.has(key) || (this.parent?.has(key) ?? false)
  }

  scope(_key: unknown): Context {
    return new Context(this)
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/vajra/context.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add src/vajra/context.ts test/vajra/context.test.ts
git commit -m "feat(vajra): add Context service repository + scope"
```

---

### Task 2: 可逆效应 — effect + dispose LIFO 回滚

**Files:**

- Modify: `apps/cli/src/vajra/context.ts`（加 `effect`/`dispose`）
- Test: `apps/cli/test/vajra/context.test.ts`（追加 describe）

**Interfaces:**

- Consumes: `Context`（Task 1）
- Produces: `effect(fn: () => Disposer | void): Disposer`、`dispose(): void`

- [ ] **Step 1: 写失败测试**

在 `context.test.ts` 追加:

```ts
describe('Context reversible effects', () => {
  it('effect registers and returns a disposer', () => {
    const ctx = new Context()
    const log: string[] = []
    const off = ctx.effect(() => {
      log.push('setup')
      return () => log.push('teardown')
    })
    expect(log).toEqual(['setup'])
    off()
    expect(log).toEqual(['setup', 'teardown'])
  })

  it('dispose() unwinds effects in LIFO order', () => {
    const ctx = new Context()
    const log: string[] = []
    ctx.effect(() => {
      log.push('a+')
      return () => log.push('a-')
    })
    ctx.effect(() => {
      log.push('b+')
      return () => log.push('b-')
    })
    ctx.dispose()
    expect(log).toEqual(['a+', 'b+', 'b-', 'a-'])
  })

  it('effect without a returned disposer is safe to dispose', () => {
    const ctx = new Context()
    const log: string[] = []
    ctx.effect(() => {
      log.push('x')
    })
    ctx.dispose()
    expect(log).toEqual(['x'])
  })

  it('manual dispose then context dispose does not double-teardown', () => {
    const ctx = new Context()
    let count = 0
    const off = ctx.effect(() => () => {
      count++
    })
    off()
    ctx.dispose()
    expect(count).toBe(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/vajra/context.test.ts`
Expected: FAIL — `ctx.effect is not a function`

- [ ] **Step 3: 写最小实现**

在 `Context` 类内加:

```ts
  private effects: Disposer[] = []

  effect(fn: () => Disposer | void): Disposer {
    const d = fn() ?? (() => {})
    let disposed = false
    const dispose = () => {
      if (disposed) return
      disposed = true
      d()
    }
    this.effects.push(dispose)
    return dispose
  }

  dispose(): void {
    while (this.effects.length) this.effects.pop()!()
    this.services.clear()
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/vajra/context.test.ts`
Expected: PASS（8 tests）

- [ ] **Step 5: 提交**

```bash
git add src/vajra/context.ts test/vajra/context.test.ts
git commit -m "feat(vajra): add reversible effects with LIFO dispose"
```

---

### Task 3: 事件类型 — DispatchMode / EventMap / EventsOfMode

**Files:**

- Modify: `apps/cli/src/vajra/events.ts`（填充类型）
- Test: 无运行时测试（类型层，Task 4 用 typecheck 验证）

**Interfaces:**

- Produces: `type DispatchMode = 'emit' | 'waterfall' | 'parallel' | 'serial'`；`interface EventMap {}`（里程碑通过 declaration merging 扩展）；`type EventsOfMode<M extends DispatchMode>`（从 EventMap 提取声明为某 mode 的事件名联合）

- [ ] **Step 1: 写实现**

`apps/cli/src/vajra/events.ts`:

```ts
export type DispatchMode = 'emit' | 'waterfall' | 'parallel' | 'serial'

/**
 * 事件契约映射。每个事件名声明其派发模式；里程碑/测试通过
 * declaration merging 扩展本 interface（无需改内核）。
 */
export interface EventMap {}

/** 提取声明为指定 mode 的事件名联合。 */
export type EventsOfMode<M extends DispatchMode> = {
  [K in keyof EventMap]: EventMap[K] extends { mode: M } ? K : never
}[keyof EventMap]
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: PASS（新增类型无引用，不产生错误）

- [ ] **Step 3: 提交**

```bash
git add src/vajra/events.ts
git commit -m "feat(vajra): add typed event map with mode contract"
```

---

### Task 4: 事件派发 — on + 四派发方法（mode 约束）

**Files:**

- Modify: `apps/cli/src/vajra/context.ts`（加 `on`/`emit`/`waterfall`/`parallel`/`serial`，signature 用 `EventsOfMode` 约束）
- Test: `apps/cli/test/vajra/events.test.ts`（运行时行为）+ 同文件内的 typecheck 断言（`@ts-expect-error`）

**Interfaces:**

- Consumes: `EventsOfMode`（Task 3）、`Context`（Task 1）
- Produces: `on(event, fn): Disposer`；`emit(event: EventsOfMode<'emit'>, ...args): void`；`waterfall<T>(event: EventsOfMode<'waterfall'>, value: T, ...args): Promise<T>`；`parallel(event: EventsOfMode<'parallel'>, ...args): Promise<unknown[]>`；`serial(event: EventsOfMode<'serial'>, ...args): Promise<unknown[]>`

- [ ] **Step 1: 写失败测试**

`apps/cli/test/vajra/events.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Context } from '../../src/vajra/context'

// 测试用事件契约（declaration merging 扩展内核的 EventMap）
declare module '../../src/vajra/events' {
  interface EventMap {
    't/emit': { mode: 'emit' }
    't/wf': { mode: 'waterfall' }
    't/p': { mode: 'parallel' }
    't/s': { mode: 'serial' }
  }
}

describe('Context event dispatch', () => {
  it('emit fires listeners in registration order', () => {
    const ctx = new Context()
    const order: string[] = []
    ctx.on('t/emit', () => order.push('a'))
    ctx.on('t/emit', () => order.push('b'))
    ctx.emit('t/emit')
    expect(order).toEqual(['a', 'b'])
  })

  it('on() returns a disposer that removes the listener', () => {
    const ctx = new Context()
    const calls: string[] = []
    const off = ctx.on('t/emit', () => calls.push('x'))
    off()
    ctx.emit('t/emit')
    expect(calls).toEqual([])
  })

  it('waterfall chains values and can short-circuit', async () => {
    const ctx = new Context()
    ctx.on('t/wf', async (v: number, next: (n?: number) => Promise<number>) => next(v + 1))
    ctx.on('t/wf', async (v: number, next: (n?: number) => Promise<number>) => next(v * 10))
    await expect(ctx.waterfall<number>('t/wf', 1)).resolves.toBe(20)

    const guard = new Context()
    guard.on('t/wf', async (v: number, next: (n?: number) => Promise<number>) => {
      if (v === 1) return -1
      return next(v)
    })
    guard.on('t/wf', async (v: number, next: (n?: number) => Promise<number>) => next(v + 1))
    await expect(guard.waterfall<number>('t/wf', 1)).resolves.toBe(-1)
  })

  it('parallel runs concurrently, serial runs in order', async () => {
    const p = new Context()
    const pOrder: string[] = []
    p.on('t/p', async () => {
      await new Promise((r) => setTimeout(r, 30))
      pOrder.push('slow')
    })
    p.on('t/p', async () => {
      pOrder.push('fast')
    })
    await p.parallel('t/p')
    expect(pOrder[0]).toBe('fast')

    const s = new Context()
    const sOrder: string[] = []
    s.on('t/s', async () => {
      await new Promise((r) => setTimeout(r, 30))
      sOrder.push('slow')
    })
    s.on('t/s', async () => {
      sOrder.push('fast')
    })
    await s.serial('t/s')
    expect(sOrder).toEqual(['slow', 'fast'])
  })
})

describe('event mode is a compile-time contract', () => {
  it('dispatch methods reject wrong-mode events at the type level', () => {
    const ctx = new Context()
    ctx.emit('t/emit')
    ctx.waterfall<number>('t/wf', 1)
    // @ts-expect-error — 't/emit' 不是 waterfall 模式
    ctx.waterfall<number>('t/emit', 1)
    // @ts-expect-error — 't/wf' 不是 emit 模式
    ctx.emit('t/wf')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/vajra/events.test.ts`
Expected: FAIL — `ctx.on is not a function`

- [ ] **Step 3: 写最小实现**

在 `context.ts` 顶部 import 类型，类内加:

```ts
import type { EventsOfMode } from './events'

type Listener = (...args: any[]) => any

// 类内字段
private listeners = new Map<string, Listener[]>()

// 类内方法
on(event: string, fn: Listener): Disposer {
  const ls = this.listeners.get(event) ?? []
  ls.push(fn)
  this.listeners.set(event, ls)
  return () => {
    const cur = this.listeners.get(event)
    if (cur) this.listeners.set(event, cur.filter((l) => l !== fn))
  }
}

emit(event: EventsOfMode<'emit'>, ...args: unknown[]): void {
  for (const fn of this.listeners.get(event) ?? []) fn(...args)
}

async waterfall<T>(event: EventsOfMode<'waterfall'>, value: T, ...args: unknown[]): Promise<T> {
  const ls = this.listeners.get(event) ?? []
  const run = async (i: number, v: T): Promise<T> => {
    if (i >= ls.length) return v
    const next = async (nextVal?: T) => run(i + 1, nextVal === undefined ? v : nextVal)
    return (await ls[i](v, ...args, next)) as T
  }
  return run(0, value)
}

async parallel(event: EventsOfMode<'parallel'>, ...args: unknown[]): Promise<unknown[]> {
  return Promise.all((this.listeners.get(event) ?? []).map((fn) => fn(...args)))
}

async serial(event: EventsOfMode<'serial'>, ...args: unknown[]): Promise<unknown[]> {
  const out: unknown[] = []
  for (const fn of this.listeners.get(event) ?? []) out.push(await fn(...args))
  return out
}
```

并在 `dispose()` 内加 `this.listeners.clear()`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/vajra/events.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: typecheck 验证类型契约**

Run: `pnpm typecheck`
Expected: PASS — 两条 `@ts-expect-error` 均命中真实类型错误（若任一未命中，tsc 报「unused @ts-expect-error」，即失败）

- [ ] **Step 6: 提交**

```bash
git add src/vajra/context.ts test/vajra/events.test.ts
git commit -m "feat(vajra): add event dispatch with mode contract"
```

---

### Task 5: Service 生命周期 — mount + inject + 状态机

**Files:**

- Create: `apps/cli/src/vajra/service.ts`
- Modify: `apps/cli/src/vajra/context.ts`（加 `mount` 方法 + waiter 列表 + `flushWaiters` 接进 `provide`）
- Test: `apps/cli/test/vajra/service.test.ts`

**Interfaces:**

- Consumes: `Context`（Task 1）
- Produces: `interface Service { inject?: string[]; apply(ctx: Context): void | Disposer }`；`type ServiceStatus = 'inactive' | 'loading' | 'active' | 'unloading' | 'failed'`；`interface Mounted { dispose(): void; status(): ServiceStatus; readonly error?: Error }`；`Context.mount(service: Service): Mounted`

- [ ] **Step 1: 写失败测试**

`apps/cli/test/vajra/service.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Context } from '../../src/vajra/context'
import type { Service } from '../../src/vajra/service'

describe('Context.mount lifecycle', () => {
  it('mount applies immediately when dependencies are present', () => {
    const ctx = new Context()
    ctx.provide('cfg', { x: 1 })
    let applied = false
    const svc: Service = {
      inject: ['cfg'],
      apply(c) {
        applied = true
        expect(c.get('cfg')).toEqual({ x: 1 })
      },
    }
    const m = ctx.mount(svc)
    expect(applied).toBe(true)
    expect(m.status()).toBe('active')
  })

  it('mount defers when deps missing, activates on provide', () => {
    const ctx = new Context()
    let applied = false
    const svc: Service = {
      inject: ['cfg'],
      apply() {
        applied = true
      },
    }
    const m = ctx.mount(svc)
    expect(applied).toBe(false)
    expect(m.status()).toBe('inactive')
    ctx.provide('cfg', { x: 1 })
    expect(applied).toBe(true)
    expect(m.status()).toBe('active')
  })

  it('mount isolates apply failure — host survives, status failed', () => {
    const ctx = new Context()
    const svc: Service = {
      apply() {
        throw new Error('boom')
      },
    }
    const m = ctx.mount(svc)
    expect(m.status()).toBe('failed')
    expect(m.error?.message).toBe('boom')
    // host still usable
    ctx.provide('ok', 1)
    expect(ctx.get('ok')).toBe(1)
  })

  it('mount.dispose() unwinds the service effects', () => {
    const ctx = new Context()
    const log: string[] = []
    const svc: Service = {
      apply(c) {
        return c.effect(() => {
          log.push('up')
          return () => log.push('down')
        })
      },
    }
    const m = ctx.mount(svc)
    expect(log).toEqual(['up'])
    m.dispose()
    expect(log).toEqual(['up', 'down'])
    expect(m.status()).toBe('unloading')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/vajra/service.test.ts`
Expected: FAIL — `ctx.mount is not a function`

- [ ] **Step 3: 写最小实现**

`apps/cli/src/vajra/service.ts`:

```ts
import type { Context } from './context'
import type { Disposer } from './context'

export interface Service {
  inject?: string[]
  apply(ctx: Context): void | Disposer
}

export type ServiceStatus = 'inactive' | 'loading' | 'active' | 'unloading' | 'failed'

export interface Mounted {
  dispose(): void
  status(): ServiceStatus
  readonly error?: Error
}
```

`context.ts` 类内加（并在 `provide` 内 set 之后调用 `this.flushWaiters()`）:

```ts
import type { Service, Mounted, ServiceStatus } from './service'

// 类内字段
private waiters: Array<() => boolean> = []

// provide() 改为：
provide<T>(key: string, value: T): Disposer {
  this.services.set(key, value)
  this.flushWaiters()
  return () => {
    this.services.delete(key)
  }
}

// 类内方法
private flushWaiters(): void {
  this.waiters = this.waiters.filter((w) => !w())
}

mount(service: Service): Mounted {
  const keys = service.inject ?? []
  let status: ServiceStatus = 'inactive'
  let error: Error | undefined
  let disposer: Disposer = () => {}

  const tryApply = (): boolean => {
    if (!keys.every((k) => this.has(k))) return false
    status = 'loading'
    try {
      disposer = service.apply(this) ?? (() => {})
      status = 'active'
    } catch (e) {
      error = e as Error
      status = 'failed'
    }
    return true
  }

  const waiter = (): boolean => {
    if (!tryApply()) return false
    this.waiters = this.waiters.filter((w) => w !== waiter)
    return true
  }

  if (!tryApply()) {
    this.waiters.push(waiter)
  }

  const mounted: Mounted = {
    dispose: () => {
      if (status === 'active') {
        status = 'unloading'
        disposer()
      }
    },
    status: () => status,
  }
  Object.defineProperty(mounted, 'error', { get: () => error })
  return mounted
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/vajra/service.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add src/vajra/service.ts src/vajra/context.ts test/vajra/service.test.ts
git commit -m "feat(vajra): add Service lifecycle state machine + inject"
```

---

### Task 6: 导出 + 全量回归

**Files:**

- Create: `apps/cli/src/vajra/index.ts`
- Test: 无新测试；跑全量回归确认零迁移

**Interfaces:**

- Produces: `export { Context } from './context'`、`export type { Disposer }`、`export type { DispatchMode, EventMap, EventsOfMode } from './events'`、`export type { Service, ServiceStatus, Mounted } from './service'`

- [ ] **Step 1: 写导出**

`apps/cli/src/vajra/index.ts`:

```ts
export { Context } from './context'
export type { Disposer } from './context'
export type { DispatchMode, EventMap, EventsOfMode } from './events'
export type { Service, ServiceStatus, Mounted } from './service'
```

- [ ] **Step 2: typecheck + lint + format**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm format
```

Expected: 全部 PASS（无错误）

- [ ] **Step 3: 全量测试回归（零迁移验证）**

Run: `pnpm vitest run`
Expected: 约 1300+ 测试全绿（含新增 ~17 个 vajra 测试），0 失败；`test/e2e/full-pipeline.test.ts` 若为条件测试（无 API key 时跳过）不影响。

- [ ] **Step 4: 提交**

```bash
git add src/vajra/index.ts
git commit -m "feat(vajra): add public exports for Vajra-Hrdaya kernel"
```

---

## Self-Review 结果

- **Spec 覆盖**：M0 四原语（Context 服务仓库=Task1、可逆效应=Task2、事件四派发+类型契约=Task3/4、Service 生命周期+inject=Task5、导出=Task6）全部有对应任务。scope 在 Task1 覆盖（子 context + 父回退 + shadowing）。✓
- **占位符扫描**：无 TBD/TODO，所有代码步骤含完整实现。✓
- **类型一致性**：`Disposer` 在 Task1 定义、Task2/5 复用；`EventsOfMode` 在 Task3 定义、Task4 消费；`Service`/`ServiceStatus`/`Mounted` 在 Task5 定义、Task6 导出。`scope(_key)` 参数名与 spec §3 API 一致。✓
- **已知取舍**（记录，非缺口）：派发方法的 `in`/`out` 载荷类型在 M0 用 `unknown`/泛型承载（非 spec §3.1 的完整 `EventShape.in/out`），事件「模式」编译期强制已达成，精确载荷类型推迟到 M1 日志事件落地时按需补——符合「内核只做到能装下一片真叶子就停」。
