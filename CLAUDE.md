---
prompt-exclude:
  - 最近提交
  - 下一步计划
---

# CLAUDE.md

> **项目**: Mipham Code — AI 编程终端
> **仓库**: One-Mipham/mipham-code
> **公司**: One Mipham Corporation | 品牌: MiphamAI
> **产品**: 多模型开源智能编程终端
> **版本**: 2.21.0
> **最后更新**: 2026-08-28 — RewardFn 接口 + Crossover 算子落地（独立轨 5 项收官）+ 测试数对齐 1976
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

### 终极愿景：CRSI

Mipham Code 的终极目标是达到 **CRSI（Continuous Recursive Self-Improvement）**——华安麦逄人工智能对硅谷 RSI（Recursive Self-Improvement）概念的品牌化表达，被视为取代 AGI 的 AI 终极巅峰。

当前 CRSI 工程实现包括三个子系统 + 一个**受约束自改进闭环**：

| 子系统        | 组件                                                                             |    状态     |
| ------------- | -------------------------------------------------------------------------------- | :---------: |
| 🧠 学习       | PatternAnalyzer + AutoMemoryEngine + ExperienceRuleEngine + EffectivenessTracker | ✅ 2,121 行 |
| 🛡️ 免疫 (SIS) | ErrorSignatureDB + PreFlightChecker                                              | ✅ P0 完成  |
| 🔒 安全       | CrsiSandbox（5 阶段受控自修改）+ 只读边界（PROTECTED_ROLES 语义清单）            |  ✅ 551 行  |

**受约束自改进闭环**（`执行 → 判定 → 反思 → 产出 → 验证 → 批准 → 固化`）：

- **自我认知** `/crsi inventory` — 能力自报告，聚合 CRSI/SIS/宪法实时状态；系统提示注入「回答能力边界先查状态」规则
- **沙箱入口** `/crsi modify` — `core/crsi-modify.ts` 两阶段闸门（worktree → 测试 → diff → `--approve`/`--reject`）
- **完整覆盖闸** `/crsi modify` 入口 — `crsi-sandbox.ts` `validateBlastRadius`：自修改 proposal 必须声明非空 `blastRadius`（触及的**全部**代码路径），否则 fail-closed 拒绝（今日「两条渲染路径只接一条 = 局部正确全局遗漏」教训固化）
- **producer** `/crsi propose` — `core/crsi-producer.ts` 把失败信号转成三类候选：默认教训文件 `crsi-lessons.md`（模板化无 LLM）、`--rule` 固化受管理规则 `crsi-managed-rules.ts`（确定性行为，source='managed'）、`--prose` 两阶段 LLM 改 skill 散文（A1 边界首演：LLM 只生成不判定）；三路径同信号幂等
- **eval harness** `/crsi eval` — `core/eval-harness.ts` 冻结 21 条 ground-truth 契约（13 机制：规则/宪法/沙箱边界/完整覆盖闸/红队/producer 行为 + 8 行为缺口）+ rewards 日志 `~/.mipham/crsi/eval-scores.jsonl`，`runCrsiModification` 以「分数不退化」为第二道闸。8 行为缺口（rm -rf/管道投毒/git reset --hard/chmod 777/mkfs/dd→/dev//关停主机/crontab -r）已由固化 managed tool-params 规则覆盖 → 全翻转 PASS → 满分 100 =「证明更好」
- **任务表现评估 + 改进轨** `/crsi bench` — `core/task-performance.ts`（LLM 生成代码 → 冻结测试判定 → 分数；skill 注入）+ `core/improvement-track.ts`（多次采样 → 噪声自适应 `minEffect = max(20, 2×噪声)` → verdict improved/regressed/inconclusive + Wilson 改进率 + 台账 `~/.mipham/crsi/improvements.jsonl`）；`/crsi modify` 只拦 regressed（倒退才拦，因果归因/最小效应量/误提升预算/改进率四项）

CLI 命令：`/crsi rules|disable|analyze|restore|stats|health|inventory|modify|propose [--rule|--prose]|prose-clear|eval|meta|interpret|critique|red-team` + `/sis errors|stats|clear|cleanup`
测试：1,976 测试（1974 passed + 2 skipped）

---

## 技术栈

| 层         | 技术                                                                             |
| ---------- | -------------------------------------------------------------------------------- |
| CLI 运行时 | Bun 1.2+（推荐）/ Node.js 22+                                                    |
| CLI 框架   | React 18 + Ink 5（终端 UI）                                                      |
| Web        | Next.js 14 + React 18 + Tailwind CSS 3                                           |
| 语言       | TypeScript 5.5+（strict）                                                        |
| 包管理     | pnpm 9.15                                                                        |
| 测试       | Vitest 3（CLI）/ 测试框架待定（Web）                                             |
| CI/CD      | GitHub Actions（typecheck → lint → format → build → test → audit → penetration） |
| 共享库     | @mipham/shared（types, constants）                                               |

### Monorepo 结构

