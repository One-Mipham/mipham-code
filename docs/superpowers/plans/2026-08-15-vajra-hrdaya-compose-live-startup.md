# Vajra-Hṛdaya gap③ — compose live startup 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 三处 compose/live-startup 收尾：① `Context.dispose()` 未清理 `scopes` 缓存（内存泄漏）；② `loadBundle`/`loadProfile` 无 schema 校验（坏 YAML 静默变空/缺字段）；③ `mipham --dump-config` CLI 未接（打印真实组装树）。

**Architecture:** 三处独立小改：① 内核 `context.ts` dispose 清 `scopes`；② `compose/bundle.ts` 加运行时 shape 校验（坏数据 fail-loud 抛错，不静默）；③ `bin/mipham.ts` 加 `--dump-config [--profile <name>]` 顶层 flag，读 `~/.mipham/profiles/<name>.yml` + 同目录 bundle，`assemble` + `dumpConfig` 打印。

**Tech Stack:** TypeScript 5.5+ strict（ESM）、Bun/Node 22+、Vitest 3、yaml。

**Spec:** `docs/superpowers/specs/2026-08-15-vajra-hrdaya-kernel-design.md`（§6 声明式组合、§3.2 scope、§11 成功标准）

## Global Constraints

- TS strict + ESM；Vitest 3；不硬编码凭据；Conventional Commits；中文注释风格；不 dispatch 子代理（implementer）。
- profile/bundle 存 `~/.mipham/profiles/`（profile `<name>.yml`，bundle 同目录 `<name>.yml`）；`--dump-config` 默认 profile 名 `default`。
- schema 校验 fail-loud（抛错）而非静默回退——坏配置应在启动时报错（「宿主不崩」针对 service.apply 抛错，配置解析错误是另一类，应 fail-loud）。
- 测试命令：`cd apps/cli && pnpm test`；typecheck：`cd apps/cli && pnpm typecheck`。
- 分支 `feat/vajra-hrdaya-compose-live-startup`。

---

## Task 1: Context.dispose 清理 scopes 缓存

**Files:**

- Modify: `apps/cli/src/vajra/context.ts`
- Test: `apps/cli/test/vajra/context.test.ts`

**Interfaces:**

- Produces: `Context.dispose()` 额外清空 `this.scopes`。

- [ ] **Step 1: 写失败测试**

`apps/cli/test/vajra/context.test.ts` 追加：

```ts
it('dispose clears scoped child contexts', () => {
  const root = new Context()
  const child = root.scope('agent-x')
  root.dispose()
  const again = root.scope('agent-x')
  expect(again).not.toBe(child) // dispose 后重开，非缓存旧 child
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm test context`
Expected: FAIL——dispose 后 `scope('agent-x')` 仍返回缓存的 `child`。

- [ ] **Step 3: 最小实现**

`apps/cli/src/vajra/context.ts` 的 `dispose()` 里，在 `this.services.clear()` 后加：

```ts
this.scopes.clear()
```

（`this.scopes` 是 `private scopes = new Map<unknown, Context>()`，dispose 后应清空使重开返回新 child。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm test context`；`cd apps/cli && pnpm typecheck`。

- [ ] **Step 5: 提交**

```bash
git add apps/cli/src/vajra/context.ts apps/cli/test/vajra/context.test.ts
git commit -m "fix(vajra): Context.dispose clears scope cache"
```

---

## Task 2: loadBundle/loadProfile schema 校验

**Files:**

- Modify: `apps/cli/src/vajra/compose/bundle.ts`
- Test: `apps/cli/test/vajra/compose.test.ts`

**Interfaces:**

- Produces: `loadBundle`/`loadProfile` 解析后校验 shape，坏数据抛 `Error`（描述缺失字段）。

- [ ] **Step 1: 写失败测试**

`apps/cli/test/vajra/compose.test.ts` 追加：

```ts
it('loadBundle throws on missing lines array', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bad-bundle-'))
  const p = join(dir, 'bad.yml')
  writeFileSync(p, 'name: b\n') // 无 lines 字段
  expect(() => loadBundle(p)).toThrow(/lines/)
  rmSync(dir, { recursive: true, force: true })
})

it('loadProfile throws on non-array bundles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bad-profile-'))
  const p = join(dir, 'bad.yml')
  writeFileSync(p, 'name: p\nbundles: not-an-array\n')
  expect(() => loadProfile(p)).toThrow(/bundles/)
  rmSync(dir, { recursive: true, force: true })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm test compose`
Expected: FAIL——`loadBundle`/`loadProfile` 静默接受，不抛错。

- [ ] **Step 3: 最小实现**

`apps/cli/src/vajra/compose/bundle.ts`：`loadBundle`/`loadProfile` 解析后加校验。`loadBundle`：

```ts
export function loadBundle(path: string): Bundle {
  const raw = readFileSync(path, 'utf-8')
  const data = parseYaml(raw) as { name?: unknown; lines?: unknown }
  if (data.lines !== undefined && !Array.isArray(data.lines)) {
    throw new Error(`bundle "${path}": "lines" must be an array`)
  }
  return {
    name: typeof data.name === 'string' ? data.name : path,
    lines: (data.lines ?? []) as BundleLine[],
  }
}
```

`loadProfile`：

```ts
export function loadProfile(path: string): Profile {
  const raw = readFileSync(path, 'utf-8')
  const data = parseYaml(raw) as { name?: unknown; bundles?: unknown; patch?: unknown }
  if (data.bundles !== undefined && !Array.isArray(data.bundles)) {
    throw new Error(`profile "${path}": "bundles" must be an array`)
  }
  return {
    name: typeof data.name === 'string' ? data.name : path,
    bundles: (data.bundles ?? []) as string[],
    patch: data.patch as Profile['patch'] | undefined,
  }
}
```

（`lines` 缺省仍回退 `[]`（现有测试依赖空 lines 合法），但 `lines` 非数组则抛错；`bundles` 同理。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm test compose`；`cd apps/cli && pnpm typecheck`。

