# CLAUDE.md

> **项目**: Mipham Code — AI 编程终端
> **仓库**: One-Mipham/mipham-code
> **公司**: One Mipham Corporation | 品牌: MiphamAI
> **产品**: 多模型开源智能编程终端
> **版本**: 2.37.1
> **最后更新**: 2026-09-14 — 文档事实校正：标注 vajra/compose 通路未接 live startup（真叶子 plan-runner 仅测试覆盖）+ knip 未接线检测报告制落地 + 陈旧数字校正（测试数 2259→2266、Vitest 3→5）+ 测试分项表按 `test/` 各目录实测重算
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
- **producer** `/crsi propose` — `core/crsi-producer.ts` 把失败信号转成四类候选：默认教训文件 `crsi-lessons.md`（模板化无 LLM）、`--rule` 固化受管理规则 `crsi-managed-rules.ts`（确定性行为，source='managed'）、`--prose` 两阶段 LLM 改 skill 散文（A1 边界首演：LLM 只生成不判定）、`--crossover` LLM 选两条重叠教训合并（精确行匹配 guard 防幻觉，删二增一）；三信号路径同信号幂等
- **eval harness** `/crsi eval` — `core/eval-harness.ts` 冻结 33 条 ground-truth 契约（规则/宪法/沙箱边界/完整覆盖闸/语义边界/红队/producer/行为缺口/行为任务）+ rewards 日志 `~/.mipham/crsi/eval-scores.jsonl`，`runCrsiModification` 以「分数不退化」为第二道闸。8 行为缺口（rm -rf/管道投毒/git reset --hard/chmod 777/mkfs/dd→/dev//关停主机/crontab -r）已由固化 managed tool-params 规则覆盖 → 全翻转 PASS → 满分 100 =「证明更好」
- **任务表现评估 + 改进轨** `/crsi bench` — `core/task-performance.ts`（LLM 生成代码 → 冻结测试判定 → 分数；skill 注入）+ `core/improvement-track.ts`（多次采样 → 噪声自适应 `minEffect = max(20, 2×噪声)` → verdict improved/regressed/inconclusive + Wilson 改进率 + 台账 `~/.mipham/crsi/improvements.jsonl`）；`/crsi modify` 只拦 regressed（倒退才拦，因果归因/最小效应量/误提升预算/改进率四项）

CLI 命令：`/crsi rules|disable|analyze|restore|stats|health|inventory|modify|propose [--rule|--prose|--crossover]|prose-clear|eval|meta|interpret|critique|red-team` + `/sis errors|stats|clear|cleanup`
测试：2,266 测试（2264 passed + 2 skipped）

---

## 技术栈

| 层         | 技术                                                                             |
| ---------- | -------------------------------------------------------------------------------- |
| CLI 运行时 | Bun 1.2+（推荐）/ Node.js 22+                                                    |
| CLI 框架   | React 19 + Ink 7（终端 UI）                                                      |
| Web        | Next.js 15 + React 19 + Tailwind CSS 3                                           |
| 语言       | TypeScript 5.5+（strict）                                                        |
| 包管理     | pnpm 9.15                                                                        |
| 测试       | Vitest 5（CLI）/ 测试框架待定（Web）                                             |
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
│   │   ├── skills/             # 28 个内置技能（22 standard + 6 mipham）
│   │   ├── test/               # 206 个测试文件，2266 个测试
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
pnpm test         # vitest run（2266 个测试）
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

### Provider 层（12 家，按字母序）

| Provider       | 类型                        | 路由                         |
| -------------- | --------------------------- | ---------------------------- |
| anthropic      | 原生（Anthropic SDK）       | `providers/anthropic.ts`     |
| deepseek       | OpenAI 兼容                 | `providers/openai-compat.ts` |
| doubao         | OpenAI 兼容（ByteDance）    | `providers/openai-compat.ts` |
| google         | OpenAI 兼容（Gemini）       | `providers/openai-compat.ts` |
| hunyuan        | OpenAI 兼容（Tencent）      | `providers/openai-compat.ts` |
| kimi           | OpenAI 兼容（Moonshot）     | `providers/openai-compat.ts` |
| minimax        | OpenAI 兼容（MiniMax 国内） | `providers/openai-compat.ts` |
| minimax-global | OpenAI 兼容（MiniMax 国际） | `providers/openai-compat.ts` |
| mipham         | OpenAI 兼容（MiphamAI）     | `providers/registry.ts`      |
| ollama         | OpenAI 兼容（本地）         | `providers/openai-compat.ts` |
| openai         | OpenAI 兼容                 | `providers/openai-compat.ts` |
| qwen           | OpenAI 兼容                 | `providers/openai-compat.ts` |

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

