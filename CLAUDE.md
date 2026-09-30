# CLAUDE.md

> **项目**: Mipham Code — AI 编程终端
> **仓库**: One-Mipham/mipham-code
> **公司**: One Mipham Corporation | 品牌: MiphamAI
> **产品**: 多模型开源智能编程终端
> **版本**: 2.94.11
> **最后更新**: 2026-09-29 — **0.85.11：重试与等待的补齐 + 三处闸门的收窄 + 一条来历可见（11 fix + 1 feat，另附三处测试夹具）** —— 十一 fix 的公共形状 = **「能力已声明、施加点缺席或缺一环」**。① **无模型可回退时点名模型与 provider** 并给出下一步（`Ctrl+P`）—— 从前吐的是底层错误，而裸错误读起来像「模型答错了」，可这一轮**没有任何模型输出**；两个无回退出口都接上。② **原地重试一次**再轮到跨 provider 回退（上界恰一次；已流出的块收不回 ⇒ 会重发，与既有回退同性质），**529 纳入重试集合**（与 503 同性质，4xx 仍不重试）。③ **MCP 工具调用先等握手中的服务器** —— 与 `mcp_tool` 钩子走**同一条等待**，两个入口对「正在连接」的服务器同等待遇。④ 钩子的 `additionalContext` 接进 `hookWarnings`（它唯一能到模型的通道），**并修掉紧随其后那行赋值对它的整段覆盖** —— 只接前者，功能等于没接。⑤ `permissionDecision` 只在 **ask/deny** 时拒绝（无交互提示 ⇒ ask 即硬拒），**allow 有意不认** —— 钩子可以来自仓库自带设置，不能让它自我放行；判据是**方向不是键名**。⑥ **项目级 agent 不得把权限放宽到父档之上** —— 判定用方向表而非 `indexOf`（`acceptEdits` 与 `default` 不可比，`indexOf` 会漏拒两格）。⑦ **压缩器压完再判一次**，仍超预算则再压一趟且更狠（有界两趟，第一趟与旧码逐字等价）。⑧ **记忆文本注入前先中和**（抹掉不可见字符与 `<…>` 形状游程）使内容无法闭合它被裹进的 `system-reminder` 块，且**先中和再截断** —— 否则跨边界的标签会被截成无终止形状、由外层自己的 `>` 补齐。⑨ **`.mipham/rules/*.md` 按形状拒绝并报告** —— 它的正文**逐字**注入会话并送往模型，是**出站**路径而非只是配置目录，而`readDir` 里那个空 `catch {}` 放符号链接／目录／FIFO 一并渗入；`lstat` 而非 `stat`（链接报自己是链接），**未加载与未通过是两回事** ⇒ 按路径去重报 stderr。理由具名：**不解析后再判包含** —— 工程根恰是用户那份 gitignored 秘密（`.env`、`.mipham/keys`）的所在，`-> ../../.env` 能过包含闸而照样泄。边界如实记：非 TOCTOU 安全。⑩ **自动循环的提示词不再让模型去写 CLI 自己的账** —— 原提示词让模型调 `logAutoloopIteration(...)`（**模块导出不是工具**，无从调用）并自行读写`~/.mipham/autoloop/<id>.json`（会**覆盖** CLI 维护的迭代计数／token 合计／状态）；改为要求**每轮以一行纯文本说出进度**，并给「本轮没有可见输出」一个具名标记。⑪ **读码优先规则不再把 `graft` 说成自己的工具**（它是经 Bash 运行的 CLI，仓库里没有任何一处注册过它）。**feat**：`/crsi lessons` 报出每条常驻教训的**档位来历** —— `severity` 是归一化后的读数，「有人判过」与「没人写过」同形，而 `critical` 每一条都随**每一次请求**发出去；加**必填** `severitySource`（可选的话下一个构造点忘了给，取到的默认值恰好**说反了**）+ 名册分开报数并逐条点名；来历只供人复核、不参与任何判定（一条翻转测试钉住三处输出逐字不变）。**已知边界**：来历不跨代（合并产物逐字写回 `- 严重度:`，回读是 `declared`）。同批三处**测试夹具改按形状构造**（原先以「真仓库长什么样」为前提，而变异测试的沙箱把仓库压平 ⇒ 那条流水线的干跑直接失败，红在夹具上）。测试 3,761（306 文件；本机 3,759 + 2 skipped，CI 3,751 + 10 skipped，0 失败）。
> **前一条（2.94.10）**: 2026-09-28 — **0.85.10：教训召回扳机 + CI 供应链加固（1 feat 收两项，另附 bump / 三份 CHANGELOG / 文档回填）** —— ① **召回扳机挂在「工具刚失败」这个事件上，而不是把指针再写一遍**：常驻教训进系统提示、其余降级成一句指针，而指针只说「东西在那儿」、说不出「现在是看它的时机」，时机只能挂**事件**；原先设想的两个落点（折叠后 / 会话恢复）因此作废 —— `/resume` 会**重跑** `setSystemPrompt()`，那两处的指针都是刚生成的。**形状由消息配对约束决定**：`injectContext` 推的是 user 消息，塞进 assistant 的 `tool_use` 与配对的 user `tool_result` 之间会把配对打断 ⇒ 只能**延迟到本轮 tool_result 都追加完之后**，与规则注入同形 ⇒ 两处调用点（首轮与多轮循环）**各接一次**。判据取执行结果的**成功位**而非「有没有抛」（失败返回有**八种**形状，逐处埋点必漏）；每会话一次；措辞**非指令式**；与指针**共用同一判据** ⇒ 不会出现「扳机响了但没有指针」的两声哨。daemon 侧**有意不接**：它从不设置系统提示，那条路径上既无常驻块也无指针。② **CI 的 action 引用钉到 40 位 SHA**：`uses: …@vN` 里的 `vN` 是**可移动的 ref**，而工作流握着 npm 的 OIDC 发布权与 release 资产上传权 ⇒ **46 条**（CI 28 + Release 18）全钉 SHA 并保留 `# vN` 注释（Dependabot 的 `github-actions` 生态靠它提升级 PR）。守卫 `workflow-pinning.test.ts` 带**正对照**（解析条数 == 源码里 `uses:` 的裸行数），否则正则漏掉的那些在「全部合规」里根本不出现。③ **构建产物自报用法**：`bun build --compile` 成功 **≠** 产物能跑 ⇒ CI 里跑一次 `--help`（commander 的注册表本身）与 `--version`（必须与 `package.json` 逐字相符）；判据**先收进变量再 grep、不走管道**（`| grep -q` + `pipefail` 的成败取决于管道缓冲，也就是取决于运气）。测试 3,696 → **3,714**（304 → **305** 文件）；CI **9/9**（`gh run 36421104366`，headSha == `4408d3fb`）。
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
- **eval harness** `/crsi eval` — `core/eval-harness.ts` 冻结 40 条 ground-truth 契约（规则/宪法/沙箱边界/完整覆盖闸/语义边界/红队/producer/行为缺口/行为任务）+ rewards 日志 `~/.mipham/crsi/eval-scores.jsonl`，`runCrsiModification` 以「分数不退化」为第二道闸。8 行为缺口（rm -rf/管道投毒/git reset --hard/chmod 777/mkfs/dd→/dev//关停主机/crontab -r）已由固化 managed tool-params 规则覆盖 → 全翻转 PASS → 满分 100 =「证明更好」
- **任务表现评估 + 改进轨** `/crsi bench` — `core/task-performance.ts`（LLM 生成代码 → 冻结测试判定 → 分数；skill 注入）+ `core/improvement-track.ts`（多次采样 → 噪声自适应 `minEffect = max(20, 2×噪声)` → verdict improved/regressed/inconclusive + Wilson 改进率 + 台账 `~/.mipham/crsi/improvements.jsonl`）；`/crsi modify` 只拦 regressed（倒退才拦，因果归因/最小效应量/误提升预算/改进率四项）

