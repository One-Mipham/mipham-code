# Mipham Code v0.16.0 — Claude Code v2.1.223 深度打磨

> **版本**: 1.0.0
> **日期**: 2026-08-06
> **状态**: 设计已确认，待实现计划
> **上一版本**: v0.15.0 (Claude Code v2.1.222 Security Parity, 730 tests)

---

## 概述

对照 Claude Code v2.1.223 的 19 条变更，对 Mipham Code 进行深度打磨。12 项改动覆盖安全修复、Bug 修复、产品对齐三个维度，分 P0/P1/P2 三个优先级。

---

## P0 — 安全修复（4 项）

### 1. Workflow 沙箱隔离

**问题**: `runtime.ts:147` 用 `new Function()` 执行 workflow 脚本，全局作用域全暴露。`eval`、`import()`、`require`、`process`、`Bun`、`fetch` 等均未封堵。

**方案**:

- 用 `vm.Script` + `vm.createContext(sandbox)` 替代 `new Function()`
- sandbox context 白名单注入：`agent`, `parallel`, `pipeline`, `verify`, `judge`, `loopUntilConvergence`, `phase`, `log`, `args`, `budget`
- 显式封堵：`eval`, `Function`, `import`, `require`, `process`, `Bun`, `fetch`, `setTimeout`, `setInterval`

**涉及文件**: `workflow/runtime.ts`, `workflow/sandbox.ts`
**新增测试**: 沙箱逃逸测试（eval/import/require/process.exit/Bun/fetch 各一条）

### 2. bypassPermissions 层级

**问题**: 引擎默认 `bypass`，无组织级禁用机制，`MODE_CYCLE` 始终包含 bypass。

**方案**:

- 新增 `PermissionRestrictions` 类型：`{ forbiddenModes: PermissionMode[], maxAllowedMode: PermissionMode }`
- 配置加载支持三级限制（组织 > 项目 > 用户，最严格生效）
- 引擎默认权限从 `'bypass'` 改为 `'ask'`
- `MODE_CYCLE` 根据 restrictions 动态排除 `bypassPermissions`
- 子代理继承父代理权限时受 restrictions 约束

**涉及文件**: `core/permission.ts`, `core/permission-config.ts`, `core/engine.ts`, `shared/types.ts`
**新增测试**: restrictions 继承链测试、MODE_CYCLE 排除测试

### 3. Bash 权限加固

**问题**: `isBlocked()` regex 可被 `$'\x72\x6d'` ANSI-C 转义序列绕过，嵌套 `bash -c`/`eval`/`source` 未封堵。

**方案**:

- 新增 `BLOCKED_PATTERNS` 条目：`\$'` (ANSI-C quoting), `\b(?:bash|sh|zsh)\s+-c\b`, `\beval\b`, `\bexec\b`, `\bsource\b`, `\bbase64\s+-d\b`
- 新增 `BLOCKED_COMMANDS`：嵌套解释器调用
- `isBlocked()` 先检查原始命令，再检查展开后的命令

**涉及文件**: `tools/exec/bash.ts`
**新增测试**: 转义序列绕过、嵌套 bash、base64 编码执行各一条

### 4. Unicode 净化

**问题**: 全代码库零 Unicode 净化，零宽字符和 bidi 控制字符可通过任何工具输入。

**方案**:

- 新增 `shared/sanitize.ts`：`stripDangerousUnicode(input: string): string`
- 剥离零宽字符：U+200B/C/D/E/F, U+FEFF, U+2060
- 剥离 bidi 控制字符：U+202A-E, U+2066-9
- 在 `tools/index.ts` 通用工具包装层统一净化所有工具输入
- 同时净化 UI 显示层

**涉及文件**: 新增 `shared/sanitize.ts`, `tools/index.ts`, `ui/app.tsx`
**新增测试**: 零宽注入、bidi 注入、混合注入各一条

---

## P1 — Bug 修复（3 项）

### 5. 会话恢复 — `/cd` 持久化 cwd

**问题**: `/cd` 改 `process.chdir()` 但不保存到 SessionStore，恢复会话后工作目录错误。

**方案**:

- `SessionData` 接口新增 `cwd?: string`
- `/cd` 执行后调用 `sessionStore.patch(sessionId, { cwd: resolved })`
- `/resume` 加载会话后 `process.chdir(session.cwd)`

**涉及文件**: `core/session-store.ts`, `ui/commands.ts`, `core/engine.ts`
**新增测试**: `/cd` 持久化 + 恢复测试

### 6. modelOverrides 验证

**问题**: 子代理模型 ID 零验证直传 API，不存在的模型静默失败。

**方案**:

- 模型解析时查 `ProviderRegistry.findModel(modelId)` 验证
- 不存在时：(a) 回退到父模型，(b) 发出 `model_restriction_warning` 通知
- workflow/fork 子代理同样适用

**涉及文件**: `agent/sub-agent.ts`, `agent/types.ts`
**新增测试**: 未知模型回退、受限模型警告各一条

### 7. `/review` 别名

**问题**: `/review` 只显示 `git diff` 输出，不调用 AI review，与命令描述不符。

**方案**:

- `/review` 改为 `/code-review` 的别名，共享 `gitDiffBridgeCmd` factory
- 删除旧的只读 git diff 实现

**涉及文件**: `ui/commands.ts`
**无需新增测试**: 别名行为由命令注册表覆盖

---

## P2 — 产品对齐（5 项）

### 8. 1M 窗口管控

**问题**: `ContextManager` 硬编码 `maxTokens: 200_000`，忽略模型声明的 `contextWindow`。

**方案**:

- `ContextManager` 构造时读取当前模型的 `contextWindow`
- 环境变量 `MIPHAM_DISABLE_1M_CONTEXT=1` 时强制 cap 200K
- 模型切换时动态更新 compaction 阈值
- 启动时若模型声明 1M 但被 cap 到 200K，打印警告

**涉及文件**: `core/index.tsx`, `core/context.ts`, `core/engine.ts`
**新增测试**: 1M 窗口使用、DISABLE 环境变量、模型切换阈值更新

### 9. 未知模型 auto-compact

**问题**: 不认识的模型 ID 上下文窗口无管控，会话可能膨胀超限。

**方案**:

- 模型不在注册表中时推定 `contextWindow: 128_000`
- 环境变量 `MIPHAM_ENABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=0` 恢复旧行为
- 启动时提示 `⚠ Unknown model "xxx": assuming 128K context window`

**涉及文件**: `core/context.ts`, `providers/registry.ts`
**新增测试**: 未知模型推定窗口、环境变量禁用

### 10. `/code-review` 记住上次级别

**问题**: effort 不持久化，每次 `/code-review` 默认 `high`。

**方案**:

- `setEffort()` 调用时写入 `config.set('lastCodeReviewEffort', level)`
- `/code-review` 不带参数时读取 `lastCodeReviewEffort`，默认为 `high`
- 带参数时（如 `/code-review max`）覆盖并保存

**涉及文件**: `ui/app.tsx`, `ui/commands.ts`
**新增测试**: effort 持久化、默认读取、带参数覆盖

### 11. Marketplace owner 通配符

**问题**: 无 marketplace 来源管控。

**方案**:

- 新增配置字段 `strictKnownMarketplaces?: string[]` 和 `blockedMarketplaces?: string[]`
- 支持 `"owner/*"` 通配符匹配 `github.com/owner/*`
- `installSkill()` 安装前检查来源

**涉及文件**: `skills/registry.ts`, `shared/types.ts`, `config/defaults.ts`
**新增测试**: owner 通配符匹配、block 优先级、strict 模式

### 12. 子代理模型限制警告

**问题**: 请求受限模型时静默使用父模型（与 P1 #6 关联）。

**方案**:

- 与 modelOverrides 验证合并实现
- 受限时通过 message bus 通知父代理
- UI 层显示警告信息

**涉及文件**: `agent/sub-agent.ts`, `agent/message-bus.ts`, `ui/app.tsx`
**新增测试**: 警告消息投递、UI 渲染

---

## 汇总

| 优先级   | 数量   | 预估代码量  | 预估测试增量 |
| -------- | ------ | ----------- | ------------ |
| P0       | 4      | ~220 行     | ~15 条       |
| P1       | 3      | ~50 行      | ~4 条        |
| P2       | 5      | ~110 行     | ~10 条       |
| **合计** | **12** | **~380 行** | **~29 条**   |

**目标**: 730 → 759 tests, 全通过, v0.16.0

---

## 不适用功能的后续规划

以下 Claude Code v2.1.223 功能 Mipham Code 暂无对应实现，列入后续专项：

| 功能                      | 可行性              | 建议时机 |
| ------------------------- | ------------------- | -------- |
| Gateway 模型发现          | 需 GCP/AWS SDK 集成 | v0.17+   |
| Managed settings env 合并 | 简单，可穿插        | v0.16.1  |
| Linux 沙箱                | 工程量大            | v0.18+   |
| Fork 代理竞态 guard       | 简单                | v0.16.1  |
| 诊断附件健壮性            | 需 LSP 基础设施     | v0.19+   |
| Git push 解析             | 简单                | v0.16.1  |
| Teleport 提示             | 需云端基础设施      | v0.20+   |
