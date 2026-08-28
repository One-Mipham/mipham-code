# 底部绿色更新提示设计

> **日期**: 2026-08-28
> **作者**: Guohua Zhang · One Mipham Corporation
> **术语**: 更新提示 = 终端底部状态栏的绿色通知；异步检查 = 非阻塞版本检测（fetch 替代 execSync npm view）；「Update installed · Restart to apply」= 更新已装到磁盘、运行进程仍旧版、需重启生效

---

## 一、背景与动机

用户反馈：Claude Code 底部状态栏右侧有绿色 `✔ Update installed · Restart to apply` 提示。希望 Mipham Code 也能在终端对话窗口底部显示更新状态。

现状：

- `apps/cli/src/shared/update.ts` 已有 `checkForUpdates()`（`execSync('npm view …')` 查 registry，**阻塞式**，含 npm→npmmirror 镜像回退）与 `performUpdate()`（`npm install -g`）。
- `/upgrade` 斜杠命令已接线（`commands.ts` upgradeCmd），但只把结果当文字消息返回，不写 UI 状态。
- `PACKAGE_VERSION`（`packages/shared/src/package-info.ts`）是硬编码的运行版本真源，随发版递增。
- `CommandContext`（commands.ts:83）已有「命令改 App 状态」的回调范式（`setSessionTitle`/`setFocusMode`/`setGoal`…）。

缺的是：**非阻塞的启动版本检查** + **底部绿色通知** + **「Restart to apply」状态**。

---

## 二、目标与非目标

**目标**：

1. `update.ts` 加 `checkForUpdatesAsync()`——非阻塞 fetch 版版本检查（替代阻塞 `npm view`），registry npm→npmmirror 回退。
2. `app.tsx` 底部状态栏加绿色通知：有新版 → `✔ Update available · vX.Y.Z`；`/upgrade` 装完 → `✔ Update installed · Restart to apply`。
3. `/upgrade` 装完后通过 `CommandContext` 回调把状态写进 UI。

**非目标**：

- ❌ 后台**自动**下载/安装（完整 auto-updater）——Mipham Code 更新是手动的（`/upgrade` 或 `mipham update`），自动改全局 npm 包有风险。
- ❌ 启动时检测「外部 `mipham update` 装过但未重启」——编译二进制下 `getCurrentVersion()`（读 package.json）不可靠（`import.meta.dirname` 在 `bun build --compile` 下无 package.json），rabbit hole，回访触发。
- ❌ 更新进度条 / 下载百分比——只在「已装待重启」与「有新版」两态间切换。

---

## 三、核心设计

### 3.1 异步版本检查 `update.ts`

```typescript
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

/** 非阻塞版本检查。离线/失败 → available=false（不惊扰用户）。 */
export async function checkForUpdatesAsync(): Promise<UpdateCheck> {
  const current: string = PACKAGE_VERSION
  let latest: string = current
  let available = false
  try {
    latest = await fetchLatestVersionAsync()
    available = compareVersions(latest, current) > 0
  } catch {
    // offline → treat as up-to-date
  }
  return { current, latest, available }
}
```

复用现有 `UpdateCheck` 接口、`compareVersions`、`REGISTRIES` 常量。`current` 用 `PACKAGE_VERSION`（硬编码运行版本，编译二进制下也可靠），区别于同步版 `getCurrentVersion()`（读 package.json）。

### 3.2 状态机（app.tsx）

```typescript
type UpdateStatus =
  | { state: 'available'; latest: string } // 有新版，未装
  | { state: 'installed'; latest: string } // 已装待重启
```

- 启动（useEffect 一次性）：`checkForUpdatesAsync()` → `available` 时 `setUpdateStatus({ state: 'available', latest })`。
- `/upgrade` 成功：`ctx.setUpdateStatus({ state: 'installed', latest })`。

### 3.3 底部绿色通知（app.tsx 状态栏）

在 `GraftStatusLine` 之后、`Status line`（权限模式行）之前渲染，**右对齐**（`flexDirection="row" justifyContent="flex-end" width="100%"`，带 `✔` 前缀，绿色）：

```typescript
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

### 3.4 `/upgrade` 命令接线

`CommandContext` 加回调 `setUpdateStatus: (s: UpdateStatus) => void`。`upgradeCmd` 的 `performUpdate(update.latest)` 成功分支里加 `ctx.setUpdateStatus({ state: 'installed', latest: update.latest })`。

---

## 四、i18n

`apps/cli/src/i18n-core/locales/{en-US,zh-CN}.json` 的 `ui.status` 加两键：

- `update_available`: `"Update available · v{version}"` / `"有新版 · v{version}"`
- `update_installed_restart`: `"Update installed · Restart to apply"` / `"更新已安装 · 重启生效"`

---

## 五、里程碑

| 里程碑 | 内容                                                           | 交付物     |
| ------ | -------------------------------------------------------------- | ---------- |
| **A1** | `update.ts` 异步检查 + 单元测试（mock fetch）                  | 可测纯逻辑 |
| **A2** | app.tsx 状态 + 启动检查 + 底部绿通知 + commands.ts 回调 + i18n | 端到端可跑 |

一个 plan 两阶段（A2 依赖 A1 的 `checkForUpdatesAsync` 导出与 `UpdateCheck` 接口）。

---

## 六、测试

- **A1**：`checkForUpdatesAsync` mock `fetch`——返回 `{ version: '9.9.9' }` 且 `available: true`；返回当前版本 → `false`；fetch 全失败 → `false`（离线兜底）；npmmirror 回退（npm 抛错 → 走镜像）。
- **A2**：typecheck + 现有全量无回归（UI 组件测试不设先例，核心逻辑 A1 覆盖）。
- **无回归**：现有 1987 测试全绿。

---

## 七、风险与决策

| #   | 决策                                                      | 选了                          | 理由                                                                                                      |
| --- | --------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | `current` 用 `PACKAGE_VERSION` 还是 `getCurrentVersion()` | `PACKAGE_VERSION`             | 硬编码运行版本，编译二进制下可靠；`getCurrentVersion()` 读 package.json 在 `bun build --compile` 下不可靠 |
| 2   | fetch 还是 `npm view`                                     | fetch                         | 非阻塞（`npm view` 是 `execSync` 阻塞）；registry `/latest` 端点返回 `{version}`                          |
| 3   | 「installed」状态来源                                     | `/upgrade` 成功回调           | 诚实（命令刚装完，磁盘已新、进程仍旧）；不碰编译二进制的磁盘版本检测 rabbit hole                          |
| 4   | 超时                                                      | `AbortSignal.timeout(10_000)` | 每个 registry 10s 上限，离线快速失败                                                                      |
