# CLAUDE.md

> **项目**: Mipham Code — AI 编程终端
> **仓库**: One-Mipham/mipham-code
> **公司**: One Mipham Corporation | 品牌: MiphamAI
> **产品**: 多模型开源智能编程终端
> **版本**: 2.43.0
> **最后更新**: 2026-09-15 — **T3c 变异测试落地**：首批 6 文件基线 **8.02%**（1621 变异体，实跑 8m55s），`crsi-sandbox.ts` 延后第二批；新增范围守卫 `test/integrity/mutation-wiring.test.ts`（磁盘枚举 vs `mutate` 清单集合相等）。测试 2525 → 2533（224 → 225 文件）
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
测试：2,533 测试（2531 passed + 2 skipped，0 失败）

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
│   │   ├── test/               # 225 个测试文件，2533 个测试
│   │   └── assets/             # icon.jpg, icon.icns
│   ├── telemetry/              # 遥测接收端（T1b，Node 22 + systemd 部署，本仓库唯一对外服务）
│   │   ├── src/                # config schema validate request dedup aggregate store crypto ratelimit server report
│   │   └── test/               # 12 个测试文件，179 个测试
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
pnpm test         # vitest run（2533 个测试）
pnpm typecheck    # tsc --noEmit
pnpm mutate       # stryker run（变异测试；~9 分钟，**必须在本目录下跑**，见 ROADMAP T3c）

# Telemetry（接收端）
cd apps/telemetry
pnpm test         # vitest run（179 个测试）
pnpm build        # tsc -p tsconfig.build.json && cp src/allowlist.json dist/
pnpm start        # node dist/server.js（默认 127.0.0.1:9099）
pnpm report       # node dist/report.js --since 7d [--json] [--raw]

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

### Slash 命令系统（137 个）

按分类：Session & Identity / Workflow / Tools & Skills / Model & Provider / Project / Code Quality / History / GitHub / Environment / Account / Agents / Artifact / Other（总数随版本演进，以 `/help` 实际列出为准）。

### 记忆系统

- **Memory 工具** — AI 可自主 `read`/`write`/`list` 持久化记忆
- **`/memory` 命令** — 用户查看所有已存记忆
- **自动分析引擎** — 对话后自动识别值得持久化的信息
- 存储位置：`~/.mipham/memory/*.md`（YAML frontmatter + Markdown）

### 遥测与崩溃上报（T1 CLI 侧 + T1b 接收端）

`src/telemetry/`：**默认关闭**，`/telemetry status|on|off|reset-id|endpoint` 控制，开关落
`settings.json`（**不落 `config.yml`** —— 那会让首装向导因「文件已存在」而永不再现，且其浅合并
会打掉兄弟表默认值）。三级 fail-closed：`MIPHAM_TELEMETRY=off` 硬关 > 用户 opt-in > 项目
**只能否决**（否则 clone 一个仓库 = 被它代授同意）。无任何环境变量可授予同意。

采集与发送**必须解耦**：`process.on('exit')` 不能 await ⇒ 退出时**同步**落本地队列
（`~/.mipham/telemetry/queue.jsonl`，0600，上限 100 条），**下次启动**异步发送（失败静默留队）。
崩溃上报装 `uncaughtException`/`unhandledRejection`（**记录后必须 exit，否则崩溃变静默挂起**），
且**无条件安装**（关闭遥测时也装 —— 它是防挂起的那一环）。栈**脱敏截断**：cwd → `<cwd>`、home → `~`、
home 下第一段 → `<dir>`（否则 `~/proj/...` 仍泄露项目名），只发消息 hash 不发正文。

工具计数有**两条路径**，两处都要接并有**一致性断言测试**：主漏斗 `engine.ts` `executeTool`（入口计数）
与旁路 `agent/sub-agent.ts`（直接 `tool.execute`，workflow 经它派生）。只接一条 ⇒ 子代理与 workflow
的调用**一次都统计不到**。数据字典：[`docs/telemetry.md`](docs/telemetry.md)。

