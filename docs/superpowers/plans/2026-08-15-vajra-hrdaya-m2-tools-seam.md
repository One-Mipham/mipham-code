# Vajra-Hṛdaya M2 — 工具缝（ctx.tools seam）+ credentialConfig 注入 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `createToolRegistry()` 硬编码数组升级为 Vajra 能力缝（工具 = 可挂载 Service），并把 `read.ts`/`bash.ts` 的模块级 `credentialConfig` 全局走私改为 `inject: ['credentials']`。

**Architecture:** 工具缝 = Definition（`ToolDefinition` 接口）+ Provider（每个工具，普通工具为 `ToolDefinition` 对象、read/bash 为带注入的 `Service`）+ Consumer（engine 通过 `collectTools(ctx)` 从 Vajra `Context` 派生 `Map`）。给 Vajra `Context` 补一个 `keys()` 枚举方法；抽离 `withValidation` 到独立模块以打破 read/bash ↔ tools/index 的循环依赖；read/bash 改为「工厂函数 `createXxxTool(credentialConfig?)` + `inject:['credentials']` 的 `Service`」。engine 的 `this.tools: Map` 不变（仍由 `createToolRegistry(ctx)` 返回），strangler-fig 只换内置工具的来源。

**Tech Stack:** Bun 1.2+ / TypeScript 5.5+ strict / Vitest 3（globals:true）/ pnpm / Vajra-Hṛdaya 内核（M0 已落地 `apps/cli/src/vajra/`）

**Spec:** docs/superpowers/specs/2026-08-15-vajra-hrdaya-kernel-design.md（§五 能力缝、§7.4 M2）

## Global Constraints

- TypeScript strict；无分号；`noUncheckedIndexedAccess: true`（索引访问返回 `T | undefined`，必须判空）
- 测试框架 Vitest 3，`globals: true`；测试镜像 src 放在 `apps/cli/test/` 下同结构
- 包管理 pnpm；提交信息遵循 Conventional Commits
- lint/format 在 **仓库根目录**（`pnpm lint` / `pnpm format`），不是 `apps/cli`
- 禁止硬编码凭据/密钥/令牌；credential masking 配置来自 `config/defaults.ts` 的 `DEFAULT_CREDENTIAL_MASKING_CONFIG` 或 `loadCredentialMaskingConfig()`（运行时加载，非硬编码）
- 本仓库为 submodule（gitdir 在父仓库 `.git/modules/mipham-code`）；测试命令用绝对路径或从仓库根 `cd` 后执行
- **测试/typecheck 命令约定**：所有 `pnpm test` / `pnpm typecheck` 在 `apps/cli` 目录执行（`pnpm test [path]` 等价 `vitest run [path]`，可传多个测试文件路径）
- 工具实现必须通过 permission 层审核（本里程碑不触碰 permission 语义）
- `withValidation` 的语义不变：sanitizeParams → validateParams → execute

---

### Task 1: Vajra `Context.keys()` 枚举方法

**Files:**

- Modify: `apps/cli/src/vajra/context.ts`
- Test: `apps/cli/test/vajra/context.test.ts`

**Interfaces:**

- Produces: `Context.keys(): string[]` — 返回本 Context **本地**提供的服务键（不含 parent）；后续 Task 3 `collectTools` 依赖它枚举 `tool:*` 键

- [ ] **Step 1: Write the failing test**

在 `apps/cli/test/vajra/context.test.ts` 的顶层 `describe('Context')` 内新增：

```ts
it('enumerates locally provided keys', () => {
  const ctx = new Context()
  ctx.provide('a', 1)
  ctx.provide('tool:Read', { name: 'Read' })
  const keys = ctx.keys().sort()
  expect(keys).toEqual(['a', 'tool:Read'])
})

it('keys() does not include parent keys', () => {
  const parent = new Context()
  parent.provide('secret', true)
  const child = parent.scope('child')
  child.provide('local', 1)
  expect(child.keys()).toEqual(['local'])
})
```

