# CLAUDE.md

> **项目**: Mipham Code — AI 编程终端
> **仓库**: One-Mipham/mipham-code
> **公司**: One Mipham Corporation | 品牌: MiphamAI
> **产品**: 多模型开源智能编程终端
> **版本**: 2.61.0
> **最后更新**: 2026-09-19 — **定向安全审计批次 3（七笔 `f0cc571`→`26153a2`，E1–E8）**：七条一个共同形状 —— **判据拿的是「近似的替身」，不是真对象**：后缀之于词、子串之于名字、拼写之于 git 真正收到的 argv、`process.cwd()` 之于 `ctx.cwd`。① 无参构建工具注册表（daemon / workflow 走的路径）拿到的是一份**专门为「对齐 pre-seam 行为」造出来的关闭态掩码** ⇒ Read/Bash/Grep/Glob 的掩码整套失效、子进程继承完整 `process.env`、输出不擦洗；改取用户级策略 —— 安全控制的方向不留「没配置就关掉」这种默认值。② 项目级 `credential_masking` 能**关掉**掩码也能**顶掉**默认规则 ⇒ 改为只许收紧（合并而非替换），与 `baseUrl`「只有受信层级能覆盖」同一条判据。③ bash 子进程不自成进程组 ⇒ 超时只收得掉一层，且读输出先于退出；改 `detached` + 收整组 + 先等退出。④ 默认 env 过滤按**后缀**匹配 ⇒ 词在中间的 `AWS_ACCESS_KEY_ID`、`GH_PAT`、`HTTP_AUTHORIZATION` 全漏；改按**词**匹配，反方向也不许中招（`SSH_AUTH_SOCK` 被掩掉，Bash 里的 ssh/git 当场找不到 agent）。⑤ `DATABASE_URL` 内嵌的口令**名字上没有任何秘密词**，按名字永远看不见 ⇒ 补一条**按形状**的 URL userinfo 擦洗。⑥ EnterWorktree 的 `baseRef` 落进 git 的**选项槽**（本机实测 `--force` 被当选项吃掉并建成）⇒ argv 层加 `--`。⑦ Bash 三处失败归因指错根因（cwd 没了说成「bash 没装」、被超时收掉只报 `Exit code 137`、负数 timeout 被归一成 1ms 定时器）⇒ 说出真正发生了什么。⑧ worktree「在不在列表里」原是**子串**判定 ⇒ `w1` 命中 `w10` 那行（EnterWorktree 因此连 `w1` 都建不出来），尾斜杠与别名拼法反被报成 not found；改按名字判定 + 两侧 realpath，ExitWorktree 的归一化基数改回 `ctx.cwd`。测试 2725 → 2767（235 → 241 文件）。
> **前一条（2.60.0）**: 2026-09-19 — **定向安全审计批次 2（config 两笔 `8fe01ad`/`500abf5`，C1–C4）**：四条同形 —— **不变式早在别处写好了（甚至就写在同一个文件里），施加点没接上**，失效方向都指向**静默丢数据**。① `getOrCreateKey` 是 `~/.mipham/.cred-key` 的唯一写者，却写成 existsSync → 生成 → **裸 `writeFileSync`**：同机并发的第二个进程把密钥**整份覆盖**，此后两边各持一把钥匙、谁的 `enc:v1:` 密文对方都解不开，**全程零报错**；改 `{ flag: 'wx' }` + `EEXIST` 回读（覆盖不可逆，让**这一次**失败是最便宜的一侧）。② 同一处的权限**先松后紧**：裸写在 umask 022 下落 0644、靠事后 chmod 补救 ⇒ 崩在两者之间就永久 0644，而读取路径**从不看权限**，那份就永远是 0644；改 `{ mode: 0o400 }` 由内核在创建时给定 + 读取路径收紧（判据取**写入当下**的模式，不取函数返回后的 —— 后者由事后 chmod 补上，恰好看不见崩在中间的那次）。③ `mkdirSync` 无 mode ⇒ 密钥目录落在 0755。④ `decryptProviderApiKeys` 两处 `p.apiKey.startsWith` 与 `mergeProviders` 的 `op.id` 都没 `typeof` 守卫（同文件 `getProviderApiKey` 早写了这条不变式）⇒ `apiKey: 12345` 让**整个 CLI 起不来**，`providers: nope` 更隐蔽（字符串被当可迭代对象，逐**字符**当 provider 塞进结果再炸）。非字符串一律读作「没有键」，与整个省略该字段逐字段等价。测试 2715 → 2725（234 → 235 文件）。
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
- **eval harness** `/crsi eval` — `core/eval-harness.ts` 冻结 38 条 ground-truth 契约（规则/宪法/沙箱边界/完整覆盖闸/语义边界/红队/producer/行为缺口/行为任务）+ rewards 日志 `~/.mipham/crsi/eval-scores.jsonl`，`runCrsiModification` 以「分数不退化」为第二道闸。8 行为缺口（rm -rf/管道投毒/git reset --hard/chmod 777/mkfs/dd→/dev//关停主机/crontab -r）已由固化 managed tool-params 规则覆盖 → 全翻转 PASS → 满分 100 =「证明更好」
- **任务表现评估 + 改进轨** `/crsi bench` — `core/task-performance.ts`（LLM 生成代码 → 冻结测试判定 → 分数；skill 注入）+ `core/improvement-track.ts`（多次采样 → 噪声自适应 `minEffect = max(20, 2×噪声)` → verdict improved/regressed/inconclusive + Wilson 改进率 + 台账 `~/.mipham/crsi/improvements.jsonl`）；`/crsi modify` 只拦 regressed（倒退才拦，因果归因/最小效应量/误提升预算/改进率四项）

