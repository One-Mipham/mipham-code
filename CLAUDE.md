# CLAUDE.md

> **项目**: Mipham Code — AI 编程终端
> **仓库**: One-Mipham/mipham-code
> **公司**: One Mipham Corporation | 品牌: MiphamAI
> **产品**: 多模型开源智能编程终端
> **版本**: 2.37.6
> **最后更新**: 2026-09-15 — 引用完整性四组收口：C1 `.claude/` 硬编码路径归一到 `core/paths.ts`（写 `.mipham/`、读兼容两者）、C3 两处幻影引用、C4 `/permissions allow|deny|remove` 落盘 settings.json、C5 新增守卫 `test/integrity/`（工具名 / 技能清单 / IDE 环境变量三段契约）；修复过程中抓到三个既有死缺陷（见修订历史）；测试 2304 → 2360（208 → 212 文件）
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
测试：2,361 测试（2359 passed + 2 skipped，0 失败）

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
│   │   │   ├── tools/          # 31 个工具（file/exec/agent/network/system/scheduling/artifact/computer）
│   │   │   ├── skills/         # loader + standard/mipham 双轨运行时
│   │   │   ├── mcp/            # MCP 客户端 + Tool Search
│   │   │   ├── agent/          # 后台 Agent、消息总线、类型定义
│   │   │   ├── agent-view/     # Agent 会话管理 UI
│   │   │   ├── workflow/       # Workflow 运行时 + Schema 验证
│   │   │   ├── config/         # loader + defaults
│   │   │   └── ui/             # app, chat, input, commands, picker
│   │   ├── skills/             # 28 个内置技能（22 standard + 6 mipham）
│   │   ├── test/               # 212 个测试文件，2361 个测试
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
pnpm test         # vitest run（2361 个测试）
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
- `rules-loader.ts` — 路径作用域规则（.mipham/rules/\*.md → glob 匹配 → 自动注入）。**已于 2.37.3 接线**：`index.tsx` 启动时 `new RulesLoader(process.cwd())` + `engine.setRulesLoader()`（setter 自带 `load()`）；注入点在**两处**工具执行后 —— `process()` 首轮（`engine.ts:760`）与 `continueWithTools()` 多轮（引擎多轮循环末尾），只接前者会让规则迟一轮用户输入才生效。以下为接线前的原始诊断（保留备查）：`new RulesLoader` 全历史零出现，`engine.ts:339` 的 `setRulesLoader` 零调用点（自 e2be832「Sprint 5 — rules system」起只有定义没有接线），`engine.ts:24` 该 import 的符号仅用于类型位故转换时被丢弃 → 模块从不加载、守卫永远早退；knip 未报（只看到 import 边），系覆盖率实测发现。daemon 侧仍未接（`daemon/server.ts:177` 对同层 `setSkills`/constitution/`setLlm` 一个都没接，属既有先例）

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