### Skills 系统（28 个内置技能）

**Standard（22）**: code-review, codebase-design, compassionate-communication, debug-loop, doc-generator, domain-modeling, github-ops, grill-with-docs, implement, memory, mipham-code-setup, research, safe-coding, security-review, self-review, superpower, tdd, to-spec, triage, trim-process-prose, web-access, web-search

> `web-access`（v2.5.0）是首个**带可执行资产**的 standard skill：CDP Proxy 直连用户已登录 Chrome（脚本随二进制内嵌，首次调用提取到 `~/.mipham/skills/web-access/`）。

**Mipham Exclusive（6）**: om-artifact, om-model-optimize, om-security, self-audit, doc-sync, save-to-wiki

双轨运行时：standard 轨用于社区 Skills，mipham 轨用于 MiphamAI 专有功能。

### Slash 命令系统（136 个）

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

| 原语       | 模块                        | 说明                                                                                                                                                                            |
| ---------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context    | `vajra/context.ts`          | 作用域（`scope` keyed 缓存 + 局部遮蔽）+ 依赖注入（`provide`/`get`/`inject`）+ 事件派发（`emit`/`waterfall`/`parallel`/`serial`）+ 生命周期（`effect`/`dispose`）               |
| Service    | `vajra/service.ts`          | `Service`（`inject?` + `apply(ctx)`）+ `ServiceStatus` 状态机（inactive/loading/active/unloading/failed）                                                                       |
| 事件契约   | `vajra/events.ts`           | `DispatchMode`（emit/waterfall/parallel/serial）+ `EventMap`（declaration merging 扩展，不改内核）                                                                              |
| 声明式组合 | `vajra/compose/`            | `BundleLine`/`Bundle`/`Profile` 类型 + `assemble`（concat + patch 按 id 整行替换）+ `mountProfile` + `dumpConfig`                                                               |
| 真叶子     | `vajra/leaf/plan-runner.ts` | SDD 编排作为内核 Service（逐任务 `ctx.scope` + `ctx.llm` 一击 + `ctx.emit` 进度事件）；**内核能力证明，仅测试覆盖 —— profile-driven live startup 按 M3 决策未接，生产无调用者** |

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

| 目录（`test/`） | 文件数  | 测试数   | 覆盖范围                                                                   |
| --------------- | ------- | -------- | -------------------------------------------------------------------------- |
| core            | 70      | 955      | engine / context / permission / hooks / crsi / memory / instructions 等    |
| tools           | 20      | 329      | bash / file / exec / skill / agent / scheduling / seam                     |
| daemon          | 30      | 153      | feishu / telegram / 钉钉 / 企业微信渠道 + session / auth / logger          |
| ui              | 11      | 151      | commands / input / config-wizard / loop / skill-doctor                     |
| agent           | 11      | 108      | sub-agent / background-registry / pattern-analyzer / effectiveness-tracker |
| security        | 10      | 96       | fd / path / url 净化 + permission-gate + penetration（6 个攻击面）         |
| providers       | 7       | 89       | anthropic / openai-compat / registry / llm-replay / bootstrap              |
| mcp             | 8       | 79       | client / transport / oauth / token-store / registry（含 2 skipped）        |
| workflow        | 7       | 55       | runtime / loop / parallel / sandbox / journal / verify                     |
| vajra           | 6       | 53       | context / events / service / compose / leaf（自建内核）                    |
| shared          | 7       | 44       | arg-validation / deleted-cwd / sanitize / graft / update-async             |
| skills          | 5       | 35       | sanitizer / marketplace / fork-executor / skill-assets                     |
| commands        | 4       | 30       | keys / cd-suggest / loop-scaffold / autoloop-journal                       |
| plugin          | 2       | 28       | claude-plugin / plugin-manager                                             |
| artifacts       | 1       | 22       | versioning                                                                 |
| config          | 5       | 22       | credential-crypto / loader-encryption / defaults / settings-json           |
| agent-view      | 1       | 9        | agent-view-manager                                                         |
| e2e             | 1       | 8        | full-pipeline                                                              |
| **合计**        | **206** | **2266** | **0 失败** ✅（2264 passed + 2 skipped）                                   |

