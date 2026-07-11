# Mipham Code — 第三梯队体验与生态对标设计

> **版本**: 1.0.0 · **日期**: 2026-07-11
> **作者**: Zhang Guohua & Claude — One Mipham Corporation
> **对标基准**: Claude Code v2.1.207
> **前置依赖**: Tier 1 (Subagent/Skills/Hook/Context) + Tier 2 (Permission/Memory/AgentView/Workflow)
> **状态**: 设计已定稿

---

## 1. 概述

在 Tier 1（核心能力）和 Tier 2（差异化能力）基础上，构建 Mipham Code 的开发者体验与生态扩展层。

| 子系统        | 对标 Claude Code                  | Mipham 差异化                                 |
| ------------- | --------------------------------- | --------------------------------------------- |
| Plugins       | `/plugin` + zip/URL 加载          | 多模型插件：每个插件可指定首选 provider/model |
| Artifacts     | SSE 实时更新 + claude.ai 分享     | 本地 ngrok 隧道 + mipham.ai 云端发布          |
| Computer Use  | CLI 浏览器 + GUI 自动化           | 多平台（macOS/Linux/Windows）+ Playwright     |
| Vim/Safe/Goal | vim motions / --safe-mode / /goal | 中文友好 + 多模型 goal 执行                   |

---

## 2. 子系统一：Plugins 系统

### 2.1 插件格式

```
my-plugin.zip  (或 my-plugin/ 目录)
├── plugin.json
├── agents/
├── skills/
├── hooks/
└── mcp-servers/
```

### 2.2 plugin.json

```json
{
  "name": "security-audit",
  "version": "1.0.0",
  "description": "Automated security audit tools",
  "author": "dev@example.com",
  "license": "MIT",
  "miphamVersion": ">=0.5.0",
  "preferredProvider": "anthropic",
  "preferredModel": "claude-sonnet-5",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "./hooks/block-rm.sh" }]
      }
    ]
  }
}
```

### 2.3 CLI 命令

```bash
mipham plugin install <path|url|.zip>  # 安装
mipham plugin list                      # 列出
mipham plugin remove <name>             # 移除
mipham plugin enable <name>             # 启用
mipham plugin disable <name>            # 禁用
```

### 2.4 架构

```
apps/cli/src/plugin/
├── plugin-manager.ts     ← 安装/卸载/启用/禁用
├── plugin-loader.ts      ← 资源注入(agents+skills+hooks+mcp)
└── plugin-validator.ts   ← 安全验证 + 版本检查
```

### 2.5 安全验证

- 安装前审计：扫描 `plugin.json` 中的 hooks 命令
- 沙箱执行：hooks 脚本在受限环境中运行
- 版本兼容：`miphamVersion` 字段检查
- 签名验证（Phase 2）：可选 GPG 签名

---

## 3. 子系统二：Artifacts 实时分享

### 3.1 增强点

| 能力     | 当前           | 目标                                    |
| -------- | -------------- | --------------------------------------- |
| 更新方式 | 静态           | SSE 实时推送，AI 每次修改自动刷新浏览器 |
| 版本管理 | 无             | 自动快照，`/artifact diff` 查看变更     |
| 分享     | /artifact open | ngrok 隧道 + mipham.ai 云端发布         |

### 3.2 实时更新流程

```
AI 修改 artifact → ArtifactServer.update(name, content)
  → 保存版本快照到 ~/.mipham/artifacts/<name>/versions/vN.html
  → SSE 推送 { type: "update", version: N } 到连接浏览器
  → 浏览器自动刷新内容
```

### 3.3 架构变更

```
apps/cli/src/artifacts/
├── server.ts            ← 增强：SSE + 版本 + 分享端点
├── manifest.ts          ← 增强：版本历史
├── versioning.ts        ← 新增：自动快照 + diff
└── share.ts             ← 新增：ngrok 隧道 + 云端发布
```

---

## 4. 子系统三：Computer Use

### 4.1 三层能力

```
Layer 1: Screenshot + App Launch（优先级：立即）
  → 跨平台截图 + 原生应用启动

Layer 2: Browser Automation（优先级：立即）
  → Playwright 浏览器控制 + a11y snapshot

Layer 3: GUI Interaction（优先级：后续）
  → 原生鼠标点击 + 键盘输入
```

### 4.2 ComputerUse 工具

```typescript
Tool: ComputerUse
  screenshot          → 截图(base64)
  launch <app>        → 启动应用
  browser_navigate <url> → 浏览器导航
  browser_snapshot    → a11y tree
  browser_click <uid> → 点击元素
  browser_type <uid> <text> → 输入文本
```

### 4.3 架构

```
apps/cli/src/tools/computer/
├── computer-use.ts     ← 工具注册
├── screenshot.ts       ← 跨平台截图
├── app-launcher.ts     ← 应用启动
└── browser.ts          ← Playwright 浏览器自动化
```

### 4.4 安全约束

- `permission: ask` — 每次操作需用户批准
- 白名单应用 — 仅允许预配置的应用
- 禁止密码字段输入
- 30 秒超时限制

---

## 5. 子系统四：Vim / Safe Mode / /goal

### 5.1 Vim Motions

在 InputBar 中实现简易 Vim 模态（~150 行，无外部依赖）：

```
Normal 模式: h/j/k/l, w/b, 0/$, dd, yy, p/P, u/Ctrl-R, f<char>, /, ;/,
Insert 模式: Tab补全, Ctrl-W删词
```

### 5.2 Safe Mode

```bash
mipham --safe-mode  # 禁用所有自定义，仅内置默认
```

### 5.3 /goal 命令

```
/goal "所有测试通过"

→ AI 执行 → 检查条件 → 未达成 → 继续 → ... → 达成 → 停止
```

---

## 6. 验证标准

- [ ] `mipham plugin install <zip>` 正确加载 agents/skills/hooks
- [ ] SSE 端点推送 artifact 更新到浏览器
- [ ] `ComputerUse screenshot` 返回有效截图
- [ ] `mipham --safe-mode` 跳过所有自定义
- [ ] `/goal` 跨轮次循环直到条件满足
- [ ] Tier 1 + Tier 2 全部 483 测试继续通过

---

## 修订历史

| 版本  | 日期       | 变更     |
| ----- | ---------- | -------- |
| 1.0.0 | 2026-07-11 | 初始版本 |