```
mipham-code/
├── apps/
│   ├── cli/                    # CLI 终端（Bun + React/Ink）
│   │   ├── bin/mipham.ts       # 入口（commander）
│   │   ├── src/
│   │   │   ├── core/           # engine, context, permission, hooks, instructions, rules-loader, session-log
│   │   │   ├── vajra/          # Vajra-Hṛdaya 自建内核（context/service/events/compose/leaf）
│   │   │   ├── providers/      # anthropic, openai-compat, registry, bootstrap
│   │   │   ├── tools/          # 30 个工具（file/exec/agent/network/system/scheduling/artifact/computer）
│   │   │   ├── skills/         # loader + standard/mipham 双轨运行时
│   │   │   ├── mcp/            # MCP 客户端 + Tool Search
│   │   │   ├── agent/          # 后台 Agent、消息总线、类型定义
│   │   │   ├── agent-view/     # Agent 会话管理 UI
│   │   │   ├── workflow/       # Workflow 运行时 + Schema 验证
│   │   │   ├── config/         # loader + defaults
│   │   │   └── ui/             # app, chat, input, commands, picker
│   │   ├── skills/             # 27 个内置技能（21 standard + 6 mipham）
│   │   ├── test/               # 186 个测试文件，1976 个测试
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
pnpm test         # vitest run（1976 个测试）
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

### 工具层（31 个工具）

| 分类            | 工具                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| File（5）       | read, write, edit, glob, grep                                                                              |
| Exec（5）       | bash, git, task, EnterWorktree, ExitWorktree                                                               |
| Agent（10）     | agent, skill, plan, memory, workflow, EnterPlanMode, ExitPlanMode, ReportFindings, SendMessage, listAgents |
| Network（2）    | web-fetch, web-search                                                                                      |
| System（3）     | config, mcp, tool-search                                                                                   |
| Artifact（1）   | artifact                                                                                                   |
| Computer（1）   | computer-use                                                                                               |
| Scheduling（4） | schedule-wakeup, cron-create, cron-delete, cron-list                                                       |

### Skills 系统（27 个内置技能）

**Standard（21）**: code-review, codebase-design, compassionate-communication, debug-loop, doc-generator, domain-modeling, github-ops, grill-with-docs, implement, memory, mipham-code-setup, research, safe-coding, security-review, self-review, superpower, tdd, to-spec, triage, web-access, web-search

> `web-access`（v2.5.0）是首个**带可执行资产**的 standard skill：CDP Proxy 直连用户已登录 Chrome（脚本随二进制内嵌，首次调用提取到 `~/.mipham/skills/web-access/`）。

**Mipham Exclusive（6）**: om-artifact, om-model-optimize, om-security, self-audit, doc-sync, save-to-wiki

双轨运行时：standard 轨用于社区 Skills，mipham 轨用于 MiphamAI 专有功能。

### Slash 命令系统（103 个）

按分类：Session & Identity / Workflow / Tools & Skills / Model & Provider / Project / Code Quality / History / GitHub / Environment / Account / Agents / Artifact / Other（总数随版本演进，以 `/help` 实际列出为准）。

### 记忆系统

- **Memory 工具** — AI 可自主 `read`/`write`/`list` 持久化记忆
- **`/memory` 命令** — 用户查看所有已存记忆
- **自动分析引擎** — 对话后自动识别值得持久化的信息
- 存储位置：`~/.mipham/memory/*.md`（YAML frontmatter + Markdown）

### 核心引擎

- `engine.ts` — 对话引擎（消息管理、工具调用编排、SSE 流式输出、Rules 注入、后台任务通知）
- `context.ts` — 上下文管理（系统提示、历史压缩）
- `permission.ts` — 权限控制（6 级：default/acceptEdits/plan/auto/dontAsk/bypassPermissions；`permissionRestrictions`（forbiddenModes/maxAllowedMode）org 级强制降级，请求被禁模式时 fail-closed）
- `hooks.ts` — 生命周期钩子（13 种事件，含 SubagentStart/Stop/PostToolUseFailure）
- `instructions.ts` — 指令加载链（集团/公司/用户层 + git 根→cwd 递归项目层；逐目录读 AGENTS.md / AGENTS.override.md / CLAUDE.md / MIPHAM.md 三格式，就近优先、读全部不丢弃）
- `rules-loader.ts` — 路径作用域规则（.mipham/rules/\*.md → glob 匹配 → 自动注入）

### Vajra-Hṛdaya 内核（自建服务内核）

Vajra-Hṛdaya（金刚·心）是 Mipham Code **自建的可组合服务内核**，概念对标 Cordis「心」（借概念不借代码，机制自造、词汇自立）。把 CLI 的「能力」（工具、LLM、skills、编排）统一抽象为可挂载的 `Service`，用作用域 + 事件 + 依赖注入组合，收三条 harness 旧账（测试可观测性 / 编排边界 / 版本依赖治理）。

| 原语       | 模块                        | 说明                                                                                                                                                              |
| ---------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context    | `vajra/context.ts`          | 作用域（`scope` keyed 缓存 + 局部遮蔽）+ 依赖注入（`provide`/`get`/`inject`）+ 事件派发（`emit`/`waterfall`/`parallel`/`serial`）+ 生命周期（`effect`/`dispose`） |
| Service    | `vajra/service.ts`          | `Service`（`inject?` + `apply(ctx)`）+ `ServiceStatus` 状态机（inactive/loading/active/unloading/failed）                                                         |
| 事件契约   | `vajra/events.ts`           | `DispatchMode`（emit/waterfall/parallel/serial）+ `EventMap`（declaration merging 扩展，不改内核）                                                                |
| 声明式组合 | `vajra/compose/`            | `BundleLine`/`Bundle`/`Profile` 类型 + `assemble`（concat + patch 按 id 整行替换）+ `mountProfile` + `dumpConfig`                                                 |
| 真叶子     | `vajra/leaf/plan-runner.ts` | SDD 编排作为内核 Service：逐任务 `ctx.scope` + `ctx.llm` 一击 + `ctx.emit` 进度事件                                                                               |

四缝（把 harness 旧能力升为 Service，strangler fig 收账）：

- **工具缝** `tools/seam.ts` — `createToolRegistry(ctx)` 挂工具为 Service，`credentialConfig` 全局走私改 `inject:['credentials']`
- **LLM 缝** `ctx.llm` — `Llm` 接口（chat）+ `ProviderRegistry`/`llm-replay` 回放器，engine `setLlm` + 默认回退 registry
- **skills 缝** `ctx.skills` — `Skills` 接口 + `mountSkills` + `SkillsLoader implements Skills`
- **对齐缝** `ctx.constitution` — `Constitution` 接口 + `CONSTITUTION_KEY` + `createConstitution(loader)` 桥接 `ConstitutionLoader`；`Service.align?` 声明原则 id，`mount()` 在 apply 前过对齐门（声明未知 id 拒绝挂载）。宪法原则本体见 `apps/cli/src/core/alignment-vocabulary.json`（与 megasystem/ontology 对齐本体共享单一真源，8 原则含 `facet` 归属悲/智/金刚）
- **愿力层** — 宪法 `preamble` 序言（悲/智/金刚 正向誓愿，非禁令）从词汇表 values 派生，注入 `self-critique` 审计提示词：先对齐愿力（是否体现悲与智、维护结构稳定）再核查禁令

会话日志（M1）：`core/session-log.ts` — `SessionEvent` 七变体 + `messageToEvents`/`deriveMessages` 字节级互逆 + append-only JSONL（「model-visible means logged」）。

CLI 命令 `--dump-config [--profile <name>]`（读 `~/.mipham/profiles/`）。测试：`test/vajra/`（events/service/context/compose/leaf/plan-runner）。

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

| 层级     | 文件数  | 测试数   | 覆盖范围                                      |
| -------- | ------- | -------- | --------------------------------------------- |
| Provider | 4       | 66       | anthropic, bootstrap, openai-compat, registry |
| Core     | 3       | 60       | context, hooks, permission                    |
| Tools    | 5       | 132      | agent, exec, file, network-system, skills     |
| E2E      | 1       | 8        | full-pipeline                                 |
| Other    | 31      | 263      | commands, skills, scheduling, ui, memory 等   |
| **合计** | **186** | **1976** | **0 失败** ✅（1974 passed + 2 skipped）      |

> 注：上表分项为历史快照；总数以 CI 为准（含 `test/vajra/` 内核测试）。

测试框架: Vitest 3，mock: `test/__mocks__/bun.ts`

---

## CI/CD

GitHub Actions 9 个 job 流水线：`typecheck → lint → format → build-cli → build-web → test → security-audit → penetration-test → install-scripts`

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

| 日期       | Commit    | 说明                                                                                         |
| ---------- | --------- | -------------------------------------------------------------------------------------------- |
| 2026-08-24 | `df92d4c` | chore: bump version to 0.56.0                                                                |
| 2026-08-24 | `17208c7` | feat(memory): Memory 工具加 search action（对话中召回）                                      |
| 2026-08-24 | `bcabc89` | fix(cli): 修 plugin/workflow 子命令 argv 解析 + installFromNpm 名一致                        |
| 2026-08-24 | `0b27285` | feat(plugin): 支持安装 Claude marketplace 插件                                               |
| 2026-08-24 | `ba13d02` | feat(graft): 移植 tool-savings 累加 + ctx% 行（方案 B）                                      |
| 2026-08-24 | `1ba65e3` | feat(ui): 底部 graft 状态行 — 读 graft/.cache/stats.json 显示图规模+新鲜度                   |
| 2026-08-24 | `7919483` | fix(skills): 系统提示列出全部 26 个技能而非随机 top-5                                        |
| 2026-08-24 | `26347b8` | fix(startup): 启动目录已删时打印清晰提示而非原始崩溃                                         |
| 2026-08-23 | `643408b` | chore: bump version to 0.55.0                                                                |
| 2026-08-23 | `cf24cab` | feat(cross-session): 拒绝方回「refused」而非静默成功                                         |
| 2026-08-23 | `2179ba1` | chore(core): 删死代码 output-styles.ts（零引用，未接线）                                     |
| 2026-08-23 | `276d120` | fix(loader): 剥离 UTF-8 BOM — 带 BOM 的 .md 不再被静默忽略                                   |
| 2026-08-23 | `c36b661` | fix(config): 原子写 config.yml — 防中断写坏触发备份回滚                                      |
| 2026-08-23 | `8c1c033` | feat(mcp): 懒连接 — 后台连，死 server 不再阻塞启动 15s                                       |
| 2026-08-23 | `eae0356` | feat(prompt): 寒暄克制 — 问候只回一句，不上能力清单                                          |
| 2026-08-23 | `e599caf` | chore: bump version to 0.54.0                                                                |
| 2026-08-23 | `7db55d4` | docs(claude): 2.10.1 — nextBackoff 抽共享 + 测试数对齐 1791                                  |
| 2026-08-23 | `0815820` | refactor(daemon): extract nextBackoff to shared backoff module (rule of three)               |
| 2026-08-23 | `c6f38bc` | fix(telegram): clear fetch mock between tests for isolated-run determinism                   |
| 2026-08-23 | `3aadf3e` | fix(dingtalk): clear fetch mock between tests for isolated-run determinism                   |
| 2026-08-23 | `9f5e3da` | refactor(dingtalk): extract sendResponse envelope helper to DRY ack/pong                     |
| 2026-08-23 | `9f337d5` | docs(claude): 2.10.0 — 钉钉远程控制落地 + 测试数对齐 1795                                    |
| 2026-08-23 | `48513cf` | feat(dingtalk): wire daemon into server + index                                              |
| 2026-08-23 | `9b20c26` | feat(dingtalk): add stream-mode bot module (env/api/ws-client/adapter + tests)               |
| 2026-08-23 | `147e45b` | refactor(doctor): static-import audit helpers instead of dynamic import                      |
| 2026-08-23 | `43aa25b` | docs(claude): 测试数对齐 1763                                                                |
| 2026-08-23 | `d156869` | fix(doctor): tighten audit patterns — drop submodule-workflow & deploy-chain false positives |
| 2026-08-23 | `9b79fde` | docs(claude): 2.9.2 — /doctor CLAUDE.md 审计 + 测试数对齐 1762                               |
| 2026-08-23 | `833ba2c` | feat(doctor): audit CLAUDE.md for code-derivable sections (prompt-exclude candidates)        |
| 2026-08-23 | `116504b` | refactor(agents): prune delegates to remove — single source of session deletion              |
| 2026-08-23 | `b6d3752` | docs(claude): 2.9.1 — agents 视图 Ctrl+X 删除 + 测试数对齐 1758                              |
| 2026-08-23 | `9ab86a1` | feat(agents): Ctrl+X permanently removes a session in agent view                             |
| 2026-08-23 | `a0255f1` | docs(claude): 2.9.0 — Claude Code 2.1.206 借鉴落地 3 条 + 测试数对齐 1756                    |
| 2026-08-23 | `30f547d` | feat(commands): /cd suggests matching directories on not-found                               |
| 2026-08-23 | `1344a0a` | feat(mcp): per-server request_timeout_ms overrides 60s tool-call default                     |
| 2026-08-23 | `98cf831` | feat(mcp): OAuth refresh retries transient failures before PKCE fallback                     |
| 2026-08-21 | `4543fd1` | docs(claude): 2.8.0 — v0.53.0 修订历史 + 测试数对齐 1748                                     |
| 2026-08-21 | `0b44d91` | chore: bump version to 0.53.0                                                                |
| 2026-08-21 | `73f9b16` | docs(readme): 新增 Vim Mode 输入模式说明 + 搜索模式踩坑提醒                                  |
| 2026-08-21 | `7c03b18` | fix(vim): backspace on empty / search query exits search mode                                |
| 2026-08-21 | `9a2742e` | docs(claude): 企业微信远程控制落地 + 测试数对齐 1745                                         |
| 2026-08-21 | `9f8c4ba` | docs(wecom): 企业微信远程控制 design spec + implementation plan                              |
| 2026-08-21 | `96c055c` | fix(wecom): guard parseMessage against null frame                                            |
| 2026-08-21 | `e6723b2` | test(wecom): add ws-client→adapter→reply integration test                                    |
| 2026-08-21 | `34f211e` | feat(wecom): wire adapter into daemon server                                                 |

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

**已完成（2026-08-16 post-CRSI 五条收官）**：

1. ✅ **发布产物冒烟测试** — CI 构建后实跑二进制 + npm 包启动
2. ✅ **Vajra-Hṛdaya 内核收口** — gap①-④ 绞杀收官 + 生产 mount 接线
3. ✅ **CRSI 有效性度量** — EffectivenessTracker 闭环 + `/crsi stats` 面板增强
4. ✅ **分发触达** — Windows PowerShell / macOS .app(DMG) / JetBrains 插件接入 release 管线
5. ✅ **可观测性** — metrics 激活 + Daemon 结构化 JSON logger
6. ✅ **Daemon 后台持久化** — 5 阶段完成（核心基础设施 → 会话持久化 → Agent 系统 → Goals+Schedules → 外部 API 安全），worker 继承 6 级权限系统

**已完成（2026-08-17 CRSI 受约束自改进闭环六块）**：

7. ✅ **自我认知** — `/crsi inventory` 能力自报告 + 系统提示「先查状态再答能力」规则
8. ✅ **定界** — 沙箱只读边界（PROTECTED_PATHS：宪法/eval harness/改进机制不可自改）
9. ✅ **闭环度量** — `exit` 兜底 flush（有效性评估真正生效）+ 测试隔离修复（`rule-engine.test.ts` 曾污染真实 `~/.mipham`）
10. ✅ **沙箱入口** — `/crsi modify` 两阶段闸门（worktree → 全量测试 → diff → `--approve`/`--reject`）
11. ✅ **producer** — `/crsi propose` 失败信号转教训文件（模板化，无 LLM）
12. ✅ **eval harness** — `/crsi eval` 冻结 10 条 ground-truth 契约（规则/宪法/沙箱边界/红队）+ rewards 日志 + 防退化闸

**已完成（2026-08-17 内核收尾 + 行为缺口表 C2 + MCP 深度集成）**：

13. ✅ **内核后续收尾** — `defaultToolContext` 改名 `defaultVajraContext`；`replaceMessages` 保留为 session-log 不变量的测试缝（修正过时注释，`setSkillsLoader` 早已删除）；SubAgent 4 spawn 点已全部迁 `llm`
14. ✅ **行为缺口表 C2（证明更好实演）** — `MANAGED_DANGEROUS_RE` 4→8（+ mkfs / dd→/dev/ / 关停主机 / crontab -r），固化 managed tool-params 规则，eval 分数翻转 75→100
15. ✅ **MCP 深度集成** — OAuth 认证 + Tool Search 早已完成；本轮接上「动态工具更新」断链（`applyToolChanges` + `syncMcpToolsOnChange` → 中央注册表）

**已完成（2026-08-18 待办收口）**：

16. ✅ **VS Code 扩展发布** — 已上架 VS Code Marketplace（网页上传 VSIX，免 PAT）
17. ✅ **JetBrains 插件发布** — 已过审上线（ai.mipham.code/33597），release 管线 env 判空自动发布
18. ✅ **1M 上下文窗口** — 11+ 模型注册 `contextWindow: 1_000_000`；自适应阈值（200K/500K/1M）+ `MIPHAM_DISABLE_1M_CONTEXT` 开关
19. ✅ **多语言国际化** — 10 个 `ui/*.tsx` 全接 `t()` + `commands.ts` 用 `createT`，65 键中英双语

**待办**：

1. **Bot 远程控制扩展** — Feishu（v0.47.0）+ Telegram（长轮询）+ 企业微信（长连接 WebSocket，v2.7.2）+ 钉钉（Stream Mode 长连接，v2.10.0）四频道已全部落地
2. **桌面 App** — macOS/Windows 桌面版（大工程，暂不排期）
3. **Obsidian MCP `get_vault_info` 第三方 bug** — `@zethictech/obsidian-mcp` 调了不存在的 `obsidian vault` 命令（1/34 工具），不影响写 note（save-to-wiki skill 已注明绕开）；等上游修复

---

### 修订历史

| 版本   | 日期       | 变更内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 维护人     |
| ------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| 2.21.0 | 2026-08-28 | 独立轨 5 项收官——RewardFn 接口 + Crossover 算子：① RewardFn 接口 `core/reward-fn.ts`（`ScoreReport`/`RewardFn{name,description,evaluate()}`/`mechanismSentinel` 包 runEval/`taskPerformanceRewardFn` 包 runTaskPerformance/`listRewardFns` 注册表），`runCrsiModification` sync→async + `opts.rewardFn` 可插拔 gate（默认机制哨兵），台账 `appendEvalScore`/`getLastEvalScore` 按名键控（跨尺度隔离），`/crsi eval` 奖励仪表盘（注册表清单 + `--reward <name>`）；`reward-fn.ts` 进 `PROTECTED_ROLES.evaluator` + `PROTECTED_CRITICAL_FILES` ② Crossover 算子 `produceCrossoverProposal`（LLM 选两条重叠教训 + 生成合并版 → 精确行匹配 guard 防幻觉 → `removeLessonSections` 删二增一 → 走沙箱 gate），`buildLessonContent` 加可选 `source` 参数，`/crsi propose --crossover` 接线。测试 1957→1976（1974 passed + 2 skipped，186 文件）。                                                                                                                                                                          | 技术委员会 |
| 2.20.0 | 2026-08-27 | CC 2.1.246-247 借鉴落地 6 条：① sub-agent 运行期错误带 model 名（诊断哪个模型 404/失败）② sub-agent maxTurns 到顶标记 `[partial result]` + SendMessage 续跑提示 ③ MCP server 连不上 → 异步注入通知告知模型「工具不可用」而非「工具不存在」（抽 `formatMcpConnectFailures` 纯函数）④ 跨会话消息折叠成一行 `Message from @sender: summary`（正文留 bus 待 Ctrl+O 展开）⑤ plugin.json UTF-8 BOM 剥离（`\uFEFF`，validator + claude-plugin 两处）⑥ hook command stderr 截断 2KB（防 MB 级输出溢出会话）。测试 1914→1921（1919 passed + 2 skipped，182 文件）。                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 技术委员会 |
| 2.19.0 | 2026-08-27 | CronCreate 落地 + Memory 语义召回：① `computeNextFire` 抽 `core/cron.ts` 共享（daemon+CLI 消第二套 cron 解析）② `CronJob` 加 `nextFire`/`lastFired`、`readAllJobs` 回填旧文件 ③ 新增 `core/cron-poller.ts`（60s 轮询 → 到期 job fire 回当前会话，复用 wakeup 队列 + idle-drain）④ `QueryEngine` 加独立 cron FIFO 队列（不动 /loop keep-latest——有 2 测试 + spec §七固化）⑤ Memory 语义召回：新增 `core/memory/tfidf.ts`（CJK 字符 bigram + ASCII 词 tokenize、cosine、similarities），`recall` 用 TF-IDF 余弦替换词重叠，保留 relevance tag/wikilink/时间衰减。测试 1865→1890（1888 passed + 2 skipped，178 文件）。                                                                                                                                                                                                                                                                                                                                                                                               | 技术委员会 |
| 2.18.0 | 2026-08-26 | AGENTS.md 兼容 + 递归指令加载（Phase 1+2）：① `InstructionsLoader.loadAll` 升级为「git 根 → cwd 递归 + 就近优先」，逐目录读 `AGENTS.md` / `AGENTS.override.md` / `CLAUDE.md` / `MIPHAM.md` 三格式并存（读全部不丢弃，MIPHAM→CLAUDE 相对序不变，仅前置 AGENTS 两条）② 集团/公司/用户层锚定 `gitRoot`（修子目录启动的相对路径漂移）③ 提取 `gitRoot` / `discoverDirectories` 纯函数 + `INSTRUCTION_FILENAMES` 常量，`loadCrsiLessons(root)` 收口。测试 1859→1865（1863 passed + 2 skipped，174 文件）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 技术委员会 |
| 2.17.0 | 2026-08-26 | CRSI 完整覆盖闸（blast-radius 预检 fail-closed）：把「两条渲染路径只接一条 = 局部正确全局遗漏」教训固化进自修改机制。① `CrsiProposal` 加 `blastRadius` 字段 + `validateBlastRadius` 纯函数（归位 `crsi-sandbox.ts`，与 `isProtectedPath` 同层闸）② `runCrsiModification` 入口 fail-closed 拦截（未声明/空 blast radius 拒绝，worktree 之前零副作用）③ producer 两路径（教训文件/受管理规则）产出补 blastRadius 声明 ④ eval-harness 加 `blast-radius-gate` 契约（12→13 机制，契约 20→21 条）。测试 1855→1859（1857 passed + 2 skipped，174 文件）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 技术委员会 |
| 2.16.0 | 2026-08-26 | v0.60.1 发版 — 干净输出开箱默认：① 思考大段转储修复（历史行冲刷路径尊重 showThinking，off/minimal/full）② 解耦开关（showCommandPicker 禁 `/` 选择器自动弹窗、showSchedulingNotices 静默 ⏰ Wakeup 通知，撤销 showSystemMessages 一刀切）③ 干净输出改为默认（thinking off / 调度通知 & 选择器关；Bash 工具活动/错误/命令输出始终保留）④ 回归测试锁定默认值（`test/config/defaults.test.ts`）⑤ 斜杠选择器内联参数修复（`/loop 60s echo hello` 不再「没有匹配」）。测试 1840→1855（1853 passed + 2 skipped，174 文件）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 技术委员会 |
| 2.15.0 | 2026-08-26 | /loop 唤醒全环（半环→全环，8 tasks + 1 fix）：① **Phase 1 真 re-invoke** — `registerWakeupHandler`（schedule-wakeup）+ engine 唤醒队列（`enqueueWakeup`/`dequeueWakeup`/`hasPendingWakeup`）+ app.tsx 抽 `runTurn` + turn 结束 drain + **idle-drain 触发器**（`onWakeupEnqueued`→state bump→useEffect，修最终审查抓的「timer 空闲触发后队列无人 drain」核心缺口） ② **Phase 2 token 记账** — journal `startTokens`/`totalTokens`/`maxIterations` + `recordLoopTokens`/`recordLoopTurn`，`/loop` 快照 startTokens，loop turn 结束自动 logAutoloopIteration + maxIteration 护栏真停 re-invoke ③ **Phase 3** — `/usage` Loops 段（`formatLoopRows`，#1）+ ScheduleWakeup `noop` 参数 + `collapseNoopTicks` 连续空闲折叠（#53）。测试 1821→1840（1838 passed + 2 skipped，171 文件）。                                                                                                                                                                                                                                 | 技术委员会 |
| 2.14.0 | 2026-08-26 | P1 三连 + #57（CC 2.1.243 借鉴落地）：① **#23 客户端错误渲染成错误行** — `engine.process` 遇 `chunk.type==='error'` 时把错误存为 `role:'assistant'`（模型输出），resume 时误渲染成 ◆ assistant；改存 `role:'system'`（⚠ 错误行），与 UI 已有的 `❌ Error` 系统行一致 ② **#35 沙箱违规 exit-0 丢失** — 核查 `bash.ts` 的 `detectViolations` exit-0 路径已正确拼接违规详情（非真缺口），补 2 条集成回归测试锁死「exit 0 + stderr 违规 → content 含 Sandbox Violations」 ③ **#52 富权限错误** — 新增 `PermissionSystem.explainDenial()`（deny-rule/ask-rule/legacy-rule/mode-baseline/tool-default/system-default 六因），`engine.buildDenialError` 按因点名 mode + setting + 修复：deny-rule「拒绝规则优先于模式，改用其他方式」、其余「Shift+Tab 或 /permissions」 ④ **#57 macOS computer-use 授权** — `screenshot.ts`/`app-launcher.ts` 失败时附 Screen Recording / Automation 授权指引（System Settings 路径）。+6 测试（2 bash + 4 explainDenial）。测试 1815→1821 passed（1819 passed + 2 skipped，166 文件）。 | 技术委员会 |
| 2.13.0 | 2026-08-26 | API 首字节超时兜底（对齐 CC #22）：`fetchWithRetry` 加 `timedOut` 标志区分「超时中止（重试一次，防瞬时抖动）」vs「用户取消（不重试）」，超时耗尽后抛清晰报错「API Error: No response from API」而非裸 `AbortError`；新增 2 测试（超时重试 + 调用方取消不重试）。测试 1813→1815 passed + 2 skipped（166 文件）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 技术委员会 |
| 2.12.0 | 2026-08-26 | 文档规范化补齐：① 删死文件 `.eslintrc.json`（ESLint 10 纯 flat config，legacy 配置早已不读，且与 `eslint.config.js` 规则矛盾）② 补 `.gitattributes`（行尾 LF 规范化 + 16 类二进制资产标记）③ 补 `.github/ISSUE_TEMPLATE/`（bug/feature 模板）+ `PULL_REQUEST_TEMPLATE.md` ④ CI 描述修正（5 阶段 → 9 个 job：+ build-web / security-audit / penetration-test / install-scripts）⑤ 测试数对齐 1813（1811 passed + 2 skipped，166 文件；权限 6→4 收敛后较 1820 减 7）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 技术委员会 |
| 2.11.2 | 2026-08-25 | v0.58.0 发版：① 权限模式收敛 6→4 档对齐 Claude Code（删 auto/dontAsk；根因 legacy auto 同名不同义映射错）② 终端三类问题收尾（输入死锁 + 空转超时 + UI 冻结）③ CRSI 运行时召回（`crsi-lessons.md` 注入系统提示，教训从「只写不读」到「写后召回」）④ 普通打字立即显示（仅批量输入节流，消 33ms 慢半拍）⑤ `mipham init` 项目脚手架 + 空目录启动提示（解决「愣建文件夹」缺引导根因）⑥ 沉淀 onboarding 元教训。测试 1796→1811 passed + 2 skipped（163→166 文件）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 技术委员会 |
| 2.11.1 | 2026-08-24 | v0.57.0 发版：① graft 底部状态行解耦 ctx% + 向上回溯探测 graft 图 ② `$()` 命令替换不再 blanket 拦截（安全放行）③ MAX_TURNS 20→100 避免复杂任务空转 ④ 权限授权指引 + Esc/vim 输入体验 ⑤ 删除 vim 模式（无人使用 + 曾致 Esc 陷阱）⑥ 沉淀会话复盘三教训（误伤正则/无用功能/文案漂移）。测试 1818→1796 passed + 2 skipped（164→163 文件）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 技术委员会 |
| 2.11.0 | 2026-08-24 | v0.56.0 发版：① Claude marketplace 插件安装兼容（`plugin-validator` 识别 `.claude-plugin/plugin.json` 只需 name + 新 `claude-plugin.ts` 加载 skills/agents/MCP + `loadPlugins` 按 `detectPluginFormat` 分支，端到端验证 `@directive-run/claude-plugin` 12/12 skills）② `Memory` 工具加 `search` action（复用 `MemoryManager.recall` 对话中召回，参数 query）③ 修 `mipham plugin`/`workflow` 子命令（commander `parseAsync(process.argv)` → `slice(3)+from:'user'`）+ `installFromNpm` 用 manifest name 统一目录/记录/消息。测试 1791→1818 passed + 2 skipped（164 文件）。                                                                                                                                                                                                                                                                                                                                                                                                                                         | 技术委员会 |
| 2.10.1 | 2026-08-23 | 钉钉 self-review 收尾：① `sendResponse` 回帧信封抽共享（ack/pong DRY）② `nextBackoff` 抽 `daemon/backoff.ts`（三频道 telegram/wecom/dingtalk 去重，规则三命中）③ 测试隔离修复 ×2（dingtalk/telegram api.test 显式 `mockClear` 兜底，单文件隔离跑时 `clearMocks` 不清 module 级 `vi.fn` 调用历史）。测试 1793→1789 passed + 2 skipped（dedup -4，159 文件）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 技术委员会 |
| 2.10.0 | 2026-08-23 | 钉钉远程控制落地（第 4 个 inbound 频道）：daemon 新增 `dingtalk/` 模块（types/env/api/ws-client/adapter），钉钉 Stream Mode 长连接（`globalThis.WebSocket` 零依赖；register HTTP 拿 endpoint+ticket → `?ticket=` 建连 → 服务端 ping/pong → CALLBACK 解析 → ack → sessionWebhook 回发；ticket 一次性 90s 过期故每次重连前重新 register）。复用 `channel-message.ts` 四频道共享骨架（feishu/telegram/wecom/dingtalk）。测试 1761→1793 passed + 2 skipped。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 技术委员会 |
| 2.9.2  | 2026-08-23 | /doctor 加 CLAUDE.md 冗余章节审计（`claude-md-audit.ts` 纯函数 `findDerivableSections` 扫 `##`/`###` 标题匹配「可从代码推断」模式：目录结构/技术栈/依赖/提交历史/项目清单/测试数，接线 doctorCmd + i18n）。目标：帮维护者发现 `prompt-exclude` 候选、省上下文 token。测试 1756→1761 passed + 2 skipped。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 技术委员会 |
| 2.9.1  | 2026-08-23 | 可选打磨：#8 agents 视图 Ctrl+X 永久删除会话（`AgentViewManager.remove(id)` + dashboard Ctrl+X 绑定 + `version` 状态触发 `flatList` 重算，修 useMemo 列表成员变更不重算的隐患）。#5 EnterWorktree 外目录确认 / #9 状态列全宽 / #18 会话卡 running / #19 rm 残留 均判 N/A（架构无入口或已覆盖）；#2 /doctor 砍 CLAUDE.md 顺延。测试 1754→1756 passed + 2 skipped。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 技术委员会 |
| 2.9.0  | 2026-08-23 | Claude Code 2.1.206 借鉴落地 3 条真缺口：① OAuth token refresh 单次失败强制 PKCE → 改用 `fetchWithRetry` 先重试 5xx/429/网络（4xx `invalid_grant` 仍直接 PKCE）；② MCP 单 server `request_timeout_ms`（`McpServerConfig` 字段 → `StdioTransport`/`HttpTransport` 构造器 → 覆盖硬编码 60s 默认，`requestTimeoutError`/`DEFAULT_REQUEST_TIMEOUT_MS` 上提 `transport.ts` 共享）；③ `/cd` 目录补全（纯函数 `suggestDirectories` + i18n `commands.cd.suggestions`）。3 commits 拆好（98cf831/1344a0a/30f547d）。测试 1746→1754 passed + 2 skipped。                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 技术委员会 |
| 2.8.0  | 2026-08-21 | v0.53.0 发版：企业微信远程控制（`wecom/` 模块 9 commits，长连接 WebSocket 第 3 个 inbound 频道）+ graft 上下文图集成 + `/save` + save-to-wiki skill + vim 搜索模式 backspace 陷阱修复（`handleSearchBackspace` 纯函数空查询退出搜索）+ 测试并行隔离修复。四渠道全绿（npm `@miphamai/cli@0.53.0` / GitHub Release 6 资产 / JetBrains `publishPlugin` 自动上架 / VS Code VSIX 本地生成待网页上传）。测试 1746 passed + 2 skipped。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 技术委员会 |
| 2.7.2  | 2026-08-21 | 企业微信远程控制落地（第 3 个 inbound 频道）：daemon 新增 `wecom/` 模块（types/env/api/ws-client/adapter，长连接 WebSocket `globalThis.WebSocket` 零依赖 + 心跳 30s/指数退避重连/disconnected_event 互踢），rule-of-three 抽共享 `channel-message.ts` 骨架（feishu/telegram 复用）；修 `parseMessage` null guard（防 malformed frame 崩 daemon 三渠道共进程）。9 commits（`7c10f1d..9f8c4ba`）。测试 1714→1745（1743 passed + 2 skipped）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 技术委员会 |
| 2.7.1  | 2026-08-20 | 修并行测试偶发失败：`vitest.config.ts` 的 `mockReset: true` → `clearMocks: true`。根因=`mockReset` 每测把 setup 的共享 `globalThis.Bun` mock（spawn/sleep/serve）实现重置为 undefined，跨 fork 复用文件泄漏，导致并行偶发失败（非确定性，串行/单文件全绿）；`clearMocks` 只清调用历史、保留实现，并行 20+ 轮连续全绿。测试数不变 1714。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 技术委员会 |
| 2.7.0  | 2026-08-20 | /save 命令 + save-to-wiki skill（Obsidian wiki 集成收口）：`/save` 斜杠命令（`forwardToAI` 桥到 save-to-wiki skill，支持 `/save [type] [name]`）+ 5 类 note 判定（synthesis/concept/source/decision/session）+ 单向打通（memory 指针 + wiki `saved_from`/`mipham_memory` 回标）+ MCP `create_note` 写入 + i18n 双语键。skills 25→26。测试 1712 passed + 2 skipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 技术委员会 |
| 2.6.0  | 2026-08-20 | v0.52.0 发版：指令链瘦身（CLAUDE.md frontmatter `prompt-exclude` 剥纯文档段 + `stripSections()`，实测省 41% token）+ skill sanitizer 修复（`checkSkillShadow` 斜杠 bug + 删 `userInvocable` 死字段 + 删过期 `/triage`）+ Obsidian Wiki 集成（通用 MCP `@zethictech/obsidian-mcp` 接现有 vault + spec）。测试 1706 passed + 2 skipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 技术委员会 |
| 2.5.0  | 2026-08-20 | lint 39→0 收口：① 死代码清理（24 文件未用 import/变量/死 eslint 指令 + daemon 死状态字段，`exit-plan.ts` 删 `planDir` 级联 `_ctx`、`bin/mipham.ts` 删 token 块级联 4 动态 import，39→7）② 7 命令补翻译（`crsi_critique`/`crsi_interpret`/`crsi_red_team`/`dream`/`constitution`/`bug_report`/`changelog` 硬编码英文接 `t()`，~100 键 × en-US/zh-CN，`caughtBy?: string` 加 `?? 'unknown'` 兜底，7→0）。lint 首次归零。测试 1685 passed + 2 skipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 技术委员会 |
| 2.4.9  | 2026-08-20 | 安全线打磨：路径 glob 引擎统一（抽取 `globToRegexSource` 共享核心，`rules-loader` 复用，消除第三套 glob 翻译，修 `?`/转义/`**` 零层隐 bug）+ `matchBashRule` 路径工具改走 `matchPath`（`*` 不再跨 `/`，Windows 盘符冒号不 mangle）+ defaults deny 示例改互补路径（`.git-credentials`/`.npmrc`）+ `maskSearchOutput`/`maskGlobOutput` 存在性不对称加注释钉死意图。测试 1685 passed + 2 skipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 技术委员会 |
| 2.4.8  | 2026-08-20 | 安全线排查收官：Grep/Glob 敏感文件掩码（`credential-masker/search.ts` 的 `maskSearchOutput`/`maskGlobOutput` + `createGrepTool`/`createGlobTool` 工厂注入）+ allow/deny 规则系统接线（`MiphamConfig.permissionRules` 字段、`matchBashRule` 扩展 Read/Grep/Glob 路径匹配、`index.tsx`/daemon 注入）；配套 MIPHAM.md 2.2.0 结果前置人格。测试 1680 passed + 2 skipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 技术委员会 |
| 2.4.7  | 2026-08-20 | Telegram 远程控制（第二频道适配器，镜像飞书）：`telegram/` 模块（types/fail-closed env/裸 fetch api/长轮询 poller/adapter 编排）+ server/index 接线 + 心跳推送 + poller→adapter→回发集成测试；`getOrCreateByFeishuOpenId` 泛化为 `getOrCreateByExternalUser`。测试 1670 passed + 2 skipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 技术委员会 |
| 2.4.6  | 2026-08-19 | v0.50.0 发布（版本 0.49.0→0.50.0 bump + GPG 签名 tag + Release CI 全绿：npm / GitHub Release 6 资产 / JetBrains / 4 平台二进制 + VS Code VSIX 上传）。Memory 工具存储路径隔离：MEMORY_DIR 从 process.env.HOME 改 os.homedir()（堵 E2E「Alice」泄漏），agent.test 补 homedir mock（不再 rmSync 真实 ~/.mipham/memory）。测试 1648 passed + 2 skipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 技术委员会 |
| 2.4.5  | 2026-08-19 | AI 提交署名品牌化：新增 `COAUTHOR_TRAILER` 共享常量（`Co-Authored-By: Mipham <noreply@mipham.ai>`），系统提示注入「Commit Attribution」块，修复 `/fork` 与 `github-ops` skill 硬编码的「Claude」署名。披露 AI 参与（与 Anthropic Undercover 式隐瞒相反）。测试 1647 passed + 2 skipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 技术委员会 |
| 2.4.4  | 2026-08-19 | daemon 心跳式通知（保守版 KAIROS 推送）：`heartbeat.ts`（`collectPendingItems`/`buildHeartbeatMessage`/`heartbeatTick` 纯函数 + `startHeartbeat` 薄接线），feishu 配置时定时扫 pending goal/schedule 推摘要。只通知、不自主行动（CRSI 受约束哲学，借鉴 Claude Code KAIROS「订阅与推送」）。测试 1646 passed + 2 skipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 技术委员会 |
| 2.4.3  | 2026-08-19 | daemon 尊重 org 级 `permissionRestrictions`：抽取 `buildDaemonPermission(restrictions?)`，daemon 的 PermissionSystem 应用 config 的 `permissionRestrictions`（`MIPHAM_DAEMON_PERMISSION=bypassPermissions` 被 `forbiddenModes` 强制降级，fail-closed，与 CLI 对齐）；权限文档补记（CLAUDE.md 权限段 + defaults.ts 注释）。测试 1638 passed + 2 skipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 技术委员会 |
| 2.4.2  | 2026-08-19 | CRSI producer 打磨收尾：prose ledger 清空机制（`clearProseProposals` + `/crsi prose-clear` 命令）补上只增不删缺口；§终极愿景 producer 概述修正（`--prose` 两阶段 LLM + 三路径幂等，不再误写「模板化无 LLM」）；`/crsi` 命令清单补全 meta/interpret/critique/red-team/prose-clear 与 `/sis cleanup`。测试 1632 passed + 2 skipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 技术委员会 |
| 2.4.1  | 2026-08-19 | CRSI producer 三路径同信号幂等去重：prose 路径 append-only ledger（`~/.mipham/crsi/prose-proposals.jsonl`，`proseProposalId` + `hasProposedProse`/`appendProseProposal`）+ 教训路径标题去重 + `/crsi propose --prose` 产出前查 ledger。`ProducerProposal.id` 由摆设变为真实去重键。测试 1630 passed + 2 skipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 技术委员会 |
| 2.4.0  | 2026-08-19 | CRSI 阶段 B 纵深收官：proposal-guard 结构预筛（补 PROTECTED_PATHS 评估机制 5 洞）+ 端到端任务运行器（C-MVP+C-2：runTask/runTaskN/compareRuns/runBeforeAfter）+ producer 散文提议（两阶段 LLM）+ `/crsi propose --prose` 接线。A1 边界决策落地 spec（LLM 只生成不判定）。测试 1624 passed + 2 skipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 技术委员会 |
| 2.3.9  | 2026-08-18 | web-access 升级 v2.5.0：CDP Proxy 直连用户已登录 Chrome（4 脚本 + cdp-api.md 原样照搬 eze-is/web-access）；新增「技能资产」机制（bundled-skill-assets.ts + ensureSkillAssets 提取到 ~/.mipham/skills/）；standard 轨首个带可执行资产的 skill                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 技术委员会 |
| 2.3.8  | 2026-08-18 | 新增 doc-sync skill（借 Truthmark 的 Truth Sync 概念，Map/Check/Update/Verify 四步 + 不变量铁律：只碰 docs/truth/**）；修复 self-audit YAML（description 冒号未加引号 → 自 7006c83 起静默 skip，现 5 个 mipham skill 全加载）；skills 24→25；纠正 debug-loop（frontmatter name=debug-loop，文件名 systematic-debugging，2.3.7 误删）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 技术委员会 |
| 2.3.7  | 2026-08-18 | 全量数字对齐：skills 23→24（+self-audit）、tools 30→31（+listAgents）、slash 命令 93→102、「最近提交」表刷新至 08-18；修正标准技能列表（移除已删除的 debug-loop）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 技术委员会 |
| 2.3.6  | 2026-08-18 | 待办收口：4 条已完成转档（VS Code 扩展发布 / JetBrains 插件上架 / 1M 上下文窗口 / 多语言国际化）；测试数对齐 1561（1559 passed + 2 skipped）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 技术委员会 |
| 2.3.5  | 2026-08-17 | MCP 深度集成收口：OAuth 认证 + Tool Search 早已完成，本轮接上「动态工具更新」断链（`applyToolChanges` + `syncMcpToolsOnChange` → 中央注册表，`tools/list_changed` 增量同步）；补 4 个 MCP 测试。测试 1500 passed + 2 skipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 技术委员会 |
| 2.3.4  | 2026-08-17 | 内核收尾 + 行为缺口表 C2：`defaultToolContext`→`defaultVajraContext`、`replaceMessages` 保留为 session-log 不变量的测试缝（修正过时注释）、SubAgent 4 spawn 点全部迁 `llm`；`MANAGED_DANGEROUS_RE` 4→8 缺口，固化 managed tool-params 规则，eval 分数翻转 75→100（「证明更好」首次实演，不破 A1 铁律）。测试仍 1496 passed + 2 skipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 技术委员会 |
| 2.3.3  | 2026-08-17 | CRSI 行为缺口表（C1）：eval harness 12→16 契约，新增 4 条冻结行为缺口（rm -rf / 管道投毒 / git reset --hard / chmod 777）如实判 FAIL，基线分数 75；producer `tool-params` 规则覆盖这些缺口 → 固化后翻转 PASS =「证明更好」。`crsi-modify.test.ts` 补 rewards 日志清理（跨运行旧 100 分触发假退化）。+1 测试（1496 passed + 2 skipped）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 技术委员会 |
| 2.3.2  | 2026-08-17 | CRSI producer 毕业：`/crsi propose --rule` 固化受管理规则 `crsi-managed-rules.ts`（source='managed'，构造时 merge 进规则引擎、永不落盘），把失败信号转成确定性拦截行为（timeout/tool-params 两类模板）。eval harness 升级 10→12 契约（+ producer-rule-shape / producer-rule-idempotent）。+8 测试（1495 passed + 2 skipped）。强「证明更好」（LLM 编码质量）需 LLM 裁判，留作 C                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 技术委员会 |
| 2.3.1  | 2026-08-17 | `persistAll()` 反思持久化死代码收尾：改名 `finalizeSession()`，去掉冗余 per-reflection 双写循环（`persist()` 已每 turn 落盘），接入 exit 兜底，会话级摘要 `writeSessionSummary()` 真正产出，闭环度量最后一块封口。+3 测试                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 技术委员会 |
| 2.3.0  | 2026-08-17 | CRSI 受约束自改进闭环六块落地：自我认知 `/crsi inventory` + 定界（沙箱 PROTECTED_PATHS 只读边界）+ 闭环度量（exit 兜底 flush + 测试隔离）+ 沙箱入口 `/crsi modify` + producer `/crsi propose`（教训文件）+ eval harness `/crsi eval`（10 条 ground-truth 契约 + rewards 日志 + 防退化闸）。修复红队 `JSON.stringify` 转义假阴性（`no-credential-leak` 引号匹配）。1486 测试（1484 passed + 2 skipped）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 技术委员会 |
| 2.2.2  | 2026-08-17 | 愿力层：宪法 `preamble` 序言（悲/智/金刚 正向誓愿）从对齐词汇表 values 派生，注入 `self-critique` 审计提示词（先愿力后禁令）；抽 `buildCritiquePrompt` 纯函数。1464 测试（1462 passed + 2 skipped）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 技术委员会 |
| 2.2.1  | 2026-08-16 | Vajra-Hṛdaya 对齐缝（第 4 缝）：`Service.align?` 声明原则 id + `ctx.constitution` 缝（`Constitution` 接口 + `CONSTITUTION_KEY`）+ `mount()` 挂载前对齐门（声明未知 id 拒绝挂载，`core/constitution-seam.ts` 桥接 `ConstitutionLoader`）。1454 测试（1452 passed + 2 skipped）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 技术委员会 |
| 2.2.0  | 2026-08-16 | Vajra-Hṛdaya 自建内核落地（M0 原语/M1 会话日志/M2 三缝/M3 声明式组合/真叶子 plan-runner/gap①-④ 绞杀收官）；post-CRSI 五条完成（发布冒烟测试/内核收口/CRSI 有效性度量/分发触达/可观测性）；v0.41.0（未知 flag/option 拒绝执行 + 跨会话测试隔离）。1449 测试                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 技术委员会 |
| 2.1.0  | 2026-08-14 | Claude Code 2.1.231~232 借鉴：4 项 P0（Bash git flag / token 脱敏 / 副代理后台 / SendMessage 裸名）+ prompt cache Phase 1a/1b/2/3（cache_control + PrefixCacheTracker + fork 继承）。1293 测试；Phase 4 错峰跳过（无共享前缀）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 技术委员会 |
| 2.0.3  | 2026-08-13 | v0.32.7 Claude Code 2.1.227 借鉴：rg prompt 增强 + 斜杠菜单匹配高亮 + 性能排查。1115 tests ✅                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 技术委员会 |
| 2.0.2  | 2026-08-13 | v0.32.6 换行规范化（input onChange）+ 同步 v0.32.2→0.32.5：工具活动指示器、Header 精简、粘贴死锁修复                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 技术委员会 |
| 2.0.1  | 2026-08-11 | v0.32.1 工具逐个显示修复（compactToolGroups 重写），1115 测试，CI 绿                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 技术委员会 |
| 2.0.0  | 2026-08-11 | Daemon 后台持久化架构 5 阶段完成（45 文件，~6000 行），Mipham Code 进化为超级智能体平台                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 技术委员会 |
| 1.9.0  | 2026-08-11 | 下一步计划新增 Daemon 后台持久化架构（借鉴 prime-agent 评估结论），1020 测试，CI 绿                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 技术委员会 |
| 1.8.0  | 2026-08-10 | v0.27.0：3 Vibe Coding 摩擦点修复 + 全面能力评估（综合 7.8/10），1020 测试，CI 绿                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 技术委员会 |
| 1.7.0  | 2026-08-10 | v0.26.0：5 新 Skills + 批判性思维层，Skills 15→20，需求→交付链路 85% 覆盖                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 技术委员会 |
| 1.6.0  | 2026-08-10 | v0.25.0：P0/P1/P2 安全对齐 Claude Code v2.1.222→v2.1.226，13 项修复，1020 测试                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 技术委员会 |
| 1.5.0  | 2026-08-10 | 新增关键约束：任务执行流程（搜索→实现→验证→lint）、高效并行调用、禁止自动提交                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 技术委员会 |
| 1.4.0  | 2026-08-05 | Sprint 5：Rules 系统、Agent Memory 三级、MCP Tool Search（30 工具）、VS Code 扩展                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 技术委员会 |
| 1.3.0  | 2026-08-05 | v0.10.0 Sprint 1-4：29 工具、后台 Agent、Worktree、Plan Mode、6 级权限、642 测试                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 技术委员会 |
| 1.2.0  | 2026-06-15 | 修正 Slash 命令（54→89）、Skills（11→15）、补充记忆系统、更新下一步计划                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 技术委员会 |
| 1.1.0  | 2026-06-15 | 更新最近提交表为实际 git 历史（27 commits），补充迁移说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 技术委员会 |
| 1.0.0  | 2026-06-02 | 初始创建：完整架构、测试矩阵、Provider 表、Skills 清单、CI/CD 流水线                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 技术委员会 |
