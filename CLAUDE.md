# CLAUDE.md

> **项目**: omc-project9 — Mipham Code（AI 编程终端）
> **公司**: One Mipham Corporation | 品牌: MiphamAI
> **产品**: 多模型开源智能编程终端
> **版本**: 1.0.0
> **最后更新**: 2026-06-02
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

| 层 | 技术 |
|---|------|
| CLI 运行时 | Bun 1.2+（推荐）/ Node.js 22+ |
| CLI 框架 | React 18 + Ink 5（终端 UI） |
| Web | Next.js 14 + React 18 + Tailwind CSS 3 |
| 语言 | TypeScript 5.5+（strict） |
| 包管理 | pnpm 9.15 |
| 测试 | Vitest 3（CLI）/ 测试框架待定（Web） |
| CI/CD | GitHub Actions（typecheck → lint → format → build → test） |
| 共享库 | @mipham/shared（types, constants） |

### Monorepo 结构

```
omc-project9-MiphamCode/
├── apps/
│   ├── cli/                    # CLI 终端（Bun + React/Ink）
│   │   ├── bin/mipham.ts       # 入口（commander）
│   │   ├── src/
│   │   │   ├── core/           # engine, context, permission, hooks, instructions
│   │   │   ├── providers/      # anthropic, openai-compat, registry, bootstrap
│   │   │   ├── tools/          # 16 个工具（file/exec/agent/network/system）
│   │   │   ├── skills/         # loader + standard/mipham 双轨运行时
│   │   │   ├── mcp/            # MCP 客户端（stub）
│   │   │   ├── config/         # loader + defaults
│   │   │   └── ui/             # app, chat, input, commands, picker
│   │   ├── skills/             # 11 个内置技能（9 standard + 2 mipham）
│   │   ├── test/               # 14 个测试文件，295 个测试
│   │   └── assets/             # icon.jpg, icon.icns
│   └── web/                    # Web 产品页（Next.js）
│       └── src/app/code/       # 6 个页面组件
├── packages/
│   └── shared/                 # 共享类型、常量（@mipham/shared）
├── infrastructure/
│   └── brew/mipham.rb          # Homebrew formula
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

| Provider | 类型 | 路由 |
|----------|------|------|
| anthropic | 原生（Anthropic SDK） | `providers/anthropic.ts` |
| deepseek | OpenAI 兼容 | `providers/openai-compat.ts` |
| doubao | OpenAI 兼容（ByteDance） | `providers/openai-compat.ts` |
| hunyuan | OpenAI 兼容（Tencent） | `providers/openai-compat.ts` |
| mipham | 待上线 | `providers/registry.ts`（已注册） |
| openai | OpenAI 兼容 | `providers/openai-compat.ts` |
| qwen | OpenAI 兼容 | `providers/openai-compat.ts` |

模型按能力等级排序（Ultra → Pro → Plus → Flash → Lite），Ctrl+P 调用两级选择器。

### 工具层（16 个工具）

| 分类 | 工具 |
|------|------|
| File（5） | read, write, edit, glob, grep |
| Exec（3） | bash, git, task |
| Agent（4） | agent, memory, plan, skill |
| Network（2） | web-fetch, web-search |
| System（2） | config, mcp |

### Skills 系统（11 个内置技能）

**Standard（9）**: code-review, compassionate-communication, doc-generator, github-ops, memory, self-review, superpower, tdd, web-search

**Mipham Exclusive（2）**: om-model-optimize, om-security

双轨运行时：standard 轨用于社区 Skills，mipham 轨用于 MiphamAI 专有功能。

### 核心引擎

- `engine.ts` — 对话引擎（消息管理、工具调用编排、SSE 流式输出）
- `context.ts` — 上下文管理（系统提示、历史压缩）
- `permission.ts` — 权限控制（工具执行许可）
- `hooks.ts` — 生命周期钩子
- `instructions.ts` — 指令加载链（Rismed_Ronxin → One_Mipham → omc-project9）

### MIPHAM.md 人格系统

v2.0.0，定义 AI 交互人格：和平、友好、友善、友爱、包容、耐心、温情。对所有连接的 AI 模型生效。

---

## 测试

| 层级 | 文件数 | 测试数 | 覆盖范围 |
|------|--------|--------|----------|
| Provider | 4 | 66 | anthropic, bootstrap, openai-compat, registry |
| Core | 3 | 60 | context, hooks, permission |
| Tools | 5 | 132 | agent, exec, file, network-system, skills |
| E2E | 1 | 8 | full-pipeline |
| **合计** | **14** | **295** | **0 失败** |

测试框架: Vitest 3，mock: `test/__mocks__/bun.ts`

---

## CI/CD

GitHub Actions 5 阶段流水线：`typecheck → lint → format → build-cli → test`

触发: push/PR to master/main

---

## 部署与分发

| 渠道 | 状态 | 说明 |
|------|------|------|
| curl 一键安装 | ✅ | `curl -fsSL https://mipham.ai/install.sh \| bash` |
| npm 全局安装 | 🔶 | `npm install -g @mipham/cli`（待发布） |
| Homebrew | 🔶 | formula 已写好（`infrastructure/brew/mipham.rb`），审核中 |
| macOS .app | 🔶 | .icns 已准备，待打包 |