CLI 命令：`/crsi rules|disable|analyze|restore|stats|health|inventory|modify|propose [--rule|--prose|--crossover]|prose-clear|eval|meta|interpret|critique|red-team` + `/sis errors|stats|clear|cleanup`
测试：2,767 测试（2765 passed + 2 skipped，0 失败）

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
│   │   ├── test/               # 241 个测试文件，2767 个测试
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
pnpm test         # vitest run（2767 个测试）
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

**「双轨运行时」已于 T4 删除**：`src/skills/{standard,mipham}/runtime.ts` 自 v0.1.0（`27609bf`）起生产零引用 —— `loader.ts` **从不加载它们**，是又一例「有定义、无施加点」。Skills 的实际生效路径只有 `loader.ts` 一条。

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
| core            | 73      | 1091     | engine / context / permission / hooks / crsi / memory / instructions / paths 等                                                                                             |
| tools           | 25      | 383      | bash / file / exec / skill / agent / scheduling / seam                                                                                                                      |
| daemon          | 34      | 208      | feishu / telegram / 钉钉 / 企业微信渠道 + session / auth / auth-rotate / workspace-guard / logger + **引擎接线行为**（`engine-capabilities`）                               |
| ui              | 12      | 165      | commands / input / config-wizard / loop / skill-doctor                                                                                                                      |
| agent           | 11      | 113      | sub-agent / background-registry / pattern-analyzer / effectiveness-tracker                                                                                                  |
| security        | 10      | 99       | fd / path / url 净化 + permission-gate + penetration（6 个攻击面）                                                                                                          |
| providers       | 7       | 99       | anthropic / openai-compat / registry / llm-replay / bootstrap                                                                                                               |
| mcp             | 8       | 89       | client / transport / oauth / token-store / registry（含 2 skipped）                                                                                                         |
| workflow        | 7       | 55       | runtime / loop / parallel / sandbox / journal / verify                                                                                                                      |
| vajra           | 6       | 53       | context / events / service / compose / leaf（自建内核）                                                                                                                     |
| shared          | 8       | 48       | arg-validation / deleted-cwd / sanitize / graft / update-async                                                                                                              |
| commands        | 6       | 50       | keys / cd-suggest / loop-scaffold / autoloop-journal / permissions / init-providers                                                                                         |
| skills          | 5       | 35       | sanitizer / marketplace / fork-executor / skill-assets                                                                                                                      |
| config          | 9       | 59       | credential-crypto / loader-encryption / defaults / settings-json / preferences                                                                                              |
| plugin          | 2       | 32       | claude-plugin / plugin-manager                                                                                                                                              |
| artifacts       | 1       | 6        | manifest                                                                                                                                                                    |
| agent-view      | 1       | 9        | agent-view-manager                                                                                                                                                          |
| e2e             | 1       | 8        | full-pipeline                                                                                                                                                               |
| integrity       | 6       | 45       | 引用完整性守卫 + ESLint 规则生效证明 + **遥测契约**（CLI ↔ `apps/telemetry` 逐字段，含 endpoint ↔ vhost 目的地）+ **变异测试范围**（`mutate` 清单 vs 磁盘枚举，延后表明写） |
| telemetry       | 9       | 120      | redact / consent / queue / payload / crash / transport / endpoint / 门面 / 双路径计数一致性                                                                                 |
| **合计**        | **241** | **2767** | **0 失败** ✅（2765 passed + 2 skipped）                                                                                                                                    |

