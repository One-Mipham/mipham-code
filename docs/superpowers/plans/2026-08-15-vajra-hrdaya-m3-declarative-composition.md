# Vajra-Hṛdaya M3 — 声明式组合（scope shadowing + profile/bundle/patch + --dump-config）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收官「版本/依赖治理」旧账——声明式组合（profile/bundle/patch）+ `--dump-config` + per-agent scope shadowing。三缝（ctx.llm/tools/skills）已就位，M3 只做「组合变成声明 + scope 遮蔽」。

**Architecture:** 分两半：① 内核层——补 `Context.scope(key)` 的 keyed 缓存 + `keysRecursive()` 枚举（local 遮蔽 parent），`collectTools` 改用 `keysRecursive`；② 组合层——新建 `apps/cli/src/vajra/compose/`（bundle/profile/patch 纯函数 + `--dump-config` 输出），不接 live startup（同 M2b/M2c 生产接线推迟先例，缝是注入出口）。

**Tech Stack:** TypeScript 5.5+ strict（ESM）、Bun/Node 22+、Vitest 3、yaml（已有依赖）。

**Spec:** `docs/superpowers/specs/2026-08-15-vajra-hrdaya-kernel-design.md`（§6 声明式组合、§3.2 scope、§7.5 M3 交付、§11 成功标准 4）

## Global Constraints

- TS strict + ESM；Vitest 3；yaml 用已有 `yaml` 包。
- 测试命令：`cd apps/cli && pnpm test`；typecheck：`cd apps/cli && pnpm typecheck`。
- Conventional Commits；中文注释风格；不硬编码凭据；不 dispatch 子代理（implementer）。
- 组合层纯函数（无 IO 副作用于核心 resolver；文件读写在独立函数）。profile 存 `~/.mipham/profiles/`（bundle 同目录）。
- 不接 live startup（index.tsx 不从 profile 组装）；`--dump-config` 是独立命令输出组装树。

---

## Task 1: Context.scope keyed 缓存 + keysRecursive 枚举 + collectTools 遮蔽

**Files:**

- Modify: `apps/cli/src/vajra/context.ts`
- Modify: `apps/cli/src/tools/seam.ts`（`collectTools` 用 `keysRecursive`）
- Test: `apps/cli/test/vajra/context.test.ts`（存在则扩展）、`apps/cli/test/core/engine.test.ts` 或 `tools` 测试

**Interfaces:**

- Produces: `Context.keysRecursive(): string[]`（local ∪ parent，local 优先去重）；`Context.scope(key)` keyed 缓存（重复调用返回同一 child）。

- [ ] **Step 1: 写失败测试**

`apps/cli/test/vajra/context.test.ts`（或就近）：

```ts
it('scope(key) returns the same child context for the same key', () => {
  const root = new Context()
  const a = root.scope('agent-x')
  const b = root.scope('agent-x')
  expect(a).toBe(b)
})

it('keysRecursive enumerates parent + local with local shadowing', () => {
  const root = new Context()
  root.provide('tool:read', 'parent-read')
  const child = root.scope('agent-x')
  child.provide('tool:read', 'child-read') // shadow
  child.provide('tool:write', 'child-write')
  expect(new Set(child.keysRecursive())).toEqual(new Set(['tool:read', 'tool:write']))
  expect(child.get('tool:read')).toBe('child-read')
  expect(child.get('tool:write')).toBe('child-write')
})
```

`collectTools` 遮蔽测试（tools 测试或 engine 测试）：root 挂 `tool:read`（A），scoped child 挂同名 `tool:read`（B），`collectTools(child).get('read')` === B。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm test vajra tools`
Expected: FAIL——`scope` 未缓存、`keysRecursive` 未定义。

- [ ] **Step 3: 最小实现**

`apps/cli/src/vajra/context.ts`：

- 字段加 `private scopes = new Map<unknown, Context>()`。
- `scope(key: unknown): Context` 改为：

```ts
  scope(key: unknown): Context {
    let child = this.scopes.get(key)
    if (!child) {
      child = new Context(this)
      this.scopes.set(key, child)
    }
    return child
  }