CLI 命令：`/crsi rules|disable|analyze|restore|stats|health|inventory|modify|propose [--rule|--prose|--crossover]|prose-clear|lessons|eval|meta|interpret|critique|red-team` + `/sis errors|stats|clear|cleanup`
测试：3,836 测试（本机 3,834 passed + 2 skipped，309 文件；CI 3,826 passed + 10 skipped —— 同 3,836 总数，差异只在跳过数（本机 2 / CI 10），`gh run 36709964611`，headSha == `9e4ca41f`，0 失败）

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
│   │   │   ├── skills/         # loader（Skills 唯一接线路径）
│   │   │   ├── mcp/            # MCP 客户端 + Tool Search
│   │   │   ├── agent/          # 后台 Agent、消息总线、类型定义
│   │   │   ├── agent-view/     # Agent 会话管理 UI
│   │   │   ├── workflow/       # Workflow 运行时 + Schema 验证
│   │   │   ├── config/         # loader + defaults
│   │   │   └── ui/             # app, chat, input, commands, picker
│   │   ├── skills/             # 28 个内置技能（22 standard + 6 mipham）
│   │   ├── test/               # 309 个测试文件，3836 个测试
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
pnpm test         # vitest run（3836 个测试）
pnpm typecheck    # tsc --noEmit
pnpm mutate       # stryker run（变异测试；~31 分钟，**必须在本目录下跑**，见 ROADMAP T3c）

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