> **本表只统计 `apps/cli/test/`。** `apps/telemetry` 是独立工作区（12 文件 / 179 测试，自带
> `vitest.config.ts` 与阈值），**不在上表内**，全量跑用 `pnpm -r coverage`。
> `integrity` 行的 6 个守卫含 **daemon 能力对等**（`daemon-capability-parity.test.ts`：14 个注入点
> 全集 − 具名豁免表 = daemon 实接集，两向相等）与 **T4 未接线处置**（`unwired-disposition.test.ts`：
> 删的必须不存在、留的必须仍零引用，陈旧豁免为红）。**注意别把这类
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

| 日期       | Commit    | 说明                                                                       |
| ---------- | --------- | -------------------------------------------------------------------------- |
| 2026-09-19 | `26153a2` | fix(tools): worktree 列表按名字判定 + ExitWorktree 基数（批次 3 · E8）     |
| 2026-09-19 | `f021fe9` | fix(tools): Bash 三处失败归因指向错的根因，改为说出真实原因（批次 3 · E7） |
| 2026-09-19 | `ecf1e35` | fix(config): 默认凭据过滤按「词」匹配 + URL 内嵌口令擦洗（批次 3 · E6）    |

> **完整记录** → [`docs/claude-md-history.md`](docs/claude-md-history.md)：两张表的全表 + v1.0.0 起全部修订，
> 查「某次改动属于哪次提交 / 哪一版」时读它。
>
> **滚动窗口（硬约定）**：本表与下方 `### 修订历史` 各**只保留最近 3 行**，新增必须挤掉第 4 行；被挤掉的行
> 都已在 history.md，逐字不丢。由 `apps/cli/test/integrity/tool-reference-integrity.test.ts` 的「变更记录
> 滚动窗口与文档体积」守卫机器强制，连同「CLAUDE.md ≤ 40,000 字符」的预算 —— 40k 是当初触发拆分的红线
> （拆分 17 小时后曾二次越过：21,193 → 56,001）。

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

