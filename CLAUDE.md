# CLAUDE.md

> **项目**: Mipham Code — AI 编程终端
> **仓库**: One-Mipham/mipham-code
> **公司**: One Mipham Corporation | 品牌: MiphamAI
> **产品**: 多模型开源智能编程终端
> **版本**: 2.0.2
> **最后更新**: 2026-08-13 — v0.32.6 输入换行规范化 + 同步 v0.32.2→v0.32.6 修订历史
> **维护人**: One Mipham Corporation 技术委员会

---

## 项目概述

Mipham Code 是开源（Apache 2.0）的多模型智能编程终端，基于 Bun + React/Ink（CLI）和 Next.js（Web）构建。通过统一接口支持 Anthropic Claude、OpenAI GPT、DeepSeek、Qwen、ByteDance Doubao、Tencent Hunyuan 以及 MiphamAI 自有模型，提供 SSE 流式响应、工具执行和可扩展技能系统。

### 品牌定位

- **产品名**: Mipham Code
- **品牌**: MiphamAI（One Mipham Corporation 旗下）
- **许可**: Apache 2.0（开源核心）
- **产品页**: https://mipham.ai/code
- **安装**: `curl -fsSL https://mipham.ai/install.sh | bash`

---

## 技术栈

| 层         | 技术                                                       |
| ---------- | ---------------------------------------------------------- |
| CLI 运行时 | Bun 1.2+（推荐）/ Node.js 22+                              |
| CLI 框架   | React 18 + Ink 5（终端 UI）                                |
| Web        | Next.js 14 + React 18 + Tailwind CSS 3                     |
| 语言       | TypeScript 5.5+（strict）                                  |
| 包管理     | pnpm 9.15                                                  |
| 测试       | Vitest 3（CLI）/ 测试框架待定（Web）                       |
| CI/CD      | GitHub Actions（typecheck → lint → format → build → test） |
| 共享库     | @mipham/shared（types, constants）                         |

### Monorepo 结构

```
mipham-code/
├── apps/
│   ├── cli/                    # CLI 终端（Bun + React/Ink）
│   │   ├── bin/mipham.ts       # 入口（commander）
│   │   ├── src/
│   │   │   ├── core/           # engine, context, permission, hooks, instructions, rules-loader
│   │   │   ├── providers/      # anthropic, openai-compat, registry, bootstrap
│   │   │   ├── tools/          # 30 个工具（file/exec/agent/network/system/scheduling/artifact/computer）
│   │   │   ├── skills/         # loader + standard/mipham 双轨运行时
│   │   │   ├── mcp/            # MCP 客户端 + Tool Search
│   │   │   ├── agent/          # 后台 Agent、消息总线、类型定义
│   │   │   ├── agent-view/     # Agent 会话管理 UI
│   │   │   ├── workflow/       # Workflow 运行时 + Schema 验证
│   │   │   ├── config/         # loader + defaults
│   │   │   └── ui/             # app, chat, input, commands, picker
│   │   ├── skills/             # 23 个内置技能（20 standard + 3 mipham）
│   │   ├── test/               # 57 个测试文件，1020 个测试
│   │   └── assets/             # icon.jpg, icon.icns
│   └── web/                    # Web 产品页（Next.js）
│       └── src/app/code/       # 6 个页面组件
├── packages/
│   └── shared/                 # 共享类型、常量（@mipham/shared）
├── infrastructure/
│   ├── brew/mipham.rb          # Homebrew formula
│   └── vscode/                 # VS Code 扩展（package.json + extension.js）
├── docs/superpowers/           # 设计规格 + 实施计划
├── install.sh                  # 一键安装脚本
└── MIPHAM.md                   # AI 人格定义 v2.0（compassionate communication）
```

---

## 开发命令

```bash
# CLI
cd apps/cli
pnpm dev          # bun run bin/mipham.ts（开发模式）
pnpm build        # bun build --compile（生产二进制）
pnpm test         # vitest run（295 个测试）
pnpm typecheck    # tsc --noEmit

# Web
cd apps/web
pnpm dev          # next dev
pnpm build        # next build
pnpm typecheck    # tsc --noEmit

# 根目录
pnpm -r typecheck # 全量类型检查
pnpm -r test      # 全量测试
pnpm lint         # ESLint
pnpm format       # Prettier
```

---

## 架构设计

### Provider 层（7 家，按字母序）

