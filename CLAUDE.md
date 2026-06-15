# CLAUDE.md

> **项目**: omc-project9 — Mipham Code（AI 编程终端）
> **公司**: One Mipham Corporation | 品牌: MiphamAI
> **产品**: 多模型开源智能编程终端
> **版本**: 1.1.0
> **最后更新**: 2026-06-15
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

### 工具层（16 个工具）

| 分类         | 工具                          |
| ------------ | ----------------------------- |
| File（5）    | read, write, edit, glob, grep |
| Exec（3）    | bash, git, task               |
| Agent（4）   | agent, memory, plan, skill    |
| Network（2） | web-fetch, web-search         |
| System（2）  | config, mcp                   |

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

| 层级     | 文件数 | 测试数  | 覆盖范围                                      |
| -------- | ------ | ------- | --------------------------------------------- |
| Provider | 4      | 66      | anthropic, bootstrap, openai-compat, registry |
| Core     | 3      | 60      | context, hooks, permission                    |
| Tools    | 5      | 132     | agent, exec, file, network-system, skills     |
| E2E      | 1      | 8       | full-pipeline                                 |
| **合计** | **14** | **295** | **0 失败**                                    |

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
| npm 全局安装  | 🔶   | `npm install -g @mipham/cli`（待发布）                    |
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

---

## 最近提交

> 共 27 个 commit，从独立仓库初始化至今。早期内联开发阶段的 15 个 commit 在迁移 squash 中压缩为 `27609bf`。

| 日期       | Commit    | 说明                                                                      |
| ---------- | --------- | ------------------------------------------------------------------------- |
| 2026-06-15 | `f745a48` | docs: 增强系统指令 — 安全红线、任务执行规范、工具使用规则                 |
| 2026-06-11 | `812e162` | docs: 更新 Mipham Code Web 页面内容                                       |
| 2026-06-11 | `46a1726` | fix: CI 安装 ripgrep 以支持 grep 工具测试                                 |
| 2026-06-11 | `3988d7a` | fix: ESLint flat config, 修复 lint 错误, passWithNoTests                  |
| 2026-06-11 | `81fe590` | fix: 解决全部 CI 类型错误 — import paths, mock types, tsconfig            |
| 2026-06-11 | `04180c9` | fix: 移除 CI 中显式 pnpm 版本号以解决 packageManager 冲突                 |
| 2026-06-10 | `df58e06` | fix: 使用 .npmrc 替代 NODE_AUTH_TOKEN 环境变量                            |
| 2026-06-10 | `aa39c9b` | fix: 测试 job 设为非阻塞（continue-on-error）用于发布流水线               |
| 2026-06-10 | `6b03aa0` | fix: 使用 bunx vitest run 替代 bun test 以兼容 mock                       |
| 2026-06-10 | `b834e7f` | fix: 发布流水线中使用 bun test 替代 pnpm                                  |
| 2026-06-10 | `d3862d2` | feat: Phase 9 — CI/CD 自动发布流水线 + 二进制构建                         |
| 2026-06-10 | `438bbe2` | chore: 版本号升至 v0.2.1, 添加 CLI README 用于 npm 页面                  |
| 2026-06-10 | `c36b188` | fix: 移除 bin/mipham 中 TS 非空断言语法（JS 文件）                       |
| 2026-06-10 | `6f148b5` | feat: 双站点安装脚本 + 产品规格文档                                       |
| 2026-06-10 | `52855cd` | feat: Web 产品页双站点安装 URL, 修复包名, 4 种安装方式                    |
| 2026-06-10 | `55f8eff` | feat: Phase 7+8 — Agent 子系统, 会话持久化, 新 skills, npm 发布就绪, 多平台安装, auto mode UI |
| 2026-06-10 | `9cc8584` | feat: Phase 6 — 完整 MCP stdio 实现（JSON-RPC 2.0 transport + protocol）   |
| 2026-06-10 | `ed125d5` | feat: Phase 5 — 安全加固（路径沙箱, SSRF, Bash 黑名单, 权限门控, 参数校验） |
| 2026-06-09 | `758901a` | feat: Phase 3 — 实现 6 个 slash commands（共 55 个）                      |
| 2026-06-09 | `44c67ef` | feat: Phase 1+2 — 48 个 slash commands 完整实现 + /setup 向导             |
| 2026-06-02 | `18aef07` | fix: 移除 bin path 的 ./ 前缀以适应 npm 规范                              |
| 2026-06-02 | `6ea4cc3` | fix: 重命名 bin/mipham.js → bin/mipham（无扩展名）以适应 npm              |
| 2026-06-02 | `c44d74c` | fix: 使 bin/mipham.js 可执行以支持 npm publish                            |
| 2026-06-02 | `fbcdc5e` | fix: 移除旧的 bin/mipham.ts, 版本升至 v0.1.2                              |
| 2026-06-02 | `95b6d7a` | fix: 内联 shared 模块, 修复 bin 为 .js, 版本升至 v0.1.1                   |
| 2026-06-02 | `3b72c9c` | fix: 更新 install.sh PACKAGE 为 @onemipham/cli, 重命名 CLI 包             |
| 2026-06-02 | `27609bf` | feat: Mipham Code v0.1.0 — 多模型开源智能编程终端（初始 squash 迁移）     |

---

## 下一步计划

1. **npm 发布** — @mipham/cli 发布至 npm registry
2. **MCP 客户端** — 完整 stdio 实现
3. **Web UI** — 完善产品页内容
4. **macOS .app** — 将 CLI 打包为 macOS 应用包（.icns 已就绪）
5. **CI/CD** — 接入自动化发布流水线

---

### 修订历史

| 版本  | 日期       | 变更内容                                                                             | 维护人     |
| ----- | ---------- | ------------------------------------------------------------------------------------ | ---------- |
| 1.1.0 | 2026-06-15 | 更新最近提交表为实际 git 历史（27 commits），补充迁移说明 | 技术委员会 |
| 1.0.0 | 2026-06-02 | 初始创建：完整架构、测试矩阵、Provider 表、Skills 清单、CI/CD 流水线 | 技术委员会 |