**接收端（T1b）**：`apps/telemetry/` —— `log.onemipham.com/v1/events`，**公开、只写、无读端点**
（CLI 请求不带鉴权头，而本仓库 Apache 2.0 发布到 npm ⇒ 硬编码 token 不是秘密）。
**只存维度聚合**：按**服务端接收日**（UTC，不可伪造）分区，客户端 `occurredAt` 只进偏移桶。
四组关键决策：① **服务端状态码由客户端 ack 语义倒推决定** —— `transport.ts:58` 把 2xx 与 4xx
一律 ack 删条，所以 **429 绝对禁止**（它既在 `RETRYABLE_STATUSES` 里被重试 2 次、又终归 4xx
被静默丢弃，等于「1 次信号换 3 次请求后永久丢失」），过载一律 **503**；**且绝不发 `Retry-After`**
（`fetch-utils.ts:54` 无上限信任它、`sleep` 持有事件循环 ⇒ `Retry-After: 3600` 就是挂住一小时）。
② **校验前向兼容**：`400` 是销毁数据的按钮，只在「非 JSON / 非对象 / 缺 `id`·`kind`」时用；
不认识 `schemaVersion` **不拒收**（服务端必然滞后于客户端发布），字段级问题只丢字段。
③ **`counters` 用服务端 allowlist 而非基数上限** —— 端点是公开无鉴权的写端点，数值上限可被
**填满**（发满垃圾 label 把真实 label 挤进 `__other__` ⇒ 毒化 T4 赖以投票的数据）；allowlist
由脚本从 CLI 源码派生 + 完整性测试逐字比对。**不存任何原始 label**（`docs/telemetry.md`
承诺 no free text，而 `command_calls.<用户敲的东西>` 正是自由文本）。
④ **装机数用 HLL 不用精确集合** —— 精确集合落盘的恰恰就是「当天的安装清单」，是逐安装日志；
`installId` 只在内存里喂 HLL。**去重单边偏置**（bloom 假阳性被 exact 集救援、exact 逐出当新）
⇒ 误差只会虚高、**永不误删唯一事件**（T4 按**存在性**投票，误删 ⇒ 删活代码）。
**`stackFrames` 已按 `schemaVersion: 2` 从线上撤掉（2026-09-15 落地）** —— 「只存聚合」下帧串
一个字节都留不下（服务端的汇聚路径至今仍在，只为已发布、收不回来的 v1 客户端），发它只换来
~3 KB/次与一个隐私面。**帧仍脱敏、但只留本进程内存**（不落盘、不上网），`frameCount` 保留 ——
它才是「栈短」与「栈被截」的区分依据。**顺序不可颠倒**（服务端必须先接受 v1），且这次撤帧
的代价已认下：**崩溃通道永远不能告诉你崩在哪一行**。
**诚实边界：204 不代表已持久化**（每 25 条 / 10s 才 flush，SIGKILL 丢最近一个窗口）。
**上线状态（2026-09-15）**：端点已在主机 2 实跑，`--check` = no drift、服务 active、
journald 指纹与 `keys init` 一致；真 CLI 端到端两跑 ⇒ 第一条被 ack 删条、报告侧
2 事件 2 会话 2 安装、unknown/discarded 全 0。**已知偏离：该端点实际 TLS 1.2+1.3** ——
主机 2 上同一 443 地址的握手版本由**该地址的默认 server（api）**决定（版本在 OpenSSL 处理
ClientHello 时定死，**早于** nginx 的 SNI 回调；官方 wontfix 到 1.29.2），故 vhost 里写
`TLSv1.3;` 无效，现为如实声明 `TLSv1.2 TLSv1.3`（行为不变、配置不说谎、将来升 nginx 也不会
突然改变行为）。套件仍是前向安全的 ECDHE-ECDSA-AES\*-GCM，遥测不含金融数据，属 §二 例外申请。
**这也是「本机验过 ≠ 验的是生产那个对象」的实例**（本机 1.31.5 已带该修复、主机 1.24.0 不带）。
细节见 `apps/telemetry/deploy/README.md`「已知的诚实边界」。
**端点默认已不是空串**（T1b 第 7 步落地）：`resolveEndpoint()` 按 `env > 用户 settings > 官方接收端`
解析，`OFFICIAL_TELEMETRY_ENDPOINT` 就是 `log.onemipham.com` 那条路径；`'none'` 哨兵是**唯一**能
表达「开着但哪儿都不发」的写法（空串是假值，会一路下沉到默认值 —— 这正是哨兵存在的理由）。
**零网络保证的施加点随之从「端点为空」移到 `initTelemetry` 的 `if (consent.enabled)`** ——
从前是物理上打不出去，现在是唯一一道判断，故该断言在 `index.test.ts` 里被点名标注为不可弱化。
跨 app 契约测试 `apps/cli/test/integrity/telemetry-contract.test.ts` 是
「契约漂移 ⇒ 每个事件 404 ⇒ 静默全丢」的**唯一机械防线**。

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