| 目录（`test/`） | 文件数  | 测试数   | 覆盖范围                                                                            |
| --------------- | ------- | -------- | ----------------------------------------------------------------------------------- |
| core            | 73      | 994      | engine / context / permission / hooks / crsi / memory / instructions / paths 等     |
| tools           | 20      | 339      | bash / file / exec / skill / agent / scheduling / seam                              |
| daemon          | 31      | 166      | feishu / telegram / 钉钉 / 企业微信渠道 + session / auth / workspace-guard / logger |
| ui              | 11      | 157      | commands / input / config-wizard / loop / skill-doctor                              |
| agent           | 11      | 108      | sub-agent / background-registry / pattern-analyzer / effectiveness-tracker          |
| security        | 10      | 96       | fd / path / url 净化 + permission-gate + penetration（6 个攻击面）                  |
| providers       | 7       | 89       | anthropic / openai-compat / registry / llm-replay / bootstrap                       |
| mcp             | 8       | 83       | client / transport / oauth / token-store / registry（含 2 skipped）                 |
| workflow        | 7       | 55       | runtime / loop / parallel / sandbox / journal / verify                              |
| vajra           | 6       | 53       | context / events / service / compose / leaf（自建内核）                             |
| shared          | 7       | 44       | arg-validation / deleted-cwd / sanitize / graft / update-async                      |
| commands        | 5       | 38       | keys / cd-suggest / loop-scaffold / autoloop-journal / permissions                  |
| skills          | 5       | 35       | sanitizer / marketplace / fork-executor / skill-assets                              |
| config          | 5       | 30       | credential-crypto / loader-encryption / defaults / settings-json                    |
| plugin          | 2       | 28       | claude-plugin / plugin-manager                                                      |
| artifacts       | 1       | 22       | versioning                                                                          |
| agent-view      | 1       | 9        | agent-view-manager                                                                  |
| e2e             | 1       | 8        | full-pipeline                                                                       |
| integrity       | 1       | 7        | 引用完整性守卫（工具名 / 技能清单 / IDE 环境变量 / 工具总数）                       |
| **合计**        | **212** | **2361** | **0 失败** ✅（2359 passed + 2 skipped）                                            |

> **若本机 `git` 报 Xcode 许可证未接受**：`core/crsi-*` 与 `core/instructions` 中 21 个测试会 shell 调真
> `git`，会被一并挡住而**假红**（极易误判为回归 —— 曾实际发生）。判定方法：把这些文件单独跑一遍，
> 看报错是否为 `You have not agreed to the Xcode license agreements`；或直接 `/usr/bin/git --version`。
> 一次解决：`sudo xcodebuild -license accept`（**保持 Xcode 为活动开发者目录**，不影响 §十六 的打包公证；
> 换 `xcode-select -s` 到 CommandLineTools 则会连带把 `productbuild` / `xcrun notarytool` 切走，勿用）。
> 2026-09-15 已在本机执行，全量 **2358 passed + 2 skipped / 0 失败**。

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
| 2026-09-15 | `7740eff` | fix(docs): 工具数声明对齐注册表 31 + 新增「工具总数」守卫                    |
| 2026-09-15 | `300be1c` | fix(security): 引用完整性四组收口 —— 路径归一 / 权限持久化 / 幻影引用 / 守卫 |
| 2026-09-15 | `9f2a3ad` | fix(security): /clear 与 /resume 重置文件读取追踪                            |
| 2026-09-15 | `bed9b89` | fix(mcp): tools/list_changed 通知合并刷新，去掉紧循环放大                    |
| 2026-09-15 | `5b1c430` | fix(security): Read 规则覆盖 fmt/column 等读者命令                           |

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