测试框架: Vitest 5，mock: `test/__mocks__/bun.ts`

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

| 日期       | Commit    | 说明                                                                         |
| ---------- | --------- | ---------------------------------------------------------------------------- |
| 2026-09-12 | `6633832` | chore: bump version to 0.80.1                                                |
| 2026-09-12 | `b8e4d78` | fix(cli): MCP 注册消息改走 console 避免 stderr 直写干扰 Ink 渲染             |
| 2026-09-12 | `ee89eb7` | docs(claude): 2.36.0 — v0.80.0 发版：升级 Ink 5→7 + React 19，修 banner 重复 |

> **完整记录** → [`docs/claude-md-history.md`](docs/claude-md-history.md)：最近提交全表 + v1.0.0 起全部修订。
> 需要查「某次改动属于哪次提交 / 哪一版」时读它。

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

| 版本   | 日期       | 变更内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 维护人     |
| ------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 2.37.1 | 2026-09-14 | 文档事实校正（无代码改动）：`vajra/compose` 通路经核实**未接 live startup** —— `mountProfile`/`mountLines` 生产零调用，四缝为 `index.tsx:492-502` 手写直连；真叶子 `plan-runner` 仅 `test/vajra/leaf/plan-runner.test.ts` 覆盖，生产既无 `Plan` 生产者也无 `PLAN_RUNNER_KEY` 消费者。此推迟系 M3 计划明文决策（`docs/superpowers/plans/2026-08-15-vajra-hrdaya-m3-declarative-composition.md` L7/L19「不接 live startup」，同 M2b/M2c 先例），非遗漏；CLAUDE.md 原「真叶子」措辞读如已交付能力，补限定。附：knip v6.35.1 报告制落地（`apps/cli/knip.json` + `pnpm knip`，带 `--no-exit-code`，未接 CI）用于检测未接线机制。另校正两处陈旧数字：① 测试数 2259→**2266**（2264 passed + 2 skipped，206 文件，本次实测全绿）② `Vitest 3`→**Vitest 5**（`package.json` 声明 `^5.0.0`，实测 vitest@5.0.0）；③ 测试分项表按 `test/` 各目录实测重算 —— 原 5 行分项合计 529 ≠ 合计 2266，改为 18 行真实目录（行合计 = 206 文件 / 2266 测试，自洽），删去「历史快照」注。 | 技术委员会 |
| 2.37.0 | 2026-09-12 | CC 2.1.268+269 对标落地（一次补两份，267 之后增量 ~140 条）：① 安全——前缀命令（sudo/env/timeout/nohup/command/eval/nice/xargs/doas/exec/stdbuf）绕过 Read/Edit/Bash deny 规则，新增 `PREFIX_COMMANDS` + `effectiveCommand()` 剥离包装命令定位真命令，`stripPrefixCommand()` 让 `sudo rm -rf /` 命中 `Bash(rm *)` ② workflow——`parallel()` 并发上限可配置 `MIPHAM_WORKFLOW_MAX_CONCURRENT_AGENTS`（1–256）覆盖 CPU 默认 16。+12 测试（permission-rules +8、parallel +4）。全量 2258（2256 passed + 2 skipped）。v0.81.0 发版。                                                                                                                                                                                                                                                                                                                                                                                                                                   | 技术委员会 |
| 2.36.1 | 2026-09-12 | v0.80.1 发版：修欢迎屏 banner 间歇重复（v0.80.0 的 Ink 5→7 升级未根治，banner 仍复现）。真根因 = MCP 注册/连接消息用 `process.stderr.write` 直写 stderr，绕过 Ink patchConsole 的 clear/restore 光标追踪 → 启动时 banner 首行 ghost/重复（跨 Ink 5/7 复现，非版本 bug）；改 `console.log`/`console.error`（走 writeToStdout/Stderr 安全路径）。涉及 `index.tsx`（registered/failed）+ `registry.ts`（collision/register_failed）。技术栈文档同步：MIPHAM.md → React 19 + Ink 7（v2.3.1）、CLAUDE.md 技术栈表。测试 2244 passed + 2 skipped。                                                                                                                                                                                                                                                                                                                                                                                                                    | 技术委员会 |

> **完整修订历史**（v1.0.0–v2.37.1，共 81 条）→ [`docs/claude-md-history.md`](docs/claude-md-history.md)。
> 需要查「某条规则是哪一版引入的、当时为什么改、谁审的」时读它。