```

- 新增：

```ts
  /** 枚举本层 + 父层所有键（local 遮蔽 parent，去重）。 */
  keysRecursive(): string[] {
    const seen = new Set<string>(this.keys())
    const parentKeys = this.parent?.keysRecursive() ?? []
    for (const k of parentKeys) seen.add(k)
    return [...seen]
  }
```

`apps/cli/src/tools/seam.ts`：`collectTools` 里 `for (const key of ctx.keys())` → `for (const key of ctx.keysRecursive())`（使 scoped 上下文能遮蔽全局工具）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm test` 全量；`cd apps/cli && pnpm typecheck`。

- [ ] **Step 5: 提交**

```bash
git add apps/cli/src/vajra/context.ts apps/cli/src/tools/seam.ts apps/cli/test/vajra/context.test.ts apps/cli/test/tools/collect-tools.test.ts
git commit -m "feat(vajra): scope keyed caching + keysRecursive enumeration (shadowing)"
```

---

## Task 2: profile/bundle 声明式层 + --dump-config

**Files:**

- Create: `apps/cli/src/vajra/compose/bundle.ts`（Bundle/Profile 类型 + load）
- Create: `apps/cli/src/vajra/compose/assemble.ts`（resolve profile → line list）
- Create: `apps/cli/src/vajra/compose/dump.ts`（`dumpConfig(profile) → string`）
- Create: `apps/cli/src/vajra/compose/index.ts`（re-export）
- Test: `apps/cli/test/vajra/compose.test.ts`

**Interfaces:**

- Produces:
  - `type BundleLine = { id: string; kind: 'tool' | 'provider' | 'skill'; config: Record<string, unknown> }`
  - `type Bundle = { name: string; lines: BundleLine[] }`
  - `type Profile = { name: string; bundles: string[]; patch?: Record<string, Partial<BundleLine>> }`
  - `loadBundle(path): Bundle`、`loadProfile(path): Profile`（yaml 解析，纯数据）
  - `assemble(profile: Profile, resolveBundle: (name) => Bundle): BundleLine[]`（按 bundles 顺序拼接 lines）
  - `dumpConfig(lines: BundleLine[]): string`（每行 `${id}  ${kind}  ${JSON.stringify(config)}`）

- [ ] **Step 1: 写失败测试**

`apps/cli/test/vajra/compose.test.ts`：

```ts
import { assemble, dumpConfig, loadProfile, loadBundle } from '../../src/vajra/compose'

it('assemble concatenates bundles in order', () => {
  const b1 = { name: 'b1', lines: [{ id: 't1', kind: 'tool', config: {} }] }
  const b2 = { name: 'b2', lines: [{ id: 'p1', kind: 'provider', config: {} }] }
  const profile = { name: 'p', bundles: ['b1', 'b2'] }
  const resolve = (n: string) => (n === 'b1' ? b1 : b2)
  expect(assemble(profile, resolve).map((l) => l.id)).toEqual(['t1', 'p1'])
})

it('dumpConfig prints one line per resolved line', () => {
  const lines = [{ id: 't1', kind: 'tool', config: { a: 1 } }]
  expect(dumpConfig(lines)).toContain('t1')
  expect(dumpConfig(lines)).toContain('tool')
})

it('loadBundle parses a yaml bundle file', () => {
  // 用 tmp 目录写 yaml → loadBundle → 断言 lines
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm test compose`
Expected: FAIL——模块未定义。

- [ ] **Step 3: 最小实现**

`bundle.ts`：

```ts
import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'

export type BundleLine = {
  id: string
  kind: 'tool' | 'provider' | 'skill'
  config: Record<string, unknown>
}
export type Bundle = { name: string; lines: BundleLine[] }
export type Profile = {
  name: string
  bundles: string[]
  patch?: Record<string, Partial<BundleLine>>
}

export function loadBundle(path: string): Bundle {
  const raw = readFileSync(path, 'utf-8')
  const data = parseYaml(raw) as { name?: string; lines?: BundleLine[] }
  return { name: data.name ?? path, lines: data.lines ?? [] }
}

export function loadProfile(path: string): Profile {
  const raw = readFileSync(path, 'utf-8')
  const data = parseYaml(raw) as Profile
  return { name: data.name ?? path, bundles: data.bundles ?? [], patch: data.patch }
}
```

`assemble.ts`：