| Provider  | 类型                     | 路由                              |
| --------- | ------------------------ | --------------------------------- |
| anthropic | 原生（Anthropic SDK）    | `providers/anthropic.ts`          |
| deepseek  | OpenAI 兼容              | `providers/openai-compat.ts`      |
| doubao    | OpenAI 兼容（ByteDance） | `providers/openai-compat.ts`      |
| hunyuan   | OpenAI 兼容（Tencent）   | `providers/openai-compat.ts`      |
| mipham    | 待上线                   | `providers/registry.ts`（已注册） |
| openai    | OpenAI 兼容              | `providers/openai-compat.ts`      |
| qwen      | OpenAI 兼容              | `providers/openai-compat.ts`      |

模型按能力等级排序（Ultra → Pro → Plus → Flash → Lite），Ctrl+P 调用两级选择器。

### 工具层（30 个工具）

| 分类            | 工具                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------- |
| File（5）       | read, write, edit, glob, grep                                                                  |
| Exec（5）       | bash, git, task, EnterWorktree, ExitWorktree                                                   |
| Agent（9）      | agent, skill, plan, memory, workflow, EnterPlanMode, ExitPlanMode, ReportFindings, SendMessage |
| Network（2）    | web-fetch, web-search                                                                          |
| System（3）     | config, mcp, tool-search                                                                       |
| Artifact（1）   | artifact                                                                                       |
| Computer（1）   | computer-use                                                                                   |
| Scheduling（4） | schedule-wakeup, cron-create, cron-delete, cron-list                                           |

### Skills 系统（23 个内置技能）

**Standard（20）**: code-review, codebase-design, compassionate-communication, debug-loop, doc-generator, domain-modeling, github-ops, grill-with-docs, implement, memory, mipham-code-setup, research, security-review, self-review, superpower, systematic-debugging, tdd, to-spec, triage, web-access, web-search

**Mipham Exclusive（3）**: om-artifact, om-model-optimize, om-security

双轨运行时：standard 轨用于社区 Skills，mipham 轨用于 MiphamAI 专有功能。

### Slash 命令系统（89 个）

按分类分布：Session & Identity（21）、Workflow（16）、Tools & Skills（13）、Model & Provider（11）、Project（7）、Code Quality（5）、History（4）、GitHub（4）、Environment（4）、Account（3）、Agents（2）、Artifact（1）、Other（1）。

### 记忆系统

- **Memory 工具** — AI 可自主 `read`/`write`/`list` 持久化记忆
- **`/memory` 命令** — 用户查看所有已存记忆
- **自动分析引擎** — 对话后自动识别值得持久化的信息
- 存储位置：`~/.mipham/memory/*.md`（YAML frontmatter + Markdown）

### 核心引擎

- `engine.ts` — 对话引擎（消息管理、工具调用编排、SSE 流式输出、Rules 注入、后台任务通知）
- `context.ts` — 上下文管理（系统提示、历史压缩）
- `permission.ts` — 权限控制（6 级：default/acceptEdits/plan/auto/dontAsk/bypassPermissions）
- `hooks.ts` — 生命周期钩子（13 种事件，含 SubagentStart/Stop/PostToolUseFailure）
- `instructions.ts` — 指令加载链（Rismed_Ronxin → One_Mipham → mipham-code）
- `rules-loader.ts` — 路径作用域规则（.mipham/rules/\*.md → glob 匹配 → 自动注入）

### Agent 系统

- `sub-agent.ts` — 子代理执行（同步 + 后台异步，AbortController）
- `background-registry.ts` — 后台代理生命周期管理（spawn/get/list/stop/onComplete）
- `message-bus.ts` — 代理间消息队列（post/poll/read/unreadCount）
- `agent-context.ts` — 代理上下文 + 三级记忆加载（user/project/local）
- `types.ts` — AgentDefinition（含 memory 字段：user|project|local）

### MIPHAM.md 人格系统

v2.0.0，定义 AI 交互人格：和平、友好、友善、友爱、包容、耐心、温情。对所有连接的 AI 模型生效。

---

## 测试