---

## 页面路由（Web）

| 路由 | 组件 | 内容 |
|------|------|------|
| `/code` | page.tsx | 产品首页 |
| `/code/install` | page.tsx | 安装指南 |
| `/code/docs` | page.tsx | 文档 |
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

---

## 最近提交

| 日期 | Commit | 说明 |
|------|--------|------|
| 2026-05-31 | `b456be2` | assets: macOS .icns 图标（10 尺寸，16x16–1024x1024） |
| 2026-05-31 | `3cf5978` | revert: 移除文字品牌标记 — 图标仅用于桌面 .app |
| 2026-05-31 | `1da5ca1` | refactor: 品牌标记 ⬡ → 鼎 |
| 2026-05-31 | `5ecabe4` | fix: CLI --provider/--model flags 同步到 UI header |
| 2026-05-31 | `e7285b0` | feat: 终端品牌标识 + 20 条趣味状态消息 |
| 2026-05-31 | `0cf977a` | refactor: Provider 字母序，模型按能力等级排列 |
| 2026-05-31 | `d987dc5` | feat: Ctrl+P 交互式模型选择器（两级面板） |
| 2026-05-31 | `9348b0a` | feat: 新增 ByteDance Doubao + Tencent Hunyuan（7 家） |
| 2026-05-31 | `31cc1ea` | feat: compassionate-communication 人格框架 |
| 2026-05-31 | `7f3240b` | feat: 40+ Claude Code 兼容斜杠命令 |
| 2026-05-31 | `4db3eb0` | feat: 终端标题 + 欢迎横幅 + 三种安装方式 |
| 2026-05-31 | `ad048eb` | test: Skills 层测试（37 tests） |
| 2026-05-31 | `dd537ad` | test: Tool 层测试 + E2E 验证（132 tests，5 suites） |
| 2026-05-31 | `eaba42d` | test: Core 层单元测试（60 tests，3 suites） |
| 2026-05-31 | `591feeb` | test: Provider 层单元测试（66 tests，4 suites） |

---

## 下一步计划

1. **npm 发布** — @mipham/cli 发布至 npm registry
2. **MCP 客户端** — 完整 stdio 实现
3. **Web UI** — 完善产品页内容
4. **macOS .app** — 将 CLI 打包为 macOS 应用包（.icns 已就绪）
5. **CI/CD** — 接入自动化发布流水线

---

### 修订历史

| 版本 | 日期 | 变更内容 | 维护人 |
|------|------|---------|--------|
| 1.0.0 | 2026-06-02 | 初始创建：完整架构、15 commit 历史、测试矩阵、Provider 表、Skills 清单、CI/CD 流水线 | 技术委员会 |