| 目录（`test/`） | 文件数  | 测试数   | 覆盖范围                                                                                                                                                                    |
| --------------- | ------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| core            | 73      | 1009     | engine / context / permission / hooks / crsi / memory / instructions / paths 等                                                                                             |
| tools           | 20      | 339      | bash / file / exec / skill / agent / scheduling / seam                                                                                                                      |
| daemon          | 31      | 166      | feishu / telegram / 钉钉 / 企业微信渠道 + session / auth / workspace-guard / logger                                                                                         |
| ui              | 11      | 157      | commands / input / config-wizard / loop / skill-doctor                                                                                                                      |
| agent           | 11      | 108      | sub-agent / background-registry / pattern-analyzer / effectiveness-tracker                                                                                                  |
| security        | 10      | 96       | fd / path / url 净化 + permission-gate + penetration（6 个攻击面）                                                                                                          |
| providers       | 7       | 89       | anthropic / openai-compat / registry / llm-replay / bootstrap                                                                                                               |
| mcp             | 8       | 83       | client / transport / oauth / token-store / registry（含 2 skipped）                                                                                                         |
| workflow        | 7       | 55       | runtime / loop / parallel / sandbox / journal / verify                                                                                                                      |
| vajra           | 6       | 53       | context / events / service / compose / leaf（自建内核）                                                                                                                     |
| shared          | 7       | 44       | arg-validation / deleted-cwd / sanitize / graft / update-async                                                                                                              |
| commands        | 6       | 48       | keys / cd-suggest / loop-scaffold / autoloop-journal / permissions / init-providers                                                                                         |
| skills          | 5       | 35       | sanitizer / marketplace / fork-executor / skill-assets                                                                                                                      |
| config          | 5       | 30       | credential-crypto / loader-encryption / defaults / settings-json                                                                                                            |
| plugin          | 2       | 28       | claude-plugin / plugin-manager                                                                                                                                              |
| artifacts       | 1       | 22       | versioning                                                                                                                                                                  |
| agent-view      | 1       | 9        | agent-view-manager                                                                                                                                                          |
| e2e             | 1       | 8        | full-pipeline                                                                                                                                                               |
| integrity       | 4       | 34       | 引用完整性守卫 + ESLint 规则生效证明 + **遥测契约**（CLI ↔ `apps/telemetry` 逐字段，含 endpoint ↔ vhost 目的地）+ **变异测试范围**（`mutate` 清单 vs 磁盘枚举，延后表明写） |
| telemetry       | 9       | 120      | redact / consent / queue / payload / crash / transport / endpoint / 门面 / 双路径计数一致性                                                                                 |
| **合计**        | **225** | **2533** | **0 失败** ✅（2531 passed + 2 skipped）                                                                                                                                    |

> **本表只统计 `apps/cli/test/`。** `apps/telemetry` 是独立工作区（12 文件 / 179 测试，自带
> `vitest.config.ts` 与阈值），**不在上表内**，全量跑用 `pnpm -r coverage`。
> **跑 `apps/cli` 全量必须 `cd apps/cli` 再跑**，`--root apps/cli` **不够** —— MCP 测试
> spawn 子进程（`bun run test/mcp/mock-server.ts`）且 `StdioTransport.start` 不传 `cwd`，
> 子进程继承 `process.cwd()`；从仓库根跑会 **31 个假红**（`mcp/*` 28 + `crsi-sandbox` 3），
> 全是路径问题，别去查 MCP 代码。

> **若本机 `git` 报 Xcode 许可证未接受**：`core/crsi-*` 与 `core/instructions` 中 21 个测试会 shell 调真
> `git`，会被一并挡住而**假红**（极易误判为回归 —— 曾实际发生）。判定方法：把这些文件单独跑一遍，
> 看报错是否为 `You have not agreed to the Xcode license agreements`；或直接 `/usr/bin/git --version`。
> 一次解决：`sudo xcodebuild -license accept`（**保持 Xcode 为活动开发者目录**，不影响 §十六 的打包公证；
> 换 `xcode-select -s` 到 CommandLineTools 则会连带把 `productbuild` / `xcrun notarytool` 切走，勿用）。
> 2026-09-15 已在本机执行，全量 **2531 passed + 2 skipped / 0 失败**。

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
- **ESLint 已开 type-checked**：`@typescript-eslint/no-floating-promises` 钉在 **`error`**（根 lint 脚本是裸 `eslint .`、**无 `--max-warnings`** ⇒ 写成 `warn` 等于零强制）；type-aware 规则依赖 `parserOptions.projectService`，`scripts/`、`vitest.config.ts` 等不在任何 tsconfig 里的入口须列进 `allowDefaultProject`（否则该文件抛解析错、**所有规则对它静默失效**）。仓库绿证明不了规则能触发（fixture 被 `eslint .` 忽略），生效证明在 `test/integrity/lint-rules.test.ts`
- 提交信息遵循 Conventional Commits
- **安全拒绝**: 拒绝编写恶意代码、恶意软件相关文件；授权安全测试（渗透测试、CTF）例外
- **任务执行流程**: 搜索理解代码库 → 实现方案 → 验证测试 → lint/typecheck，每步有明确验证点
- **高效调用**: 多个独立工具调用应在同一批次并行发出，减少往返延迟
- **禁止自动提交**: 用户未明确要求时，不得自动执行 `git commit` 或 `git push`