**「双轨运行时」已于 T4 删除**：`src/skills/{standard,mipham}/runtime.ts` 自 v0.1.0（`27609bf`）起生产零引用 —— `loader.ts` **从不加载它们**，是又一例「有定义、无施加点」。Skills 的实际生效路径只有 `loader.ts` 一条。

### Slash 命令系统（138 个）

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
- `permission.ts` — 权限控制（**内部枚举 5 档**：default/acceptEdits/plan/auto/bypassPermissions；Shift+Tab 转盘只有 4 档（`default → acceptEdits → plan → auto`），`bypassPermissions` **合法但不在转盘上**（用户级 `config.yml` / 用户级 `settings.json` 的 `permissions.defaultMode` / `--permission` / `MIPHAM_DAEMON_PERMISSION` 指名可达；项目级那两个文件**不是门**）—— CC 也是这个结构，其描述表列它、转盘数组不列。**第 6 档 `dontAsk` 刻意不加**（我们与 CC 的 `default` 行为本就等于 CC 的 `dontAsk` —— 没有弹窗，`ask` 即硬拒）。`permissionRestrictions`（forbiddenModes/maxAllowedMode）org 级强制降级，请求被禁模式时 fail-closed）
- `hooks.ts` — 生命周期钩子（13 种事件，含 SubagentStart/Stop/PostToolUseFailure）
- `instructions.ts` — 指令加载链（集团/公司/用户层 + git 根→cwd 递归项目层；逐目录读 AGENTS.md / AGENTS.override.md / CLAUDE.md / MIPHAM.md 三格式，就近优先、读全部不丢弃）
- `rules-loader.ts` — 路径作用域规则（.mipham/rules/\*.md → glob 匹配 → 自动注入）。**已于 2.37.3 接线**：`index.tsx` 启动时 `new RulesLoader(process.cwd())` + `engine.setRulesLoader()`（setter 自带 `load()`）；注入点在**两处**工具执行后 —— `process()` 首轮（`engine.ts:760`）与 `continueWithTools()` 多轮（引擎多轮循环末尾），只接前者会让规则迟一轮用户输入才生效。以下为接线前的原始诊断（保留备查）：`new RulesLoader` 全历史零出现，`engine.ts:339` 的 `setRulesLoader` 零调用点（自 e2be832「Sprint 5 — rules system」起只有定义没有接线），`engine.ts:24` 该 import 的符号仅用于类型位故转换时被丢弃 → 模块从不加载、守卫永远早退；knip 未报（只看到 import 边），系覆盖率实测发现。**daemon 侧已于 2.44.0 收口**（`daemon/engine-capabilities.ts` 的 `wireDaemonEngine` + 源码对等/行为两条守卫）；原文写的「constitution 一个都没接」是误报 —— `align:` 全仓库无人声明，宪法执行链一直是活的

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

