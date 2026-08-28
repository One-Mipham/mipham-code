# 底部绿色更新提示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 终端底部状态栏加绿色更新提示——启动异步查 npm 最新版，有新版显示 `✔ Update available · vX.Y.Z`；`/upgrade` 装完显示 `✔ Update installed · Restart to apply`。

**Architecture:** `update.ts` 加非阻塞 `checkForUpdatesAsync()`（fetch 替代阻塞 `npm view`）；`app.tsx` 加 `updateStatus` 状态 + 启动检查 + 底部绿通知 + `CommandContext.setUpdateStatus` 回调；`/upgrade` 成功回调写「installed」态。

**Tech Stack:** Bun、Vitest 3、TypeScript strict、Ink 5。

**Spec:** `docs/superpowers/specs/2026-08-28-update-notification-design.md`

## Global Constraints

- 非阻塞：`checkForUpdatesAsync` 用 fetch（`AbortSignal.timeout(10_000)`），**不得**用阻塞 `execSync npm view`。
- 诚实：绿色提示只报「有新版」与「已装待重启」两态，不假称「已自动安装」（更新仍是手动 `/upgrade` / `mipham update`）。
- 离线兜底：fetch 全失败 → `available: false`，不惊扰用户。
- `current` 用 `PACKAGE_VERSION`（`apps/cli/src/shared/package-info.ts`，编译期常量，二进制下可靠），**不用** `getCurrentVersion()`（读 package.json，`bun build --compile` 下不可靠）。
- 提交信息 Conventional Commits + `Co-Authored-By: Mipham <noreply@mipham.ai>`。
- 测试：`cd apps/cli && pnpm vitest run <file>`；typecheck：`cd apps/cli && pnpm typecheck`；全量：`cd apps/cli && pnpm test`。

---

## File Structure

| 文件                                        | 动作   | 职责                                                                              |
| ------------------------------------------- | ------ | --------------------------------------------------------------------------------- |
| `apps/cli/src/shared/update.ts`             | Modify | Task A1：`UpdateStatus` 类型 + `fetchLatestVersionAsync` + `checkForUpdatesAsync` |
| `apps/cli/test/shared/update-async.test.ts` | Create | Task A1：mock fetch 单测                                                          |
| `apps/cli/src/ui/app.tsx`                   | Modify | Task A2：`updateStatus` 状态 + 启动检查 + 底部绿通知 + `setUpdateStatus` 回调     |
| `apps/cli/src/ui/commands.ts`               | Modify | Task A2：`CommandContext` 加 `setUpdateStatus` + `upgradeCmd` 成功回调            |
| `apps/cli/src/i18n-core/locales/en-US.json` | Modify | Task A2：`ui.status.update_available` / `update_installed_restart`                |
| `apps/cli/src/i18n-core/locales/zh-CN.json` | Modify | Task A2：同上两键                                                                 |

---

## Task A1: `update.ts` 异步检查 + 测试

**Files:**

- Modify: `apps/cli/src/shared/update.ts`
- Test: `apps/cli/test/shared/update-async.test.ts`（新建）

**Interfaces:**

- Consumes: `PACKAGE_VERSION`（`./package-info`）、现有私有 `compareVersions`（同文件）、现有 `UpdateCheck` 接口（同文件）
- Produces:
  - `export type UpdateStatus = { state: 'available' | 'installed'; latest: string }`
  - `export async function checkForUpdatesAsync(): Promise<UpdateCheck>`

- [ ] **Step 1: 写失败测试**

`apps/cli/test/shared/update-async.test.ts`（新建）：

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { checkForUpdatesAsync } from '../../src/shared/update'
import { PACKAGE_VERSION } from '../../src/shared/package-info'

afterEach(() => {
  vi.unstubAllGlobals()
})

function mockFetchResponse(version: string) {
  return { ok: true, json: async () => ({ version }) }
}