- [ ] **Step 5: 提交**

```bash
git add apps/cli/src/vajra/compose/bundle.ts apps/cli/test/vajra/compose.test.ts
git commit -m "feat(vajra): loadBundle/loadProfile schema validation (fail-loud)"
```

---

## Task 3: mipham --dump-config CLI

**Files:**

- Modify: `apps/cli/bin/mipham.ts`
- Test: `apps/cli/test/vajra/compose.test.ts`（或新 CLI 测试，就近验证 `dumpConfig`+`assemble` 输出已覆盖）

**Interfaces:**

- Produces: `mipham --dump-config [--profile <name>]` 顶层 flag——读 `~/.mipham/profiles/<name>.yml` + 同目录 bundle，`assemble` + `dumpConfig` 打印到 stdout。

- [ ] **Step 1: 写失败测试**

`apps/cli/test/vajra/compose.test.ts` 追加（验证组装→dump 的真实输出形状，不直接测 CLI 进程）：

```ts
it('dumpConfig of an assembled profile prints one tab-separated line per line', () => {
  const b: Bundle = {
    name: 'orchestration',
    lines: [{ id: 'plan-runner', kind: 'service', config: { model: 'gpt-4o' } }],
  }
  const lines = assemble({ name: 'default', bundles: ['orchestration'] }, () => b)
  const dumped = dumpConfig(lines)
  expect(dumped).toContain('plan-runner\tservice')
  expect(dumped).toContain('"model":"gpt-4o"')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm test compose`
Expected: FAIL——若无此断言则直接过（报告 DONE_WITH_CONCERNS，注明 CLI flag 无单测，靠现有 dumpConfig 覆盖）。

- [ ] **Step 3: 最小实现**

`apps/cli/bin/mipham.ts` 的 `main()` 里，在 `--version`/`--help` 处理后、`--safe-mode` 前，加：

```ts
// ── Dump config flag ───────────────────────────────────────────────────────
if (process.argv.includes('--dump-config')) {
  const { homedir } = await import('node:os')
  const { join } = await import('node:path')
  const { existsSync } = await import('node:fs')
  const { loadProfile, loadBundle, assemble, dumpConfig } = await import('../src/vajra/compose')

  const profileIdx = process.argv.indexOf('--profile')
  const profileName =
    profileIdx !== -1 && process.argv[profileIdx + 1] ? process.argv[profileIdx + 1]! : 'default'
  const dir = join(homedir(), '.mipham', 'profiles')
  const profilePath = join(dir, `${profileName}.yml`)

  if (!existsSync(profilePath)) {
    console.error(`Profile "${profileName}" not found at ${profilePath}`)
    process.exit(1)
  }

  const profile = loadProfile(profilePath)
  const resolveBundle = (name: string) => loadBundle(join(dir, `${name}.yml`))
  console.log(dumpConfig(assemble(profile, resolveBundle)))
  process.exit(0)
}
```

并在 `KNOWN_COMMANDS` 列表的 flag 说明（`--help` 文本的 Flags 段）加一行 `  --dump-config            Print the assembled profile tree`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm test` 全量；`cd apps/cli && pnpm typecheck`；`cd apps/cli && pnpm build`（确认编译通过）。

- [ ] **Step 5: 提交**

```bash
git add apps/cli/bin/mipham.ts apps/cli/test/vajra/compose.test.ts
git commit -m "feat(cli): --dump-config prints assembled profile tree"
```

---

## Self-Review

**Spec coverage（§6/§3.2/§11）：**

- `--dump-config` 打印真实组装树 → Task 3 ✅
- scope scopes 随 dispose 清理 → Task 1 ✅
- loadBundle/loadProfile schema 校验 → Task 2 ✅

**Placeholder scan：** 无 TBD；每 Task 含确切代码与测试。

**Type consistency：** `loadBundle`/`loadProfile` 返回类型不变（只加运行时校验）；`dumpConfig`/`assemble` 复用；`--profile` 默认 `default` 贯穿一致。

**Deferred（不在本轮）**：gap① replaceMessages/emergencyDrain 日志；gap② 生产 mount 接线。`--dump-config` 的 profile 路径解析仅 CLI 层（不引入配置层单源，YAGNI）。