| 版本   | 日期       | 变更内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 维护人     |
| ------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 2.37.6 | 2026-09-15 | **引用完整性四组收口**（提交 `300be1c`；C1+C3+C4+C5，**本批未发版**）：① **C1 路径归一** —— 新增 `core/paths.ts` 作 `.claude` / `.mipham` 目录名唯一真源（`LEGACY_CLAUDE_DIR` + `MIPHAM_DIR`，后者复用 `shared/constants.ts` 既有常量不另立真源），`worktreeRoot`/`worktreeRoots`（新目录优先）/`findWorktreeMarker`；六处调用点改接：`tools/exec/{git,bash,enter-worktree,exit-worktree}.ts`、`workflow/primitives/agent.ts`、`ui/commands.ts`（`/fork` 的 `wtPath`）。写侧落 `.mipham/`、读侧兼容 `.claude/`（隔离度只增不减）。**刻意不写 `workflowScriptDirs()`** —— C2（workflow 读写不对称）未获批准，写了就是没接线的死代码。② **C3 幻影引用** —— `/todos` 提示词 5 处、`/tasks` 过滤器 `b.name === 'Task'`、参考表 7 行改为真实工具名 `Task(action: ...)`（此前散落 `TaskCreate`/`TaskList` 等不存在的名字）。③ **C4 权限持久化（方案甲）** —— `/permissions allow\|deny\|remove <rule> [--user]` 落盘 `settings.json`：`config/loader.ts` 新增 `addSettingsRule`/`removeSettingsRule`/`readSettingsDoc`/`writeSettingsDoc`（`atomicWriteFileSync`、malformed JSON 抛错**不覆盖**、保留 hooks 与未知键、幂等），命令侧先 `validateRulePattern` 再写（「一条永远匹配不上的规则比没有规则更糟，它读起来像是保护」），并同步调 `perm.allow/deny/removeRule` 使**当场生效**而不仅重启后。**不做交互弹窗**。④ **C5 守卫** —— 新增 `test/integrity/tool-reference-integrity.test.ts` 三段契约：工具名（形如「已注册工具名+大写后缀」的幻影 token，实测 6 命中 / 0 误报，白名单须写明理由）、技能清单（只扫声明式清单行——轨道名 + 括号内数量 + 名单，不扫散文，附 `inventories > 0` / `claims > 0` 兜底防「正则与文档写法脱节后静默恒真」）、IDE 环境变量（扩展注入的 `MIPHAM_*` 必须有 CLI 读取点）。**本轮纳入的死声明**：删两侧 locale 死键 `tool_not_allowed`；`skills/standard/mipham-code-setup.SKILL.md` 原称 `17 built-in` / `Standard (14)` / `Mipham (3)` 并列出两个不存在的技能名 → 改为 28/22/6 全名单（C5 先红后绿：精确报出 `systematic-debugging`、`test-driven-development`）。**修复过程中抓到三个既有死缺陷，每一个都是先写测试、测试红了才现形**：ⓐ `paths.ts` 自身 `substring` 截出的 worktree root 带尾斜杠，而调用方一律 `root + '/'` → 拼成 `//` 什么都匹配不上（合法路径误拦 + 越界路径放行），`.replace(/\/+$/, '')` 修复并注释「为何不能带尾斜杠」；ⓑ `tools/exec/git.ts` 的 `/\b--work-tree=/`、`/\b--git-dir=/`、`/\b-C/` 三个正则**从来没有匹配过任何东西**（`\b` 要求词/非词边界，`-` 本身即非词字符），故「worktree 越界引用拦截」自写下那天就是死的 —— 实测 `node -e` 取证后去掉 `\b`、`-C` 改用 `(?:^\|\s)` 显式边界；stash 回退到 C1 之前仍红，证明是既有而非本批引入；ⓒ `core/permission.ts` 的 `allow()`/`deny()`/`ask()` 三个方法都**不调 `invalidateCache()`**（而同文件的 `removeRule()` 与 `loadConfig()` 都调），既有调用点全在启动期（缓存还空着）故从不显形，`/permissions` 是第一个会话中途的变更者，一碰就中。**+56 测试 / +4 文件**：`test/core/paths.test.ts`（新，5）、`test/commands/permissions.test.ts`（新，8）、`test/core/denial-hint.test.ts`（新，8，en/zh × 4 断言，deny 规则**必须**给 `/permissions remove` 而非 allow）、`test/integrity/`（新目录，6）、`exec.test.ts` +10、`settings-json.test.ts` +8、`permission.test.ts` +3；测试 2304 → **2360**（208 → **212** 文件，2358 passed + 2 skipped）。三处 red-before-green 全部 stash 实测（C1 4 红 / C4 命令层 4 红 / C4 缓存 4 红 / G3 守卫 2 红）。**本机 21 项环境红（已解除）**：`core/crsi-*` 与 `core/instructions` 会 shell 调真 `git`，被 Xcode 未接受的许可证闸挡住而**假红**；已实测「工作区完全回退到干净树」同样 21 红，证明与本批无关。当日执行 `sudo xcodebuild -license accept` 后复跑 → **2358 passed + 2 skipped / 0 失败**，闸确为唯一成因；CI（ubuntu）自始不受影响。 | 技术委员会 |
| 2.37.5 | 2026-09-15 | **三处修复**（三提交：`5b1c430` `bed9b89` `9f2a3ad`）：① **安全** `READER_COMMANDS` 缺「读文件写 stdout」整类命令（`core/permission-rules.ts:14`）→ `Read(secret)` deny 被 `fmt secret` / `column -t secret` 绕过，补 20 条（fmt column pr fold expand unexpand rev look bat jq yq base64 md5sum sha1sum sha256sum shasum cksum sum cmp iconv），只入读列表不入写列表。命令名单是唯一缺口 —— 扫描器 `scanReaderWriterCommands` 对每个非 `-` 开头参数都入读列表（选项值也当路径，只多不少），文件跟在哪个选项后面不影响命中。② **资源** MCP `tools/list_changed` 紧循环（`src/mcp/client.ts`）—— `onToolsChanged` 原为「一条通知 → 一次 `tools/list` round trip → 一次下游全量重注册」，服务器逐工具通知时即放大器 → 改为每连接合并刷新：`onToolsChanged` 变同步排程入口、`scheduleToolsRefresh`（250ms 去抖 + **2000ms 上限**防「永不停止通知」无限推后）、`runToolsRefresh` 包住原 diff/emit（改名 `applyToolsChanged`）、in-flight 期间到达的通知排队补跑一次；清定时器三处 `disconnect`/`closeAll`/**`reconnect`**（后者必需——同名重连会让遗留定时器打到新连接）；定时器 `unref()` 不吊住进程。③ **安全** `/clear` 与 `/resume` 未清 `engine.readFiles`（`core/engine.ts` + `daemon/remote-engine.ts` 空壳 + `ui/app.tsx` 在 `clearMessages \|\| forwardedMessages.length > 0` 时调 `resetFileTracking()`）—— `readFiles` 是会话级「读过才能覆盖」凭据（`tools/file/write.ts` fail-closed），换对话却不换它 → 新对话可覆盖从没读过的文件；清空是 fail-closed 方向。**+11 测试**（permission-rules +6 / mcp client +4 / engine +1），三处均**先红后绿**（stash 源码实跑确认，分别 4 红、2 红、1 红）；测试 2293 → **2304**（core 969→976、mcp 79→83，208 文件不变，2302 passed + 2 skipped 全绿）。**本轮实测发现但未修（留待下轮）**：`bash -c 'cat secret'` / `sh -c` **不命中** `Read(secret)` —— 新起 shell 不是包装命令，修它需把 `-c` 字符串当嵌套命令递归解析；`Read(具体文件)` + 命令写通配符（`grep secret/*`）不命中 —— 按字面查而非展开通配符。**本批未发版**（无版本 bump 与 tag）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 技术委员会 |
| 2.37.4 | 2026-09-14 | **daemon 外部 API 安全修复**（本批唯一代码改动）：① 新增 `originMiddleware`（`daemon/cors.ts`）—— 无 `Origin`（CLI / curl）放行以保持既有行为不变，有 `Origin` 且不在 `MIPHAM_CORS_ORIGINS` 白名单则 403，置于 WS upgrade 之前故握手一并覆盖（**刻意不复用 `isLocalhostOrigin`** —— 其子串匹配会让 `https://localhost.evil.example` 通过）；② 新增 `daemon/workspace-guard.ts` 的 `isCwdAllowed()` —— `POST /api/v1/sessions` 的 `cwd` 须为已信任 workspace 或 daemon 启动目录子树内。此前两道「安全」机制实际都只防「响应被读到」不防「请求被发出」：`auth.ts` 以 socket IP 判 loopback 即免鉴权，而浏览器发出的请求源 IP 同样是 `127.0.0.1`（Chrome 视 `http://127.0.0.1` 为可信来源）；`cors.ts` 只在响应上加 ACAO 头，而 `mode:'no-cors'` 强制 `text/plain` 属 CORS 安全列表内**不触发预检**。新增 `test/daemon/workspace-guard.test.ts`。**测试数回填**：daemon 30 文件 / 153 → **31 文件 / 166**，全库 207 文件 / 2280 → **208 文件 / 2293**（2291 passed + 2 skipped，本次实测全绿）—— 该修复（`3538a49`）落在 2.37.3 标注之后而文档未同步，故一并回填。**内置 `superpower` skill 2.0.0 → 2.1.0**：选择性吸收上游 `obra/superpowers` 增量（`<SUBAGENT-STOP>` 子代理守卫 / announce 约定 / Red Flags 5 → 12 行），并修 4 处引用了 Mipham 并不存在的技能名的悬空引用（`brainstorming` / `systematic-debugging` / `frontend-design` / `mcp-builder` → `to-spec` / `debug-loop` / `implement` / `codebase-design`）；明确**不**引入上游 `Platform Adaptation` —— 那是 Codex / Pi / Antigravity / Hermes 各家 harness 的分支指引，对本项目自己的 harness 无意义。**v0.81.5 发版**（patch —— 跳过 0.81.4：该号已被 VS Code 扩展的 changelog-only 重发占用，产品线故顺延）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 技术委员会 |
| 2.37.3 | 2026-09-14 | **接线 `core/rules-loader.ts`** —— 修 2.37.2 标注的「未接线」缺陷，本批含代码改动：① `index.tsx` 新增 `new RulesLoader(process.cwd())` + `engine.setRulesLoader(...)`（该 setter 自带 `load()`，启动时读一次 `.mipham/rules/*.md`）；② **补第二处注入路径** —— `injectRules()` 原先只在 `process()` 的**首轮**工具执行后调用（`engine.ts:760`），`continueWithTools()` 的多轮工具循环（`engine.ts:1025`）从不调用，而真实多步任务的文件绝大多数落在后一条路径 → 规则要等下一次用户输入才注入；只接一条即本仓库已固化的「两条路径只接一条」失败模式，故在 continueWithTools 工具循环后补 `injectRules()`。③ 新增测试 14 条：`test/core/rules-loader.test.ts` 11 条（该模块首次有测试）+ `engine.test.ts` 3 条缝测试，其中「后续工具轮次注入」一条**修前为红**。实测：`rules-loader.ts` 行覆盖 0% → **98.07%**，0% 文件数 26 → 25，全库行覆盖 54.74% → **55.10%**；测试 206 文件 / 2266 → **207 文件 / 2280**（2278 passed + 2 skipped）。**未接 daemon 侧**：`daemon/server.ts:177` 的 `getOrCreateEngine` 对同层 `setSkills` / constitution / `setLlm` 一个都没接，系刻意更薄的构造，规则一并缺席属既有先例，未顺手扩。**v0.81.3 发版**（patch —— 修「声称有但不生效」的能力，无新增 API）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 技术委员会 |
| 2.37.2 | 2026-09-14 | 覆盖率实测落地 + 文档事实校正（无代码改动）：① `core/rules-loader.ts` 经核实**未接线** —— `git log -S "new RulesLoader"` 扫全部提交零命中，`engine.ts:339` 的 `setRulesLoader` 全仓库零调用点（自 e2be832「Sprint 5 — rules system」起就只有定义没有接线），`engine.ts:24` 该符号仅用于类型位故转换时被丢弃 → 模块从不加载、`engine.ts:369` 守卫永远早退，`.mipham/rules/*.md` 路径规则**当前不会注入**；knip 未报（只看到 import 边），系覆盖率实测发现，原「自动注入」措辞补限定。② 覆盖率落地：devDep `@vitest/coverage-v8@5.0.0` + `pnpm coverage` 脚本（**报告制** —— 不设阈值、未接 CI），实测行 **54.74%** / 语句 54.47% / 函数 60.38% / 分支 **45.38%**（分支最低=边界与错误路径多未测）。③ 交叉核实结论：knip 未接线清单与覆盖率 0% 清单**不相交** —— knip 的 4 条被测试跑到 90–100%（测试恰是其唯一调用者），覆盖率抓到的 26 个多不报 knip；**「0% 行」有两种含义（从未加载 / 加载但未执行），报告只产出嫌疑名单，定罪须回代码看调用关系**。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 技术委员会 |
| 2.37.1 | 2026-09-14 | `vajra/compose` 通路经核实**未接 live startup** —— `mountProfile`/`mountLines` 生产零调用，四缝为 `index.tsx:492-502` 手写直连；真叶子 `plan-runner` 仅 `test/vajra/leaf/plan-runner.test.ts` 覆盖，生产既无 `Plan` 生产者也无 `PLAN_RUNNER_KEY` 消费者。此推迟系 M3 计划明文决策（`docs/superpowers/plans/2026-08-15-vajra-hrdaya-m3-declarative-composition.md` L7/L19「不接 live startup」，同 M2b/M2c 先例），非遗漏；CLAUDE.md 原「真叶子」措辞读如已交付能力，补限定。附：knip v6.35.1 报告制落地（`apps/cli/knip.json` + `pnpm knip`，带 `--no-exit-code`，未接 CI）用于检测未接线机制。另校正两处陈旧数字：① 测试数 2259→**2266**（2264 passed + 2 skipped，206 文件，本次实测全绿）② `Vitest 3`→**Vitest 5**（`package.json` 声明 `^5.0.0`，实测 vitest@5.0.0）；③ 测试分项表按 `test/` 各目录实测重算 —— 原 5 行分项合计 529 ≠ 合计 2266，改为 18 行真实目录（行合计 = 206 文件 / 2266 测试，自洽），删去「历史快照」注；**v0.81.2 发版**（patch —— 本批无运行时新功能：首装向导 / doctor 审计 / deploy status 三处修复 + knip 工具 + 文档校正）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 技术委员会 |
| 2.37.0 | 2026-09-12 | CC 2.1.268+269 对标落地（一次补两份，267 之后增量 ~140 条）：① 安全——前缀命令（sudo/env/timeout/nohup/command/eval/nice/xargs/doas/exec/stdbuf）绕过 Read/Edit/Bash deny 规则，新增 `PREFIX_COMMANDS` + `effectiveCommand()` 剥离包装命令定位真命令，`stripPrefixCommand()` 让 `sudo rm -rf /` 命中 `Bash(rm *)` ② workflow——`parallel()` 并发上限可配置 `MIPHAM_WORKFLOW_MAX_CONCURRENT_AGENTS`（1–256）覆盖 CPU 默认 16。+12 测试（permission-rules +8、parallel +4）。全量 2258（2256 passed + 2 skipped）。v0.81.0 发版。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 技术委员会 |
| 2.36.1 | 2026-09-12 | v0.80.1 发版：修欢迎屏 banner 间歇重复（v0.80.0 的 Ink 5→7 升级未根治，banner 仍复现）。真根因 = MCP 注册/连接消息用 `process.stderr.write` 直写 stderr，绕过 Ink patchConsole 的 clear/restore 光标追踪 → 启动时 banner 首行 ghost/重复（跨 Ink 5/7 复现，非版本 bug）；改 `console.log`/`console.error`（走 writeToStdout/Stderr 安全路径）。涉及 `index.tsx`（registered/failed）+ `registry.ts`（collision/register_failed）。技术栈文档同步：MIPHAM.md → React 19 + Ink 7（v2.3.1）、CLAUDE.md 技术栈表。测试 2244 passed + 2 skipped。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 技术委员会 |

> **完整修订历史**（v1.0.0–v2.37.6，共 86 条）→ [`docs/claude-md-history.md`](docs/claude-md-history.md)。
> 需要查「某条规则是哪一版引入的、当时为什么改、谁审的」时读它。