describe('checkForUpdatesAsync', () => {
  it('有新版 → available: true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockFetchResponse('9.9.9')),
    )
    const r = await checkForUpdatesAsync()
    expect(r.available).toBe(true)
    expect(r.latest).toBe('9.9.9')
  })

  it('同版本 → available: false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockFetchResponse(PACKAGE_VERSION)),
    )
    const r = await checkForUpdatesAsync()
    expect(r.available).toBe(false)
  })

  it('离线/失败 → available: false（兜底不惊扰）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    const r = await checkForUpdatesAsync()
    expect(r.available).toBe(false)
  })

  it('npm 失败 → npmmirror 回退', async () => {
    const mock = vi.fn(async (url: string) => {
      if (url.includes('registry.npmjs.org')) throw new Error('npm down')
      return mockFetchResponse('9.9.9')
    })
    vi.stubGlobal('fetch', mock)
    const r = await checkForUpdatesAsync()
    expect(r.available).toBe(true)
    expect(r.latest).toBe('9.9.9')
    expect(mock).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/shared/update-async.test.ts`
Expected: FAIL（`checkForUpdatesAsync` 不存在）。

- [ ] **Step 3: 实现 `update.ts`**

在 `import { homedir } from 'node:os'` 之后加 import：

```typescript
import { PACKAGE_VERSION } from './package-info'
```

在 `getConfigPath()` 函数之后（`compareVersions` 之前）加：

```typescript
/** 更新提示状态：有新版（未装）| 已装待重启。 */
export type UpdateStatus = { state: 'available' | 'installed'; latest: string }

/** registry /latest 端点（返回 {version}），npm → npmmirror 回退。 */
const LATEST_URLS = [
  'https://registry.npmjs.org/@miphamai%2fcli/latest',
  'https://registry.npmmirror.com/@miphamai%2fcli/latest',
]

/** fetch 拉最新版本，npm → npmmirror 回退（超时 10s/个）。 */
async function fetchLatestVersionAsync(): Promise<string> {
  let lastError: unknown = null
  for (const url of LATEST_URLS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { version?: string }
      if (data.version) return data.version
      throw new Error('no version in response')
    } catch (err) {
      lastError = err
    }
  }
  throw lastError ?? new Error('Failed to fetch latest version')
}

/** 非阻塞版本检查。current 用 PACKAGE_VERSION（编译期常量，二进制下可靠）。离线/失败 → available: false。 */
export async function checkForUpdatesAsync(): Promise<UpdateCheck> {
  const current: string = PACKAGE_VERSION
  let latest: string = current
  let available = false
  try {
    latest = await fetchLatestVersionAsync()
    available = compareVersions(latest, current) > 0
  } catch {
    // offline → treat as up-to-date (don't alarm the user)
  }
  return { current, latest, available }
}
```

（注：`compareVersions` 是私有函数，`checkForUpdatesAsync` 与它在同文件，可直接调用。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm vitest run test/shared/update-async.test.ts`
Expected: PASS（4 测试绿）。

- [ ] **Step 5: typecheck**

Run: `cd apps/cli && pnpm typecheck` → 0 error。

- [ ] **Step 6: Commit**

```bash
cd /Users/sarvadaya/Rismed_Ronxin_Capital/One_Mipham_Corporation/mipham-code && git add apps/cli/src/shared/update.ts apps/cli/test/shared/update-async.test.ts
git commit -m "feat(ui): 非阻塞版本检查 checkForUpdatesAsync——fetch + 镜像回退 + 离线兜底

Co-Authored-By: Mipham <noreply@mipham.ai>"
```

---

## Task A2: app.tsx 状态 + 底部绿通知 + commands.ts 回调 + i18n

**Files:**

- Modify: `apps/cli/src/ui/app.tsx`
- Modify: `apps/cli/src/ui/commands.ts`
- Modify: `apps/cli/src/i18n-core/locales/en-US.json`
- Modify: `apps/cli/src/i18n-core/locales/zh-CN.json`

**Interfaces:**

- Consumes: `checkForUpdatesAsync`、`UpdateStatus`（`../shared/update`，Task A1 产出）
- Produces: `CommandContext.setUpdateStatus`（回调）、底部绿色通知渲染

- [ ] **Step 1: `app.tsx` 改造**

**1a. import**（`import { GraftStatusLine } from './graft-status'` 之后加）：

```typescript
import { checkForUpdatesAsync, type UpdateStatus } from '../shared/update'
```

**1b. 状态**（`const [pickerOpen, setPickerOpen] = useState(false)` 之后加）：

```typescript
const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
```

**1c. 启动检查**（`const [pickerOpen, ...]` 之后，或任何 `useEffect` 区，一次性）：

```typescript
// 启动后台查新版（非阻塞；离线静默失败）
useEffect(() => {
  let cancelled = false
  checkForUpdatesAsync().then((update) => {
    if (!cancelled && update.available) {
      setUpdateStatus({ state: 'available', latest: update.latest })
    }
  })
  return () => {
    cancelled = true
  }
}, [])
```

**1d. `CommandContext` 回调**（`setUltracodeMode: (on) => setUltracodeMode(on),` 之后加）：

```typescript
      setUpdateStatus: (s: UpdateStatus) => setUpdateStatus(s),
```

**1e. 底部绿通知**（`<GraftStatusLine ... />` 之后、`{/* Status line — Claude Code style */}` 之前加）：

```typescript
            {/* Update notification — green, right-aligned, mirrors Claude Code's "Update installed · Restart to apply" */}
            {updateStatus && (
              <Box marginTop={1} flexDirection="row" justifyContent="flex-end" width="100%">
                <Text color="green">
                  {updateStatus.state === 'installed'
                    ? `✔ ${t('ui.status.update_installed_restart')}`
                    : `✔ ${t('ui.status.update_available', { version: updateStatus.latest })}`}
                </Text>
              </Box>
            )}
```

- [ ] **Step 2: `commands.ts` 改造**

**2a. import**（顶部静态 import 区加）：

```typescript
import type { UpdateStatus } from '../shared/update'
```

**2b. `CommandContext` 接口**（`setUltracodeMode: (on: boolean) => void` 之后加）：

```typescript
  setUpdateStatus: (s: UpdateStatus) => void
```

**2c. `upgradeCmd` 成功分支**（`if (ok) {` 块内、`lines.push('')` 之前加）：

```typescript
ctx.setUpdateStatus({ state: 'installed', latest: update.latest })
```

（注：`setUpdateStatus` 与 `setGoal`/`setFocusMode` 同为必填回调 + 直接调用，无 `?.`；`mkCtx()` 测试 stub 用 `as unknown as` cast，不因新增必填字段报 typecheck 错，且无 `/upgrade` 测试触发 runtime undefined。）

- [ ] **Step 3: i18n 两键**

`apps/cli/src/i18n-core/locales/en-US.json` 的 `ui.status` 对象加：

```json
      "update_available": "Update available · v{version}",
      "update_installed_restart": "Update installed · Restart to apply"
```

`apps/cli/src/i18n-core/locales/zh-CN.json` 的 `ui.status` 对象加：

```json
      "update_available": "有新版 · v{version}",
      "update_installed_restart": "更新已安装 · 重启生效"
```

- [ ] **Step 4: typecheck**

Run: `cd apps/cli && pnpm typecheck`
Expected: 0 error。

- [ ] **Step 5: 全量回归**

Run: `cd apps/cli && pnpm test`
Expected: 全绿（A1 的 4 测试 + 现有 1987 无回归）。

- [ ] **Step 6: Commit**

```bash
cd /Users/sarvadaya/Rismed_Ronxin_Capital/One_Mipham_Corporation/mipham-code && git add apps/cli/src/ui/app.tsx apps/cli/src/ui/commands.ts apps/cli/src/i18n-core/locales/en-US.json apps/cli/src/i18n-core/locales/zh-CN.json
git commit -m "feat(ui): 底部绿色更新提示——启动检查 + /upgrade 成功回写 Restart to apply

Co-Authored-By: Mipham <noreply@mipham.ai>"
```

---

## Self-Review

- **Spec 覆盖**：§3.1 → Task A1 Step 3；§3.2 → A2 Step 1b/1c/1d；§3.3 → A2 Step 1e；§3.4 → A2 Step 2b/2c；§四 → A2 Step 3；§六 → A1 Step 1。
- **占位符扫描**：无 TBD；每步给完整代码。
- **类型一致性**：`UpdateStatus` 在 A1 定义（update.ts），A2 的 app.tsx/commands.ts 消费同名同形；`checkForUpdatesAsync` 签名 A1/A2 一致。
- **非阻塞**：`checkForUpdatesAsync` 全程 fetch（`AbortSignal.timeout`），无 `execSync`（§Global Constraints）。
- **诚实**：只报 available/installed 两态，不假称自动安装（§Global Constraints）。