---

## 最近提交

| 日期       | Commit    | 说明                                                                     |
| ---------- | --------- | ------------------------------------------------------------------------ |
| 2026-09-15 | `5b9075b` | test(cli): 变异测试落地 —— 首批 6 文件基线 8.02% + 范围守卫（T3c）       |
| 2026-09-15 | `fba2b45` | docs(claude): 2.42.0 —— T1b 上线 + 撤帧 + 数字回填                       |
| 2026-09-15 | `e7bfd89` | refactor(telemetry)!: schemaVersion 2 —— stackFrames 不再上网            |
| 2026-09-15 | `2ca222c` | fix(telemetry): vhost 如实声明 TLSv1.2+1.3 —— 握手版本由默认 server 决定 |
| 2026-09-15 | `33c64be` | test(telemetry): endpoint ↔ vhost 目的地契约守卫（T1b 第 8 步）          |

> **完整记录** → [`docs/claude-md-history.md`](docs/claude-md-history.md)：最近提交全表 + v1.0.0 起全部修订。
> 需要查「某次改动属于哪次提交 / 哪一版」时读它。
>
> **滚动窗口（硬约定）**：本表与下方 `### 修订历史` 各**只保留最近 5 行**，新增必须挤掉第 6 行；
> 被挤掉的行搬进上面的 history.md（那里是全表，逐字不丢）。此约定由
> `apps/cli/test/integrity/tool-reference-integrity.test.ts` 的「变更记录滚动窗口与文档体积」
> 守卫，连同「CLAUDE.md 全文 ≤ 40,000 字符」的预算一起机器强制 —— 40k 正是当初触发
> 拆分的那条红线，拆分 17 小时后本文件曾二次越过它（21,193 → 56,001 字符）。

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