| 层级     | 文件数 | 测试数   | 覆盖范围                                      |
| -------- | ------ | -------- | --------------------------------------------- |
| Provider | 4      | 66       | anthropic, bootstrap, openai-compat, registry |
| Core     | 3      | 60       | context, hooks, permission                    |
| Tools    | 5      | 132      | agent, exec, file, network-system, skills     |
| E2E      | 1      | 8        | full-pipeline                                 |
| Other    | 31     | 263      | commands, skills, scheduling, ui, memory 等   |
| **合计** | **79** | **1020** | **0 失败** ✅                                 |

测试框架: Vitest 3，mock: `test/__mocks__/bun.ts`

---

## CI/CD

GitHub Actions 5 阶段流水线：`typecheck → lint → format → build-cli → test`

触发: push/PR to master/main

---

## 部署与分发

| 渠道          | 状态 | 说明                                                      |
| ------------- | ---- | --------------------------------------------------------- |
| curl 一键安装 | ✅   | `curl -fsSL https://mipham.ai/install.sh \| bash`         |
| npm 全局安装  | ✅   | `npm install -g @miphamai/cli`                            |
| Homebrew      | 🔶   | formula 已写好（`infrastructure/brew/mipham.rb`），审核中 |
| macOS .app    | 🔶   | .icns 已准备，待打包                                      |

---

## 页面路由（Web）

| 路由              | 组件     | 内容     |
| ----------------- | -------- | -------- |
| `/code`           | page.tsx | 产品首页 |
| `/code/install`   | page.tsx | 安装指南 |
| `/code/docs`      | page.tsx | 文档     |
| `/code/dashboard` | page.tsx | 用户面板 |

---

## 关键约束

- CLI 运行时优先 Bun，兼容 Node.js 22+
- 所有 Provider 保持字母序排列
- MIPHAM.md 为 AI 人格权威来源，修改需记录版本变更
- 工具实现必须通过 permission 层审核
- Skills 文件后缀：standard 为 `.SKILL.md`，mipham 为 `.mipham-skill.md`
- 代码风格：ESLint（flat config）+ Prettier，CI 强制执行
- 提交信息遵循 Conventional Commits
- **安全拒绝**: 拒绝编写恶意代码、恶意软件相关文件；授权安全测试（渗透测试、CTF）例外
- **任务执行流程**: 搜索理解代码库 → 实现方案 → 验证测试 → lint/typecheck，每步有明确验证点
- **高效调用**: 多个独立工具调用应在同一批次并行发出，减少往返延迟
- **禁止自动提交**: 用户未明确要求时，不得自动执行 `git commit` 或 `git push`

---

## 最近提交

| 日期       | Commit     | 说明                                                                      |
| ---------- | ---------- | ------------------------------------------------------------------------- |
| 2026-08-11 | `10f4946`  | fix(ui): 工具逐个显示 — compactToolGroups 重写，与 Claude Code 显示对齐   |
| 2026-08-11 | `954ddcb`  | chore: bump version to 0.32.0 — Daemon 架构 5 阶段完成（超级智能体平台）  |
| 2026-08-11 | `59b3d69`  | feat(daemon): Phase 5 外部 API 安全（RateLimiter + CORS）                 |
| 2026-08-11 | `98025b5`  | feat(daemon): Phase 4 Goals + Schedules（GoalManager + cron 调度）        |
| 2026-08-11 | `31450368` | feat(daemon): Phase 3 Agent 系统（AgentManager + MessageBus）             |
| 2026-08-11 | `31448815` | feat(daemon): Phase 2 会话持久化（SessionWorker + RemoteEngine + attach） |
| 2026-08-11 | `31448815` | feat(daemon): Phase 1 核心基础设施（Bun.serve + SQLite + auth）           |
| 2026-08-10 | `9f349f5`  | chore: bump version to 0.27.0 — 3 Vibe Coding 摩擦点修复                  |

---

## 🏗️ 邻居项目（跨项目操作必读）

> ⚠️ 本仓库不是孤岛。以下项目与本项目紧密相关。

| 项目         | 目录                         | 角色          | 部署方式                |
| ------------ | ---------------------------- | ------------- | ----------------------- |
| **国内官网** | `../websites/domestic/`      | onemipham.com | `deploy-cn.sh` → 腾讯云 |
| **国际官网** | `../websites/international/` | mipham.ai     | `vercel deploy --prod`  |

### 共享数据源

```
packages/shared/src/package-info.ts   ← 包名/版本/安装命令 单一数据源
packages/shared/package-info.json     ← JSON 版本，供网站读取
```