（如文件顶层已有 `import { Context } from '../../src/vajra'`，复用即可。）

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/vajra/context.test.ts`
Expected: FAIL — `TypeError: ctx.keys is not a function`

- [ ] **Step 3: Write minimal implementation**

在 `apps/cli/src/vajra/context.ts` 的 `has(key)` 方法之后（第 96 行 `}` 之后）新增：

```ts
  keys(): string[] {
    return [...this.services.keys()]
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/vajra/context.test.ts`
Expected: PASS（含新增 2 用例）

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/vajra/context.ts apps/cli/test/vajra/context.test.ts
git commit -m "feat(vajra): add Context.keys() enumeration for service seams"
```

---

### Task 2: 抽离 `withValidation` 到 `src/tools/validation.ts`

**Files:**

- Create: `apps/cli/src/tools/validation.ts`
- Modify: `apps/cli/src/tools/index.ts`（删除 moved 的代码，改为 import）
- Test: `apps/cli/test/tools/param-validation.test.ts`（已有，无需改，验证无回归）

**Interfaces:**

- Produces: `validateParams(schema, params): string[]` 与 `withValidation(tool: ToolDefinition): ToolDefinition`（从 tools/index.ts 原样搬移，语义零变化）；read/bash（Task 4/5）与 tools/index.ts（Task 6）都从这里 import
- Consumes: `sanitizeParams`（`../shared/sanitize`）、i18n `createT`/`t`

- [ ] **Step 1: Create the new module**

新建 `apps/cli/src/tools/validation.ts`，内容为从 `tools/index.ts` 第 37–123 行原样搬移（bundles、`t`、`validateParams`、`withValidation`），仅把 `validateParams` 与 `withValidation` 改为 `export`：

```ts
import { sanitizeParams } from '../shared/sanitize'
import { createT } from '../i18n-core/t'
import enUS from '../i18n-core/locales/en-US.json'
import zhCN from '../i18n-core/locales/zh-CN.json'
import type { TranslationMap } from '../i18n-core/types'
import type { ToolDefinition, ToolResult } from '../shared'

const bundles: Record<string, TranslationMap> = {
  'en-US': enUS as TranslationMap,
  'zh-CN': zhCN as TranslationMap,
}
const t = createT(bundles['en-US'] || (enUS as TranslationMap), enUS as TranslationMap)

/**
 * Validate tool parameters against the tool's JSON Schema definition.
 * Returns an array of error messages (empty = valid).
 */
export function validateParams(
  schema: Record<string, unknown>,
  params: Record<string, unknown>,
): string[] {
  const errors: string[] = []

  const required = schema.required as string[] | undefined
  if (required) {
    for (const field of required) {
      if (params[field] === undefined || params[field] === null) {
        errors.push(t('errors.missing_param', { param: field }))
      }
    }
  }

  const properties = schema.properties as
    Record<string, { type: string; enum?: string[] }> | undefined
  if (properties) {
    for (const [key, def] of Object.entries(properties)) {
      const value = params[key]
      if (value === undefined || value === null) continue

      switch (def.type) {
        case 'string':
          if (typeof value !== 'string') errors.push(t('errors.type_string', { key }))
          else if (def.enum && !def.enum.includes(value)) {
            errors.push(t('errors.type_enum', { key, values: def.enum.join(', ') }))
          }
          break
        case 'integer':
        case 'number':
          if (typeof value !== 'number') errors.push(t('errors.type_number', { key }))
          break
        case 'boolean':
          if (typeof value !== 'boolean') errors.push(t('errors.type_boolean', { key }))
          break
        case 'object':
          if (typeof value !== 'object' || Array.isArray(value)) {
            errors.push(t('errors.type_object', { key }))
          }
          break
        case 'array':
          if (!Array.isArray(value)) errors.push(t('errors.type_array', { key }))
          break
      }
    }
  }

  return errors
}

/**
 * Wrap a tool's execute with parameter validation.
 */
export function withValidation(tool: ToolDefinition): ToolDefinition {
  const schema = tool.parameters as Record<string, unknown>
  if (!schema || !schema.properties) return tool

  return {
    ...tool,
    async execute(params, ctx): Promise<ToolResult> {
      const cleanParams = sanitizeParams(params)
      const errors = validateParams(schema, cleanParams)
      if (errors.length > 0) {
        return {
          success: false,
          content: '',
          error: t('errors.invalid_params', { errors: errors.join('; ') }),
        }
      }
      return tool.execute(cleanParams, ctx)
    },
  }
}
```

- [ ] **Step 2: Remove moved code from tools/index.ts**

删除 `apps/cli/src/tools/index.ts` 第 2–5 行（`sanitizeParams` import、`createT`、`enUS`、`zhCN`、`TranslationMap` import）、第 37–41 行（`bundles`/`t`）、第 43–123 行（`validateParams`/`withValidation`），改为在顶部 import 区新增：

```ts
import { withValidation } from './validation'
```

（`ToolResult` 类型 import 若仅被 `withValidation` 使用，可随删除；保留 `ToolDefinition` 类型 import，Task 6 仍用到。）

- [ ] **Step 3: Run test to verify no regression**

Run: `pnpm test test/tools/param-validation.test.ts`
Expected: PASS（3 用例，验证 `withValidation` 行为不变）

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`（或从仓库根 `pnpm -r typecheck` 定位 apps/cli 包）
Expected: 无类型错误

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/tools/validation.ts apps/cli/src/tools/index.ts
git commit -m "refactor(tools): extract withValidation to shared validation module"
```

---

### Task 3: 工具缝基础 `src/tools/seam.ts`

**Files:**

- Create: `apps/cli/src/tools/seam.ts`
- Test: `apps/cli/test/tools/seam.test.ts`

**Interfaces:**

- Produces:
  - `toolKey(name: string): string` — 返回 `tool:${name}`
  - `toolService(tool: ToolDefinition): Service` — 把普通 ToolDefinition 包装成 Vajra Service（apply 时 `ctx.provide(toolKey(tool.name), tool)`）
  - `collectTools(ctx: Context): Map<string, ToolDefinition>` — 枚举 `ctx.keys()` 中 `tool:` 前缀键，派生 name→definition 的 Map
- Consumes: Task 1 的 `Context.keys()`；`ToolDefinition` 类型（`../shared`）；`Service` 类型（`../vajra`）

- [ ] **Step 1: Write the failing test**

新建 `apps/cli/test/tools/seam.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { Context } from '../../src/vajra'
import type { ToolDefinition } from '../../src/shared'
import { toolKey, toolService, collectTools } from '../../src/tools/seam'
import { withValidation } from '../../src/tools/validation'

const readTool: ToolDefinition = {
  name: 'Read',
  description: 'read a file',
  category: 'file',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: { file_path: { type: 'string' } },
    required: ['file_path'],
  },
  execute: async () => ({ success: true, content: 'ok' }),
}

describe('tool seam', () => {
  it('toolKey prefixes with tool:', () => {
    expect(toolKey('Read')).toBe('tool:Read')
  })

  it('mounts a tool service and collects it', () => {
    const ctx = new Context()
    ctx.mount(toolService(withValidation(readTool)))
    const tools = collectTools(ctx)
    expect(tools.has('Read')).toBe(true)
    expect(tools.get('Read')!.name).toBe('Read')
  })

  it('adds a new tool by mounting a service — no index.ts edit', () => {
    const ctx = new Context()
    const custom: ToolDefinition = {
      name: 'CustomTool',
      description: 'a plugin tool',
      category: 'system',
      permission: 'auto',
      parameters: {},
      execute: async () => ({ success: true, content: 'custom' }),
    }
    ctx.mount(toolService(withValidation(custom)))
    const tools = collectTools(ctx)
    expect(tools.has('CustomTool')).toBe(true)
    expect(tools.has('Read')).toBe(false)
  })

  it('ignores non-tool keys when collecting', () => {
    const ctx = new Context()
    ctx.provide('credentials', { enabled: false })
    ctx.provide('tool:Read', readTool)
    const tools = collectTools(ctx)
    expect(tools.size).toBe(1)
    expect(tools.has('Read')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/tools/seam.test.ts`
Expected: FAIL — `Cannot find module '../../src/tools/seam'`

- [ ] **Step 3: Write minimal implementation**

新建 `apps/cli/src/tools/seam.ts`：

```ts
import type { Context, Service } from '../vajra'
import type { ToolDefinition } from '../shared'

/** 工具服务键前缀。一个已挂载工具以 `tool:<name>` 注册于 Context。 */
export const toolKey = (name: string): string => `tool:${name}`

/** 把普通 ToolDefinition 包装成 Vajra Service（无注入依赖）。 */
export function toolService(tool: ToolDefinition): Service {
  return {
    apply(ctx) {
      ctx.provide(toolKey(tool.name), tool)
    },
  }
}

/** 从 Context 已挂载的工具服务派生 name → definition 的 Map（engine 消费）。 */
export function collectTools(ctx: Context): Map<string, ToolDefinition> {
  const map = new Map<string, ToolDefinition>()
  for (const key of ctx.keys()) {
    if (!key.startsWith('tool:')) continue
    const tool = ctx.get<ToolDefinition>(key)
    if (tool) map.set(tool.name, tool)
  }
  return map
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/tools/seam.test.ts`
Expected: PASS（4 用例）

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/tools/seam.ts apps/cli/test/tools/seam.test.ts
git commit -m "feat(tools): add Vajra tool seam (toolService + collectTools)"
```

---

### Task 4: read.ts 升缝 — `createReadTool` 工厂 + `readToolService` 注入

**Files:**

- Modify: `apps/cli/src/tools/file/read.ts`
- Test: `apps/cli/test/tools/file.test.ts`（改 import + 新增注入用例）

**Interfaces:**

- Produces:
  - `createReadTool(credentialConfig?: CredentialMaskingConfig): ToolDefinition` — 纯工厂（execute 内用闭包参数 `credentialConfig`，不再读模块全局）
  - `readToolService: Service` — `inject: ['credentials']`，apply 时 `ctx.get('credentials')` 后 `ctx.provide(toolKey('Read'), withValidation(createReadTool(config)))`
- Consumes: Task 2 的 `withValidation`；Task 3 的 `toolKey`；`Service` 类型（`../../vajra`）
- **删除**：模块全局 `credentialConfig` + `setCredentialMaskingConfigForRead`（不再有 setter 走私）

- [ ] **Step 1: Write the failing test**

在 `apps/cli/test/tools/file.test.ts` 顶部改 import：

```ts
import { createReadTool, readToolService } from '../../src/tools/file/read'
```

在其下新增一个无掩码默认实例（供既有用例复用，语义 = 不带 credential 配置）：

```ts
const readTool = createReadTool()
```

（既有 `readTool.name`/`readTool.execute(...)` 等用例全部保持原样，因为 `createReadTool()` 返回的 ToolDefinition 与原来结构一致。）

在同一 describe 内新增注入门控用例：

```ts
describe('readToolService (credential injection)', () => {
  it('does not mount without credentials (inject gating)', () => {
    const ctx = new Context()
    const mounted = ctx.mount(readToolService)
    expect(mounted.status()).toBe('inactive')
    expect(collectTools(ctx).has('Read')).toBe(false)
  })

  it('mounts once credentials are provided', () => {
    const ctx = new Context()
    const mounted = ctx.mount(readToolService)
    ctx.provide('credentials', {
      enabled: true,
      files: [],
      output_scrubbing: { enabled: true, patterns: [] },
      env_filter: { enabled: true, patterns: [] },
    })
    expect(mounted.status()).toBe('active')
    expect(collectTools(ctx).has('Read')).toBe(true)
  })
})
```

顶部 import 区补：

```ts
import { Context } from '../../src/vajra'
import { collectTools } from '../../src/tools/seam'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/tools/file.test.ts`
Expected: FAIL — `Cannot find name 'createReadTool'` / `'readToolService'`

- [ ] **Step 3: Write minimal implementation**

改写 `apps/cli/src/tools/file/read.ts`：

1. 顶部 import 改为：

```ts
import { readFileSync, existsSync, statSync } from 'node:fs'
import type { ToolDefinition, CredentialMaskingConfig } from '../../shared/index.ts'
import { resolveSafe } from '../../security/path'
import type { Service } from '../../vajra'
import { toolKey } from '../seam'
import { withValidation } from '../validation'
```

2. 删除第 5–10 行（注释 + `let credentialConfig` + `setCredentialMaskingConfigForRead`）。

3. 把 `export const readTool: ToolDefinition = {` 改为 `export function createReadTool(credentialConfig?: CredentialMaskingConfig): ToolDefinition {\n  return {`，并在文件末尾 `}` 之后补 `\n}` 闭合工厂。

   > 关键点：函数参数命名为 `credentialConfig`（与原模块全局同名），因此 `execute` 体内第 52/55 行的 `credentialConfig` 引用**无需改动**，自动经闭包解析到参数。

4. 在文件末尾追加 service：

```ts
export const readToolService: Service = {
  inject: ['credentials'],
  apply(ctx) {
    const credentialConfig = ctx.get<CredentialMaskingConfig>('credentials')
    ctx.provide(toolKey('Read'), withValidation(createReadTool(credentialConfig)))
  },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/tools/file.test.ts`
Expected: PASS（既有用例 + 新增注入门控 2 用例）

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/tools/file/read.ts apps/cli/test/tools/file.test.ts
git commit -m "feat(tools): read.ts seam — inject credentials, drop module-global smuggling"
```

---

### Task 5: bash.ts 升缝 — `createBashTool` 工厂 + `bashToolService` 注入

**Files:**

- Modify: `apps/cli/src/tools/exec/bash.ts`
- Test: `apps/cli/test/tools/exec.test.ts`、`apps/cli/test/tools/bash.test.ts`（改 import + 新增注入用例）

**Interfaces:**

- Produces: `createBashTool(credentialConfig?: CredentialMaskingConfig): ToolDefinition`、`bashToolService: Service`（`inject: ['credentials']`）
- Consumes: Task 2 `withValidation`、Task 3 `toolKey`、`Service` 类型
- **保留不变**：`isBlocked`（第 107 行）、`detectViolations`（第 155 行）、`BLOCKED_PATTERNS`、`sanitizeCommand` import、`DANGEROUS_GIT_PATTERNS` import
- **删除**：第 6 行 `let credentialConfig` + 第 8–10 行 `setCredentialMaskingConfigForBash`

- [ ] **Step 1: Write the failing test**

`apps/cli/test/tools/exec.test.ts` 第 3 行改为：

```ts
import { createBashTool } from '../../src/tools/exec/bash'
```

其下新增 `const bashTool = createBashTool()`（既有 `bashTool.name`/`bashTool.execute` 等用例保持原样）。

`apps/cli/test/tools/bash.test.ts` 第 3 行改为：

```ts
import { createBashTool, detectViolations } from '../../src/tools/exec/bash'
```

其下新增 `const bashTool = createBashTool()`（既有 `bashTool.execute` 用例保持原样；`detectViolations` 不变）。

在 `bash.test.ts` 内新增注入门控用例（import `Context` + `collectTools` + `bashToolService`）：

```ts
describe('bashToolService (credential injection)', () => {
  it('does not mount without credentials, mounts after provide', () => {
    const ctx = new Context()
    const mounted = ctx.mount(bashToolService)
    expect(mounted.status()).toBe('inactive')
    expect(collectTools(ctx).has('Bash')).toBe(false)

    ctx.provide('credentials', {
      enabled: true,
      files: [],
      output_scrubbing: { enabled: true, patterns: [] },
      env_filter: { enabled: true, patterns: [] },
    })
    expect(mounted.status()).toBe('active')
    expect(collectTools(ctx).has('Bash')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/tools/exec.test.ts test/tools/bash.test.ts`
Expected: FAIL — `Cannot find name 'createBashTool'`

- [ ] **Step 3: Write minimal implementation**

改写 `apps/cli/src/tools/exec/bash.ts`：

1. 顶部 import 追加：

```ts
import type { Service } from '../../vajra'
import { toolKey } from '../seam'
import { withValidation } from '../validation'
```

2. 删除第 5–10 行（注释 + `let credentialConfig` + `setCredentialMaskingConfigForBash`）。

3. 把第 301 行 `export const bashTool: ToolDefinition = {` 改为：

```ts
export function createBashTool(credentialConfig?: CredentialMaskingConfig): ToolDefinition {
  return {
```

并在文件末尾（第 433 行 `}` 之后）补 `\n  }\n}` 闭合工厂。

> 函数参数命名 `credentialConfig` 与模块全局同名，`execute` 内第 360/362/382/384/392/393 行的 `credentialConfig` 引用自动经闭包解析到参数，无需改动。

4. 在文件末尾追加：

```ts
export const bashToolService: Service = {
  inject: ['credentials'],
  apply(ctx) {
    const credentialConfig = ctx.get<CredentialMaskingConfig>('credentials')
    ctx.provide(toolKey('Bash'), withValidation(createBashTool(credentialConfig)))
  },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/tools/exec.test.ts test/tools/bash.test.ts`
Expected: PASS（既有用例 + 新增注入门控用例）

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/tools/exec/bash.ts apps/cli/test/tools/exec.test.ts apps/cli/test/tools/bash.test.ts
git commit -m "feat(tools): bash.ts seam — inject credentials, drop module-global smuggling"
```

---

### Task 6: tools/index.ts — `createToolRegistry(ctx)` 升缝

**Files:**

- Modify: `apps/cli/src/tools/index.ts`
- Test: `apps/cli/test/tools/param-validation.test.ts`（改 import，无默认参数变化）、新增 `apps/cli/test/tools/registry.test.ts`

**Interfaces:**

- Produces: `createToolRegistry(ctx: Context = defaultToolContext()): Map<string, ToolDefinition>` — 挂载 read/bash service + 其余 30 个普通工具 `toolService(withValidation(tool))`，返回 `collectTools(ctx)`
- Consumes: Task 2 `withValidation`、Task 3 `toolService`/`collectTools`、Task 4 `readToolService`、Task 5 `bashToolService`、`DEFAULT_CREDENTIAL_MASKING_CONFIG`（`../config/defaults`）
- `defaultToolContext()`：新建 `Context` 并 `provide('credentials', DEFAULT_CREDENTIAL_MASKING_CONFIG)`，保证无参调用时 read/bash 仍挂载（backward compat）

- [ ] **Step 1: Write the failing test**

新建 `apps/cli/test/tools/registry.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { Context } from '../../src/vajra'
import { createToolRegistry } from '../../src/tools/index'
import { collectTools } from '../../src/tools/seam'
import { DEFAULT_CREDENTIAL_MASKING_CONFIG } from '../../src/config/defaults'

describe('createToolRegistry (seam)', () => {
  it('returns all built-in tools by default (incl. Read/Bash)', () => {
    const registry = createToolRegistry()
    expect(registry.has('Read')).toBe(true)
    expect(registry.has('Bash')).toBe(true)
    expect(registry.size).toBeGreaterThanOrEqual(30)
  })

  it('mounts into a caller-provided context so plugins can add tools', () => {
    const ctx = new Context()
    ctx.provide('credentials', DEFAULT_CREDENTIAL_MASKING_CONFIG)
    createToolRegistry(ctx)
    // 挂一个插件工具，不改 tools/index.ts
    ctx.mount({
      apply(applyCtx) {
        applyCtx.provide('tool:CustomPluginTool', {
          name: 'CustomPluginTool',
          description: 'plugin',
          category: 'system',
          permission: 'auto',
          parameters: {},
          execute: async () => ({ success: true, content: 'ok' }),
        })
      },
    })
    const tools = collectTools(ctx)
    expect(tools.has('CustomPluginTool')).toBe(true)
    expect(tools.has('Read')).toBe(true)
  })
})
```

（`apps/cli/test/tools/param-validation.test.ts` 无需改动 —— `createToolRegistry()` 默认参数仍可用。）

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/tools/registry.test.ts`
Expected: FAIL — `createToolRegistry` 当前不接受 ctx 参数，且未挂载进 ctx

- [ ] **Step 3: Write minimal implementation**

改写 `apps/cli/src/tools/index.ts`：

1. 顶部 import 区改为（保留 32 个工具 import；`readTool`→`readToolService`、`bashTool`→`bashToolService`；删除已抽离的 i18n/sanitize import）：

```ts
import type { ToolDefinition } from '../shared/index.ts'
import type { Context } from '../vajra'
import { withValidation } from './validation'
import { toolService, collectTools } from './seam'
import { readToolService } from './file/read'
import { writeTool } from './file/write'
import { editTool } from './file/edit'
import { globTool } from './file/glob'
import { grepTool } from './file/grep'
import { bashToolService } from './exec/bash'
import { gitTool } from './exec/git'
import { taskTool } from './exec/task'
import { enterWorktreeTool } from './exec/enter-worktree'
import { exitWorktreeTool } from './exec/exit-worktree'
import { agentTool } from './agent/agent'
import { skillTool } from './agent/skill'
import { planTool } from './agent/plan'
import { enterPlanModeTool } from './agent/enter-plan'
import { exitPlanModeTool } from './agent/exit-plan'
import { memoryTool } from './agent/memory'
import { workflowTool } from './agent/workflow'
import { webFetchTool } from './network/web-fetch'
import { webSearchTool } from './network/web-search'
import { configTool } from './system/config'
import { mcpTool } from './system/mcp'
import { toolSearchTool } from './system/tool-search'
import { artifactTool } from './artifact/artifact'
import { reportFindingsTool } from './agent/report-findings'
import { sendMessageTool } from './agent/send-message'
import { listAgentsTool } from './agent/list-agents'
import { computerUseTool } from './computer/computer-use'
import { scheduleWakeupTool } from './scheduling/schedule-wakeup.js'
import { cronCreateTool, cronDeleteTool, cronListTool } from './scheduling/cron.js'
import { DEFAULT_CREDENTIAL_MASKING_CONFIG } from '../config/defaults'
```

2. 删除 `validateParams`、`withValidation`（已移入 validation.ts）、`bundles`/`t`。

3. 把 `createToolRegistry()` 替换为：

```ts
function defaultToolContext(): Context {
  const ctx = new Context()
  ctx.provide('credentials', DEFAULT_CREDENTIAL_MASKING_CONFIG)
  return ctx
}

export function createToolRegistry(
  ctx: Context = defaultToolContext(),
): Map<string, ToolDefinition> {
  // 普通工具：包 withValidation 后作为 Service 挂载
  const plainTools: ToolDefinition[] = [
    // File tools
    writeTool,
    editTool,
    globTool,
    grepTool,
    // Exec tools
    gitTool,
    taskTool,
    enterWorktreeTool,
    exitWorktreeTool,
    // Agent tools
    agentTool,
    skillTool,
    planTool,
    enterPlanModeTool,
    exitPlanModeTool,
    memoryTool,
    workflowTool,
    reportFindingsTool,
    sendMessageTool,
    listAgentsTool,
    // Network tools
    webFetchTool,
    webSearchTool,
    // System tools
    configTool,
    mcpTool,
    toolSearchTool,
    // Artifact tools
    artifactTool,
    // Computer Use tools
    computerUseTool,
    // Scheduling tools
    scheduleWakeupTool,
    cronCreateTool,
    cronDeleteTool,
    cronListTool,
  ]
  for (const tool of plainTools) {
    ctx.mount(toolService(withValidation(tool)))
  }
  // 注入工具（credentials 依赖）：read + bash
  ctx.mount(readToolService)
  ctx.mount(bashToolService)

  return collectTools(ctx)
}
```

> 注意：`readTool` 与 `bashTool` 不再作为普通 `ToolDefinition` 出现在 `plainTools` 数组——它们改由 `readToolService`/`bashToolService` 挂载（注入 credentials）。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/tools/registry.test.ts test/tools/param-validation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/tools/index.ts apps/cli/test/tools/registry.test.ts
git commit -m "feat(tools): createToolRegistry(ctx) mounts tools as Vajra services"
```

---

### Task 7: index.tsx 接线 — Context + provide credentials

**Files:**

- Modify: `apps/cli/src/index.tsx`
- Test: 全量测试套件（`pnpm test`）

**Interfaces:**

- Consumes: Task 6 `createToolRegistry(ctx)`；`Context`（`./vajra`）；`loadCredentialMaskingConfig`（已 import，`./config/loader`）
- **删除**：`setCredentialMaskingConfigForRead`/`setCredentialMaskingConfigForBash` 的动态 import + 调用（第 496–500 行）

- [ ] **Step 1: Write the failing test**

无新增单测（本任务为启动接线，由全量套件 + typecheck 覆盖）。改动点：

- [ ] **Step 2: Reorder credential loading before registry creation**

`apps/cli/src/index.tsx` 第 437–438 行（`// Create tool registry ...` 注释 + `const tools = createToolRegistry()`）改为：

```ts
// Initialize credential masking pipeline (strategies: Full, Extract, JWT)
const { initializePipeline } = await import('./core/credential-masker/index')
initializePipeline()

// Load credential masking config and inject it into the tool seam
const credentialMaskingConfig = loadCredentialMaskingConfig()
const toolContext = new Context()
toolContext.provide('credentials', credentialMaskingConfig)

// Create tool registry with all built-in tools (mounted as Vajra services)
const tools = createToolRegistry(toolContext)
```

并在顶部 import 区新增：

```ts
import { Context } from './vajra'
```

（`createToolRegistry` 的 import 已存在于第 35 行。）

- [ ] **Step 3: Remove the old setter wiring**

删除第 495–500 行（`// Wire credential masking configuration into tools` 注释 + `const credentialMaskingConfig = ...` + 两个动态 import + 两个 setter 调用）——注意第 496 行 `loadCredentialMaskingConfig()` 已上移到 Step 2；第 492–493 行 `initializePipeline()` 也已上移。确保不重复执行 `initializePipeline` / `loadCredentialMaskingConfig`。

- [ ] **Step 4: Run full suite + typecheck**

Run: `pnpm test` 与 `pnpm typecheck`
Expected: 全量测试绿（预期 1360+，无失败；2 个既有 oauth `it.skip` 保持跳过）；typecheck 无错

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/index.tsx
git commit -m "feat(cli): wire tool seam context + inject credentials at startup"
```

---

## Self-Review

**Spec coverage（§7.4 + §五）:**

- ✅ `ctx.tools` 工具注册缝：Task 3（seam）+ Task 6（createToolRegistry(ctx)）——工具成为可挂载 Service
- ✅ 「加一个工具不改 index.ts」测试：Task 3 `adds a new tool by mounting a service` + Task 6 `mounts into a caller-provided context`
- ✅ `read.ts` credentialConfig 全局走私 → `inject: ['credentials']`：Task 4（read）+ Task 5（bash，同型病灶）
- ⏳ `ctx.llm`（ProviderRegistry 缝）与 `ctx.skills`（技能缝）——**本里程碑明确推迟**（M2b/M2c，strangler-fig 逐缝切换）
- ⏳ provider 换实现测试（llm-replay）——依赖 ctx.llm 缝，推迟

**Placeholder scan:** 无 TBD/TODO；每任务含具体代码与测试。

**Type consistency:** `toolKey`/`toolService`/`collectTools` 在 Task 3 定义，Task 4/5/6 引用一致；`withValidation` 在 Task 2 定义并 export，Task 3/4/5/6 引用一致；`createReadTool`/`readToolService`（Task 4）、`createBashTool`/`bashToolService`（Task 5）由 Task 6 import，命名一致；`Context.keys()`（Task 1）由 Task 3 的 `collectTools` 消费。

**风险与回退：** 全部改动 strangler-fig——engine 的 `this.tools: Map` 接口不变；MCP 工具经 `registerMcpServerTools(server.name, tools)` 追加到返回的 Map 的路径不变（Map 仍可变）。若 Task 7 接线出错，回退到 `createToolRegistry()` 无参调用即可（默认 ctx 提供 credentials）。