| 版本   | 日期       | 变更内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 维护人     |
| ------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| 2.59.0 | 2026-09-19 | **定向安全审计批次 1：四条「检查没跑到该跑的地方，或拿着错的对象在比对」（daemon 三处 + Git 执行面，两笔 `f9a6a49` / `851fa1a`）** —— **(D1) 令牌比较：替身比被替身者更有能力，缺陷被藏住而非被抓住。** `daemon/auth.ts` 的 `verifyToken` 调 `Bun.password.constantTimeCompare`，而**真实 Bun 无此方法**（1.3.14 实测只有 `hash/hashSync/verify/verifySync`）⇒ 抛 TypeError，**每个远程已认证请求都收 500**；套件一直绿，因为 `vitest.setup.ts` 的替身**把这个方法补上了**（只把替身改忠实即当场 **5 红**，含两条 `authMiddleware` ⇒ 藏的是中间件整层）。改用 `node:crypto` 的 `timingSafeEqual`，**先判等长**（长度不等会抛 `RangeError`；等长与否本身即不匹配）。**(D2) 开发错误页：生产 daemon 跑在开发模式。** `Bun.serve` 未显式给 `development`，Bun 默认取 `NODE_ENV !== 'production'`，而 fetch 处理器**无顶层 try/catch**；实测**未关 = 67,154 字节 HTML / 关 = 21 字节纯文本**，显式 `development: false`。**未证不写**：开发页是否回吐源码帧，探针**未取到**。**(D3) 令牌轮换：写盘成功、运行中的 server 没换。** `token` 是解构出的 **const** ⇒ rotate 路由**仍收旧令牌、拒绝它刚发出去的那一个**；改可变 `activeToken` + 独立起服务的 `auth-rotate.test.ts`（轮换破坏性）；CLI 侧补一行「运行中的 daemon 保留旧令牌直到重启」—— **删掉它等于用沉默让人相信轮换已生效**。**(E4) Git「选项即程序」：无审批工具放行了需要审批的能力。** `permission: 'auto'` 只挡了按拼写组织的一批正则，漏掉「选项的值本身就是要跑的程序」：`--upload-pack`/`--receive-pack`/`--exec-path` 与 `-c`/`--config` 下的 `core.sshCommand` / `core.pager` / `core.askpass` / `core.editor`、`alias.*`、`credential.helper`。**判据改挂 argv**（git 真正拿到的东西）而非原串：按拼写组织的正则需要预判所有文本写法，中间带引号即整条绕过；另附 120s 超时（否则卡住即挂死整轮）。**实测两处与子代理报告不同**：`--upload-pack <cmd>` **空格形式同样生效**；分页器一族**经此工具不可达**（无 TTY）⇒ pager 是纵深防御、不是活口子。测试 2702 → 2715（233 → 234 文件）。**本条为摘要，全文见 [history.md](docs/claude-md-history.md)。** | 技术委员会 |
| 2.60.0 | 2026-09-19 | **定向安全审计批次 2：config 四处「不变式写在别处、施加点没接上」（C1–C4，两笔 `8fe01ad` / `500abf5`）** —— 共同形状：**规则早已写在代码里（甚至就写在同一个文件里），但真正会读到那个值的地方没有施加**，失效方向都指向**静默丢数据**而非崩溃。(C1) **凭据密钥竞态** —— `getOrCreateKey` 是 `~/.mipham/.cred-key` 的**唯一**写者（`enc:v1:` 与 MCP token 共用），写法却是 `existsSync` → 生成 → **裸 `writeFileSync`**：CLI 与 daemon worker 同机并发是常态，缝隙里的第二个进程把刚落的密钥**整份覆盖**，此后两边各持一把钥匙、各自写下的密文对方都解不开，而**全程没有任何报错**。改为 `{ flag: 'wx' }`、`EEXIST` 时**回读**对方那把（这才是 `wx` 的正确收尾）—— 方向刻意如此：覆盖不可逆且无声，让**这一次**失败是最便宜的一侧。判据把交错**造出来**（同 `atomic-write` 法：同步 fs 单进程没法真并发）：让 `existsSync` 对本进程谎报「不存在」，而盘上那份竞态者的密钥是真的。(C3) **权限先松后紧** —— 裸写在 umask 022 下落成 0644、靠**事后** `chmodSync` 补救：崩在两步之间就永久停在 0644，而读取路径**从来看都不看**权限。改为 `{ mode: 0o400 }` 由内核在创建时给定 + 读取路径收紧；判据取**写入当下**的模式，不取函数返回后的 —— 后者由事后 chmod 补上，恰好看不见崩在中间的那次。(C4) **密钥目录 0755** —— `mkdirSync` 没给 mode，补 `0o700`。负对照逐条只摘一个机制：摘掉读取路径收紧 + mkdir 的 mode ⇒ **恰好 2 条红**，而 `wx` 那条与「写入当下即 0400」那条保持绿。(C2) **config.yml 字段类型** —— `decryptProviderApiKeys` 两处 `apiKey.startsWith` 与 `mergeProviders` 的 `op.id` 都没 `typeof` 守卫，而同文件的 `getProviderApiKey` **早把这条不变式写进代码了**：`apiKey: 12345` 不是「没配密钥」而是**整个 CLI 起不来**；`providers: nope` 更隐蔽 —— 字符串被当可迭代对象，逐**字符**当 provider 塞进结果再炸。非字符串读作「没有键」。**一次自我纠错（如实记）**：第一版断言它等于 `''`，实测回落到 provider 默认的 `${DEEPSEEK_API_KEY}` —— 那是更对的行为，故**改的是断言不是代码**。测试 2715 → 2725（234 → 235 文件）。**本条为摘要，全文见 [history.md](docs/claude-md-history.md)。**          | 技术委员会 |
| 2.61.0 | 2026-09-19 | **定向安全审计批次 3：七条「判据拿的是近似的替身，不是真对象」（E1–E8，七笔 `f0cc571`→`26153a2`）** —— 后缀之于词、子串之于名字、拼写之于 git 真正收到的 argv、`process.cwd()` 之于 `ctx.cwd`；七条各自独立，都按「改动前红、改动后绿」+ 逐机制负控验证。(E1) **无参路径注入的是关闭态掩码** —— `createToolRegistry()` 无参调用（daemon / workflow 的路径）拿到 `DISABLED_CREDENTIAL_MASKING_CONFIG`，一个**专门为「对齐 pre-seam 行为」造出来**的常量：掩码是安全控制，「没配置就关掉」把默认值的方向定反了，daemon 里 Read/Bash/Grep/Glob 的掩码整套失效、子进程继承完整 `process.env`、输出不擦洗。改取**用户级**策略（不取项目级：注册表是进程级单例而各会话 cwd 不同，套某个项目的段等于让它溢到别的会话），常量删除。(E2) **项目级只能收紧** —— 项目配置原先既能关掉掩码、也能顶掉默认规则；改挂与 `mergeProviders` 里 `baseUrl` 同一条判据（只有受信层级才能覆盖），项目侧只许**加**规则。(E3) **进程组** —— 子进程不自成进程组 ⇒ 超时只收得掉一层，且读 stdout 先于 `exited`；改 `detached` + `process.kill(-pid)` + 先等退出再读。(E5) EnterWorktree 的 `baseRef` 直接落进 git 的**选项槽**（本机实测 `--force` 被当选项吃掉并成功建成）⇒ argv 层加 `--`；不按拼写写守卫（`refs/heads/-x` 是**合法** refname）。(E6) 默认 env 过滤按**后缀**匹配 ⇒ 词在中间的 `AWS_ACCESS_KEY_ID`、`GH_PAT`、`HTTP_AUTHORIZATION` 全漏；改按**词**匹配，反方向不许中招（`SSH_AUTH_SOCK` 被掩掉，Bash 里的 ssh/git 当场找不到 agent；`MONKEY` / `KEYBOARD_LAYOUT` 同理）。同一处的 `DATABASE_URL` 内嵌口令**名字上没有任何秘密词** ⇒ 补一条**按形状**的 URL userinfo 擦洗（always-on，照 token 前缀那条先例）。(E7) Bash 三处失败归因指错根因 ⇒ 说出真正发生了什么（与 2.58.0 #25 同族）。(E8) worktree「在不在列表里」原是**子串**判定 ⇒ `w1` 命中 `w10` 那行、尾斜杠与别名拼法反被报成 not found；改按名字判定 + 两侧 realpath，ExitWorktree 的归一化基数改回 `ctx.cwd`。测试 2725 → 2767（235 → 241 文件）。**本条为摘要，全文见 [history.md](docs/claude-md-history.md)。**                                                  | 技术委员会 |

> **本表只留最近 3 行**（滚动窗口，同上方约定）—— 上表是**摘要**，每条全文与被挤掉的行都在 history.md。
> **完整修订历史**（v1.0.0–v2.57.0，共 109 条）→ [`docs/claude-md-history.md`](docs/claude-md-history.md)：
> 查「某条规则是哪一版引入的、当时为什么改、谁审的」时读它。