**修改规则**：包名或版本号变更时，改上面两个文件 + 网站各自的 `src/config/package-info.json`。部署脚本 `deploy-cn.sh` 会自动从 mipham-code 同步 JSON。

### 部署依赖链

```
mipham-code 变更（包名/版本）
    ↓
1. 更新 packages/shared/package-info.ts + .json
2. npm publish（如新版本）
    ↓
3. 国内站: bash deploy-cn.sh（自动同步 JSON + 构建 + rsync + PM2）
4. 国际站: vercel deploy --prod
```

### 禁止事项

- ❌ 不要在网站项目中硬编码 `@miphamai/cli` 包名——应从 `@/config/package-info.json` 读取
- ❌ 不要手动修改网站中的安装命令——改 `package-info.ts` 后自动传播

---

## 下一步计划

1. **VS Code 扩展发布** — 发布到 VS Code Marketplace
2. **JetBrains 插件** — IntelliJ/WebStorm 终端集成
3. **MCP 深度集成** — OAuth 认证、动态工具更新、Tool Search 增强
4. **1M 上下文窗口** — 支持超长上下文模型
5. **macOS .app** — 将 CLI 打包为 macOS 应用包（.icns 已就绪）
6. **多语言国际化** — CLI 和 Web 的 i18n 支持
7. **Daemon 后台持久化** ✅ — 终端断开后 Agent 会话持续运行，支持无缝重连（`mipham attach`）
   - 5 阶段完成：核心基础设施 → 会话持久化 → Agent 系统 → Goals + Schedules → 外部 API 安全
   - 45 文件，~6000 行新代码，1115 测试，3.0 MB npm 包
   - 安全约束：worker 继承 6 级权限系统，不引入 IPython 自由执行模型

---

### 修订历史

| 版本  | 日期       | 变更内容                                                                                             | 维护人     |
| ----- | ---------- | ---------------------------------------------------------------------------------------------------- | ---------- |
| 2.0.2 | 2026-08-13 | v0.32.6 换行规范化（input onChange）+ 同步 v0.32.2→0.32.5：工具活动指示器、Header 精简、粘贴死锁修复 | 技术委员会 |
| 2.0.1 | 2026-08-11 | v0.32.1 工具逐个显示修复（compactToolGroups 重写），1115 测试，CI 绿                                 | 技术委员会 |
| 2.0.0 | 2026-08-11 | Daemon 后台持久化架构 5 阶段完成（45 文件，~6000 行），Mipham Code 进化为超级智能体平台              | 技术委员会 |
| 1.9.0 | 2026-08-11 | 下一步计划新增 Daemon 后台持久化架构（借鉴 prime-agent 评估结论），1020 测试，CI 绿                  | 技术委员会 |
| 1.8.0 | 2026-08-10 | v0.27.0：3 Vibe Coding 摩擦点修复 + 全面能力评估（综合 7.8/10），1020 测试，CI 绿                    | 技术委员会 |
| 1.7.0 | 2026-08-10 | v0.26.0：5 新 Skills + 批判性思维层，Skills 15→20，需求→交付链路 85% 覆盖                            | 技术委员会 |
| 1.6.0 | 2026-08-10 | v0.25.0：P0/P1/P2 安全对齐 Claude Code v2.1.222→v2.1.226，13 项修复，1020 测试                       | 技术委员会 |
| 1.5.0 | 2026-08-10 | 新增关键约束：任务执行流程（搜索→实现→验证→lint）、高效并行调用、禁止自动提交                        | 技术委员会 |
| 1.4.0 | 2026-08-05 | Sprint 5：Rules 系统、Agent Memory 三级、MCP Tool Search（30 工具）、VS Code 扩展                    | 技术委员会 |
| 1.3.0 | 2026-08-05 | v0.10.0 Sprint 1-4：29 工具、后台 Agent、Worktree、Plan Mode、6 级权限、642 测试                     | 技术委员会 |
| 1.2.0 | 2026-06-15 | 修正 Slash 命令（54→89）、Skills（11→15）、补充记忆系统、更新下一步计划                              | 技术委员会 |
| 1.1.0 | 2026-06-15 | 更新最近提交表为实际 git 历史（27 commits），补充迁移说明                                            | 技术委员会 |
| 1.0.0 | 2026-06-02 | 初始创建：完整架构、测试矩阵、Provider 表、Skills 清单、CI/CD 流水线                                 | 技术委员会 |