会话日志（M1）：`core/session-log.ts` — `SessionEvent` 十变体 + `messageToEvents`/`deriveMessages` 字节级互逆 + append-only JSONL（「model-visible means logged」）。

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
| core            | 89      | 1517     | engine / context / permission / hooks / crsi / memory / instructions / paths 等                                                                                             |
| tools           | 26      | 419      | bash / file / exec / skill / agent / scheduling / seam                                                                                                                      |
| daemon          | 37      | 252      | feishu / telegram / 钉钉 / 企业微信渠道 + session / auth / auth-rotate / workspace-guard / logger + **引擎接线行为**（`engine-capabilities`）                               |
| ui              | 27      | 295      | commands / input / config-wizard / loop / skill-doctor / ctrl-c                                                                                                             |
| agent           | 13      | 132      | sub-agent / background-registry / pattern-analyzer / effectiveness-tracker                                                                                                  |
| security        | 11      | 109      | fd / path / url 净化 + permission-gate + penetration（6 个攻击面）                                                                                                          |
| providers       | 9       | 143      | anthropic / openai-compat / registry / llm-replay / bootstrap                                                                                                               |
| mcp             | 11      | 113      | client / transport / oauth / token-store / registry / instructions（含 2 skipped）                                                                                          |
| workflow        | 8       | 61       | runtime / loop / parallel / sandbox / journal / verify                                                                                                                      |
| vajra           | 6       | 53       | context / events / service / compose / leaf（自建内核）                                                                                                                     |
| shared          | 11      | 130      | arg-validation / deleted-cwd / sanitize / graft / update-async                                                                                                              |
| commands        | 9       | 95       | keys / cd-suggest / loop-scaffold / autoloop-journal / permissions / init-providers / provider-model-flags                                                                  |
| skills          | 5       | 35       | sanitizer / marketplace / fork-executor / skill-assets                                                                                                                      |
| config          | 10      | 117      | credential-crypto / loader-encryption / defaults / settings-json / preferences                                                                                              |
| plugin          | 4       | 57       | claude-plugin / plugin-manager                                                                                                                                              |
| artifacts       | 1       | 6        | manifest                                                                                                                                                                    |
| agent-view      | 4       | 37       | agent-view-manager / dashboard-keys / session-view                                                                                                                          |
| e2e             | 1       | 8        | full-pipeline                                                                                                                                                               |
| integrity       | 18      | 127      | 引用完整性守卫 + ESLint 规则生效证明 + **遥测契约**（CLI ↔ `apps/telemetry` 逐字段，含 endpoint ↔ vhost 目的地）+ **变异测试范围**（`mutate` 清单 vs 磁盘枚举，延后表明写） |
| telemetry       | 9       | 130      | redact / consent / queue / payload / crash / transport / endpoint / 门面 / 双路径计数一致性                                                                                 |
| **合计**        | **309** | **3836** | **0 失败** ✅（本机 3,834 + 2 skipped，309 文件；CI 3,826 passed + 10 skipped —— 同 3,836 总数、不同跳过切分，`gh run 36709964611`，headSha == `9e4ca41f`）                 |

> **本表只统计 `apps/cli/test/`。** `apps/telemetry` 是独立工作区（12 文件 / 179 测试，自带
> `vitest.config.ts` 与阈值），**不在上表内**，全量跑用 `pnpm -r coverage`。
> `integrity` 行的 18 个守卫文件含 **daemon 能力对等**（`daemon-capability-parity.test.ts`：14 个注入点
> 全集 − 具名豁免表 = daemon 实接集，两向相等）与 **T4 未接线处置**（`unwired-disposition.test.ts`：
> 删的必须不存在、留的必须仍零引用，陈旧豁免为红），外加 **状态写侧族守卫**（`state-write-integrity.test.ts`：
> 裸写清单两向相等 —— 新成员不在清单里为红、清单陈旧也为红，且已收口模块必须仍见得到助手调用）
> 与它的**读侧姊妹件** `read-side-shape.test.ts`（往真 store 写毒化负载、经真加载器读回；每个成员都配
> 良构正向对照——没有它，畸形那半全绿可能只是因为探针压根没读到那个文件），外加 **工作流钉 SHA**
> （`workflow-pinning.test.ts`：每条 `uses:` 必须钉 40 位 commit SHA 且带 `# vN` 注释 —— Dependabot
> 与人都靠那个注释；配一条「解析条数 == 源码里 `uses:` 裸行数」的正对照，否则漏解析的那些在
> 「全部合规」里根本不出现）。
> **注意别把这类
> 说明写进上表单元格** —— 该列宽由最宽一行决定，加长一行 prettier 会重排全表 23 行（本批实测
> +2,662 字符，正是 `CLAUDE.md` 越过 40k 的那一次）。
> **跑 `apps/cli` 全量必须 `cd apps/cli` 再跑**，`--root apps/cli` **不够** —— MCP 测试
> spawn 子进程（`bun run test/mcp/mock-server.ts`）且 `StdioTransport.start` 不传 `cwd`，
> 子进程继承 `process.cwd()`；从仓库根跑会 **31 个假红**（`mcp/*` 28 + `crsi-sandbox` 3），
> 全是路径问题，别去查 MCP 代码。