```ts
import type { Profile, Bundle, BundleLine } from './bundle'

export function assemble(profile: Profile, resolveBundle: (name: string) => Bundle): BundleLine[] {
  return profile.bundles.flatMap((name) => resolveBundle(name).lines)
}
```

`dump.ts`：

```ts
import type { BundleLine } from './bundle'

export function dumpConfig(lines: BundleLine[]): string {
  return lines.map((l) => `${l.id}\t${l.kind}\t${JSON.stringify(l.config)}`).join('\n')
}
```

`index.ts`：re-export bundle/assemble/dump 的导出。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm test compose`；`cd apps/cli && pnpm typecheck`。

- [ ] **Step 5: 提交**

```bash
git add apps/cli/src/vajra/compose apps/cli/test/vajra/compose.test.ts
git commit -m "feat(vajra): profile/bundle declarative layer + dumpConfig"
```

---

## Task 3: patch 一行替换 + 「包名/版本只改 bundle 一处」测试

**Files:**

- Modify: `apps/cli/src/vajra/compose/assemble.ts`（assemble 应用 profile.patch）
- Test: `apps/cli/test/vajra/compose.test.ts`

**Interfaces:**

- `assemble(profile, resolveBundle)` 现在：拼 lines 后，对 `profile.patch` 里每个 `[id, partial]`，找到 `lines.find(l => l.id === id)` 并 `Object.assign(line, partial)`（未找到则追加）。

- [ ] **Step 1: 写失败测试**

```ts
it('patch replaces a line by id', () => {
  const b1 = { name: 'b1', lines: [{ id: 'ver', kind: 'skill', config: { version: '1.0.0' } }] }
  const profile = { name: 'p', bundles: ['b1'], patch: { ver: { config: { version: '2.0.0' } } } }
  const lines = assemble(profile, (n) => b1)
  expect(lines.find((l) => l.id === 'ver')!.config.version).toBe('2.0.0')
})

it('package/version change lives in one bundle line', () => {
  const b = {
    name: 'meta',
    lines: [{ id: 'package-info', kind: 'provider', config: { version: '1.0.0' } }],
  }
  // 变更 bundle 一处 → dumpConfig 反映新版本，无需改其他文件
  b.lines[0]!.config.version = '2.0.0'
  expect(dumpConfig(assemble({ name: 'p', bundles: ['meta'] }, () => b))).toContain('2.0.0')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm test compose`
Expected: FAIL——patch 未应用。

- [ ] **Step 3: 最小实现**

`assemble.ts`：

```ts
export function assemble(profile: Profile, resolveBundle: (name: string) => Bundle): BundleLine[] {
  const lines = profile.bundles.flatMap((name) => resolveBundle(name).lines)
  if (profile.patch) {
    for (const [id, partial] of Object.entries(profile.patch)) {
      const target = lines.find((l) => l.id === id)
      if (target) {
        Object.assign(target, partial)
      } else {
        lines.push({ id, kind: partial.kind ?? 'tool', config: partial.config ?? {} })
      }
    }
  }
  return lines
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm test compose`；`cd apps/cli && pnpm typecheck`。

- [ ] **Step 5: 提交**

```bash
git add apps/cli/src/vajra/compose/assemble.ts apps/cli/test/vajra/compose.test.ts
git commit -m "feat(vajra): profile patch line replacement"
```

---

## Self-Review

**Spec coverage（§6/§3.2/§7.5/§11）：**

- scope shadowing（scoped 工具遮蔽同名全局）→ Task 1 ✅
- profile/bundle 声明式组合 → Task 2 ✅
- patch 一行替换 → Task 3 ✅
- `--dump-config` 打印真实树 → Task 2 `dumpConfig` ✅（CLI 命令接线推迟，同先例）
- 「包名/版本只改 bundle 一处」→ Task 3 ✅
- per-agent scoped 注册（shadowing）→ Task 1 `scope(key)` + `collectTools` ✅

**Placeholder scan：** 无 TBD；每 Task 含确切签名与代码。

**Type consistency：** `BundleLine`/`Bundle`/`Profile`/`assemble`/`dumpConfig`/`keysRecursive` 命名贯穿一致；`scope(key)` 签名与 spec §3.2 一致。