| 版本   | 日期       | 变更内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 维护人     |
| ------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 2.43.0 | 2026-09-15 | **T3c · 变异测试落地（首批 6 文件，基线 8.02%）** —— 覆盖率只证明「行被执行过」，不证明「测得住」。新增 `apps/cli/stryker.config.json`（Stryker 10 + vitest-runner，devDependency，Apache-2.0）+ `mutate` 脚本 + 范围守卫 `test/integrity/mutation-wiring.test.ts`；`.stryker-tmp/`、`reports/` 挡在 git 与 ESLint 之外。**基线实跑取得（不估）**：1621 变异体 / 130 killed / 1311 survived / 180 no-coverage = **8.02%**，6 文件，8m55s，退出码 0。范围 = `src/core/crsi-*` + `src/core/permission*`，**`crsi-sandbox.ts` 延后第二批**（其 `runTests()` 在临时 worktree 里 `execSync('pnpm test')` 跑整套套件 ⇒ 每个踩到它的变异体都要付一次全量，足以独自吃光预算）—— 这是对新事实的范围收窄，理由写进 ROADMAP 不静默改。五个非直觉机制：① **静态变异体的死活取决于整份 `mutate` 清单**、不是它自己那个文件（模块级变异体无 `coveredBy` ⇒ 跑本次相关集全部测试；实测单跑 41.18% vs 批内 35.29%）⇒ 趋势比较必须固定同一份配置；② `vitest.related` 默认 true 是 9 分钟而非几小时的**唯一**原因；③ 沙箱**深一层** ⇒ 凡数 `..` 定位仓库根的地方静默指错（改锚 `pnpm-workspace.yaml`）；④ `process.chdir()` 在 vitest-runner 里直接抛（`pool: 'threads'` 写死）；⑤ 沙箱**只在成功后才清**，残留副本（实测 3 目录 / 269 MB）让 ESLint 凭空报 **1809 个 error**—— ESLint 不读 `.gitignore`，Prettier 读。验收不能只写配置：临时 `break: 99` 实跑 ⇒ exit 1、`mutate` 指向不存在路径 ⇒ 守卫红。不设 `break`（同 T3a 先出基线）、不进 CI 每次 push、不修存活变异体。测试 2525 → 2533（224 → 225 文件）。**本条为摘要，全文见 [history.md](docs/claude-md-history.md)。**                                                                                                                            | 技术委员会 |
| 2.42.0 | 2026-09-15 | **T1b 接收端上线 + 客户端 `schemaVersion: 2` 撤帧** —— ① 端点 `log.onemipham.com` 在主机 2 起服务；验收不取「脚本说成功」，三条独立证据：`deploy.sh --check` = no drift、journald 的 `key=e2bebea5` 与 `keys init` 指纹一致、真 CLI 端到端两跑（2 事件 / 2 会话 / 2 安装，unknown 与 discarded 全 0）。② `stackFrames` 不再上网 —— 服务端从来不存（「只存聚合」下帧串无处安放），发了只白送 ~3 KB/次与一个隐私面；帧仍**脱敏**但只留本进程内存（不落盘、不上网），`frameCount` 保留。**顺序不可颠倒**（服务端必须先接受 v1），而 v1 已发布收不回来 ⇒ 汇聚路径长期保留，契约测试改**双向钉**（本批产物 `=== 0`、手写 v1 体 `=== 2`：只测前者 ⇒ 把脱敏整块删掉也能绿，只测后者 ⇒ 新契约无人守）。代价已认下并写进公开文档：**崩溃通道永远不能告诉你崩在哪一行**。③ **如实记录的偏离（§二 例外申请范畴）**：端点实际 **TLS 1.2 + 1.3** —— 主机 2 的 nginx 1.24.0 上，握手版本由该 443 地址的**默认 server** 决定（版本在 ClientHello 时定死，**早于** nginx 的 SNI 回调），官方 wontfix 到 **1.29.2**；故 vhost 里写 `TLSv1.3;` 无效，改为如实声明（行为一字不变、配置不再说谎，且将来升到 ≥1.29.2 时行为不会**突然**改变）。**教训：本机验过 ≠ 验的是生产那个对象** —— 本机 1.31.5 已带该修复、主机 1.24.0 不带；我一度据此宣布假设被证伪，是错的，已更正到 vhost 注释、`deploy/README.md` 与计划文件。④ 文档回填 `docs/telemetry.md`（撤帧 + 新增「接收端保留什么」）/ `apps/telemetry/README.md` / `ROADMAP.md`（`T1b` 标 `[x]` + **写死与 `T4` 的分工**：遥测只对 command / tool 形态投票，`task-runner` / 双轨 Runtime / `plan-runner` 改由 knip 未接线清单判定，**不得为此新增计数器**）。测试 2523 → 2525（224 文件）。**本条为摘要，全文见 [history.md](docs/claude-md-history.md)。** |
| 2.41.0 | 2026-09-15 | **`command_name` 基数无界修复（T1b 前置）** —— `command_calls` 的 label 直接来自用户输入（`parseSlashCommand` 返回 `parts[0]?.toLowerCase()`），而计数点 `app.tsx` 刻意放在注册表查询**之前**（`/switch` `/pick` `/model-picker` `/exit` `/quit` `/focus` 六个都提前 return）。两者相乘 ⇒ 敲 `/foobar` 当场新造一条序列，且**基数没有任何上界**：`payload.ts` 的 `MAX_LABEL_LENGTH` 只 `slice` **值**的长度、不限制键的个数。该文件同处的注释「Label cardinality is bounded by construction」对 `tool_name` 成立（工具集由注册表声明），对 `command_name` 是**事实错误**，已订正。修法：`commandLabelFor()` 认识就记它自己、不认识归 `/unknown`；`getCommandLabelNames()` （注册表 ∪ 预注册表别名 ∪ `/unknown`）成为服务端 allowlist 的派生源，allowlist 随之重新生成（138 → 140 条）。两处反直觉：`/model-picker` 是**用户可敲但不在注册表**里的别名，朴素的 `getCommand(name) === undefined` 会把它误归桶；收敛桶自己**也必须**进 allowlist，否则 `/unknown` 会被服务端再折叠进 `__other__`，等于白收敛（T4 正是读这张表投票）。`PRE_REGISTRY_COMMANDS` 与 `app.tsx` 是两处必须同步的清单，靠约定维护正是本仓库反复吃过的「有定义、无施加点」—— 故加守卫直接扫 `app.tsx` 的 `command === '/x'` 字面量，断言每个都在标签集里（已用「加一个假命令 ⇒ 必须红」验证有施加点）。零新增依赖。测试 2503 → 2506（223 文件不变）。                                                                                                                                                                                                                                                                                                                                                                  | 技术委员会 |
| 2.40.0 | 2026-09-15 | **遥测接收端（T1b）本体** —— 新建 `apps/telemetry/`（公开只写端点，**只存按服务端接收日分区的维度聚合**，零运行时依赖）。四组要害：**状态码由客户端 ack 语义倒推**（2xx/4xx 都被 ack 删条 ⇒ 429 绝对禁止、过载一律 503，且**绝不发 `Retry-After`**）；**去重单边偏置**（误差只会虚高，永不误删唯一事件 —— T4 按存在性投票删代码）；**基数用服务端 allowlist 而非数值上限**（公开写端点的数值上限可被填满，恰好毒掉 T4 投票依据）；`stackFrames` 接受但**不留存**（「只存聚合」下留不下）。**构建修正**：`tsc` 只 emit `.ts`，`src/allowlist.json` 未进 `dist/` ⇒ 构建产物启动即 ENOENT，而 vitest 原地转换让套件全绿 —— 已把拷贝并入 build 并加 `test/integrity/build-completeness.test.ts` 守住。测试 2494 → 2503（222 → 223 文件）。**本条为摘要，全文见 [history.md](docs/claude-md-history.md)。**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 技术委员会 |
| 2.39.0 | 2026-09-15 | **开 ESLint type-checked（T3b）** —— `eslint.config.js` 接 `parserOptions.projectService` + `allowDefaultProject`，`@typescript-eslint/no-floating-promises` 钉在 **`error`**，据此修掉 15 处真悬挂 Promise。三点都属「差一点就等于没做」：① **必须落 `error`，不能落 `warn`** —— 根 lint 脚本是裸 `eslint .`、**无 `--max-warnings`**，写成 `warn` 等于零强制（本仓库第三次「有定义、无施加点」，前两次是 `rules-loader` 接线与覆盖率阈值没有 CI 执行路径）。② **`allowDefaultProject` 不是可选项** —— `apps/cli/scripts/*.ts` / `vitest.config.ts` / `vitest.setup.ts` 都不在任何 tsconfig 内，`projectService` 会对它们整份文件抛解析错，而**解析错会静默压掉该文件的全部规则**；补上白名单后立刻浮出一个此前被掩盖的真悬挂 Promise（`sync-mipham-models.ts` 的 `main()`）。③ **既有告警不是「几百条」**（那是 ROADMAP 的估量），实为 14 条 + 5 个解析错，15 处按语义分类修、不搞一刀切：`void` 标记 9 处（刻意的 fire-and-forget，其中 `mcp/client.ts` 的 `disconnect()` 是**同步**签名、物理上无法 await）、补 `.catch()` 2 处（注释承诺了「离线静默失败」却根本没有 catch）、`await` 3 处（顺序确实错了，如 `stopDaemon` 文档承诺「无论成败都清理 PID/端口」却没等 `stop()`）。**验收证明** `apps/cli/test/integrity/lint-rules.test.ts` + fixture —— **不能用「仓库 lint 绿」当证明**（fixture 故意是错的、已被 `eslint .` 忽略，规则即使配置错仓库照样全绿），该测试以 `overrideConfigFile: true` + 内联配置重跑 fixture，断言恰好只报出这条规则。顺带修掉一个 ignore 缺口：ESLint 9+ 默认 lint dotfile，运行时产物 `apps/cli/.mipham/task-runner-test/solution.ts` 一直被当成项目源码解析。零新增依赖。测试 2492 → 2494（221 → 222 文件）。                                        | 技术委员会 |

> **本表只留最近 5 行**（滚动窗口，见上方 `## 最近提交` 的同名约定）—— 上表列的是**摘要**，

> 被挤掉的行与每条的全文本都在 history.md，逐字未删。
>
> **完整修订历史**（v1.0.0–v2.43.0，共 95 条）→ [`docs/claude-md-history.md`](docs/claude-md-history.md)。
> 需要查「某条规则是哪一版引入的、当时为什么改、谁审的」时读它。