> **若本机 `git` 报 Xcode 许可证未接受**：`core/crsi-*` 与 `core/instructions` 中 21 个测试会 shell 调真
> `git`，会被一并挡住而**假红**（极易误判为回归 —— 曾实际发生）。判定方法：把这些文件单独跑一遍，
> 看报错是否为 `You have not agreed to the Xcode license agreements`；或直接 `/usr/bin/git --version`。
> 一次解决：`sudo xcodebuild -license accept`（**保持 Xcode 为活动开发者目录**，不影响 §十六 的打包公证；
> 换 `xcode-select -s` 到 CommandLineTools 则会连带把 `productbuild` / `xcrun notarytool` 切走，勿用）。
> 2026-09-15 已在本机执行，全量 **2510 passed + 2 skipped / 0 失败**。

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

> **变更记录不放在本文件里** → [`docs/claude-md-history.md`](docs/claude-md-history.md)：最近提交全表 +
> v1.0.0 起全部修订。查「某次改动属于哪次提交 / 哪一版 / 当时为什么改」时读它。
>
> **为什么不留表（2.66.0 起的硬约定）**：本文件每次会话整份加载，且与本仓其余指令文件**共用**
> 40,000 字符预算，而这两张表
> **每次改动都必须增长** —— 只要表住在文件里，就必然反复「超限 → 压缩 → 又超限」。收紧窗口治不了本：
> prettier 把 markdown 表的列宽设成**最宽那一行**、全表按它补齐，故新增一行的边际成本 ≈
> **最宽行宽 × 行数**，不是该行自身的长度（实测：一行写成 1,023 字符 ⇒ 整表 3,432 → 9,383 字符）。
> 两段合计曾占全文 **21.9%**（8,230 字符）。移出后本文件不再随每次改动增长；当前版本的要点写在
> 文件头的 `最后更新` / `前一条` 两行（散文，1:1 成本、无 padding），旧的逐字落进 history.md 的
> 「窗口行存档」。由 `apps/cli/test/integrity/tool-reference-integrity.test.ts` 机器强制：两段
> **零数据行** + 指针在位 + **存档在位且两张全表都还在**，连同**本仓指令载荷 ≤ 40,000 字符**的体积预算
> （2026-09-28 换向：旧尺量的是单份 `CLAUDE.md` 在盘上的字符数，与启动告警量的**装载总额**互不相干
> ⇒「守卫绿」与「告警响」可以并立；现量装载器自己那一份读数，且与告警用**同一个常量**）——
> 40k 是当初触发拆分的红线（拆分 17 小时后曾二次越过：21,193 → 56,001）。

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

> **已完成的批次不放在本文件里** → [`docs/claude-md-history.md`](docs/claude-md-history.md)：2026-08-16 起
> 四个「已完成」批次的**逐字原文**（19 条）。查「某个已收口的计划属于哪一批、当时做到哪」时读它。
>
> **为什么搬（2026-09-28）**：这一段与「最近提交 / 修订历史」是**同一物种** —— 每次收口都必然增长，
> 而它对每一次会话的载荷毫无贡献（只有**回看**时才需要）。搬走的 19 条正文实测 1,767 字符
> （`CLAUDE.md` 32,114 → 30,633）。留下的**待办**是活的，故留原位。

**待办**：

1. **Bot 远程控制扩展** — Feishu（v0.47.0）+ Telegram（长轮询）+ 企业微信（长连接 WebSocket，v2.7.2）+ 钉钉（Stream Mode 长连接，v2.10.0）四频道已全部落地
2. **桌面 App** — macOS/Windows 桌面版（大工程，暂不排期）
3. **Obsidian MCP `get_vault_info` 第三方 bug** — `@zethictech/obsidian-mcp` 调了不存在的 `obsidian vault` 命令（1/34 工具），不影响写 note（save-to-wiki skill 已注明绕开）；等上游修复

---

### 修订历史

> **完整修订历史** → [`docs/claude-md-history.md`](docs/claude-md-history.md)：v1.0.0 起全部条目，
> 查「某条规则是哪一版引入的、当时为什么改、谁审的」时读它。
>
> **本文件不再保留任何条目**（同上方约定，2.66.0 起）：表住在 40k 预算的文件里就必然随每次改动
> 增长。被挤出的窗口行**逐字**存进 history.md 的「窗口行存档」。
