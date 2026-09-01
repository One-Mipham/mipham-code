# Claude Code v2.1.251 变更 + 对 Mipham Code 对标分析

> **日期**: 2026-08-31
> **来源**: Anthropic `claude-code` 仓库 `CHANGELOG.md`（v2.1.251 条目 + 邻近版本 v2.1.252 / 2.1.250 / 2.1.248 上下文）
> **性质**: 对标调研 + 改进建议（非实现规格）
> **方法**: 逐项读 Mipham Code 实际代码验证「是否缺 X」，不凭 CLAUDE.md 描述下结论
> **许可边界**: Claude Code 为闭源商业产品；本分析全部是「对标行为语义、自写实现」，不涉及抄代码

---

## 〇、摘要

v2.1.251 是一个**高密度版本**：71 条变更（5 条新特性、约 40 条修复、约 20 条行为改进）。核心主题：

1. **安全加固** — symlink 越权、路径遍历、header 注入、Bash 权限绕过
2. **多会话/子代理/后台正确性** — 消息寻址、transcript 冲突、worktree 编辑
3. **成本与缓存可观测性** — `/cost` prompt-cache 行、spend limit bar
4. **性能** — UI re-render 冗余、二进制瘦身

对标结论：**多数高价值项 Mipham Code 已覆盖或形式不同**（symlink TOCTOU、MCP 握手超时、worktree 隔离、prompt-cache 引擎层追踪均已实现）。真正值得动手的收敛为 **4 项**（见 §五）。

---

## 一、v2.1.251 变更分类速览

### 1.1 新特性（5）

- `PreModelSwitch` / `PostModelSwitch` hook 事件（block/confirm/annotate 模型切换）
- `SessionStart` resume hook 接收 session staleness + 预估 re-cache 成本
- 前台子代理 tool 调用/结果**实时流**到 Remote Control 客户端
- `/usage` 加 Spend limit bar + `rate_limits.spend_limit` status line 字段
- `/cost` 加 per-session prompt-cache 行（hit ratio / misses / re-cached / warm-cold）

### 1.2 安全修复（核心）

| 修复                                                                            | 类别     |
| ------------------------------------------------------------------------------- | -------- |
| Read/Write/Edit 权限检查后 symlink 被换入 → 越权读写                            | TOCTOU   |
| plugin 命令指向 plugin 目录外 → 拒绝（path-traversal）                          | 路径遍历 |
| 项目设置可开 beta tracing / raw body 日志；低作用域 tracing 绕过 OTLP collector | 日志越权 |
| Workflow 在权限检查前读 `scriptPath`                                            | 越权读   |
| Grep/Glob 未对 symlink 路径应用 `Read(...)` deny 规则                           | 越权读   |
| Bash 权限自动放行「整数 shell 变量算术赋值」（`OPTIND=1/0`、`RANDOM=2+2`）      | 权限绕过 |
| `ANTHROPIC_CUSTOM_HEADERS` 凭据/路由类需审批                                    | 凭据注入 |
| 沙箱输出文件可被 sandboxed 命令 redirect/replace                                | 沙箱逃逸 |

### 1.3 正确性/健壮性修复（长尾，部分）

- 仅 thinking 无文本的回合卡死「text content blocks must be non-empty」
- effort=xhigh/max + thinking 关闭 → API 报错（降级为 `high`）
- `--input-format stream-json` 无 message id 的 tool call 结果丢失
- 目录切换导致同 ID transcript 被静默覆盖
- background session + subagent 无法编辑自己 `git worktree add` 的文件
- SDK MCP 握手 ack 丢失 → 挂起（70s 超时）
- `additionalDirectories` null byte 崩溃
- 畸形 tool call 重试：drop broken output（含 Bedrock/Vertex/Foundry）

### 1.4 性能

- 削减 turn 期间冗余 UI re-render
- 原生二进制瘦身 ~5MB；移除 6 种冷门语言高亮再省 2.5MB

---

## 二、逐项对标核查

> 置信标注：**[高]** = 读源码验证；**[中]** = 读部分实现推断；**[低]** = 命名/描述推测。

### 🔴 P0 — 安全

| #   | Claude Code 变更             | Mipham Code 现状                                                                                                                                        | 置信 | 结论                     |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------ |
| 1   | Bash 算术赋值绕过权限检查    | `security/gate.ts:30-38` 的 `DANGEROUS_BASH_PATTERNS` 只覆盖 4 类（`;rm/cat/sh/bash`、`curl\|sh`、`\|sh`、`>/dev/`），**未覆盖**整数 shell 变量算术赋值 | 高   | **确认缺失，建议做**     |
| 2   | Workflow `scriptPath` 越权读 | `tools/agent/workflow.ts:63-67` 的 `script` 是**内联字符串**，无 scriptPath 概念                                                                        | 高   | **不适用**               |
| 3   | 项目级 header 注入           | 见 §三 专项核查                                                                                                                                         | 高   | **非洞，是信息披露缺口** |
| 4   | 沙箱输出文件防替换           | 无 bash sandbox 隔离                                                                                                                                    | 低   | 架构级差距，单独评估     |

### 🟠 P1 — 功能对标

| #   | Claude Code 变更                        | Mipham Code 现状                                                                                                               | 置信 | 结论                                      |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---- | ----------------------------------------- |
| 5   | `PreModelSwitch`/`PostModelSwitch` hook | `core/hooks.ts` 有 14 事件，**无** model-switch 事件（grep 零命中）                                                            | 高   | **确认缺失；Mipham 多模型定位下价值更高** |
| 6   | `/cost` 补 prompt-cache 行              | 数据已在 `core/context-token.ts`（`PromptCacheTracker`），但 `/cost`（`ui/commands.ts:400-412`）只显示 context tokens + usage% | 高   | **数据在手，只差展示**                    |
| 7   | effort + thinking 降级                  | 见 §三 专项核查                                                                                                                | 高   | **不适用；暴露功能差距**                  |

### 🟡 P2 — 正确性/健壮性

| #   | Claude Code 变更                  | Mipham Code 现状                                                            | 置信 | 结论                              |
| --- | --------------------------------- | --------------------------------------------------------------------------- | ---- | --------------------------------- |
| 8   | 仅 thinking 无文本卡死            | `engine.ts:600-650` 已把 thinking 转 `{type:'thinking'}` block，规避空 text | 中   | 建议加单测                        |
| 9   | 畸形 tool_use 缺 id               | 见 §三 专项核查                                                             | 高   | **不 crash 但静默降级，建议加固** |
| 10  | background 无法编辑 worktree 文件 | 见 §三 专项核查                                                             | 高   | **不适用（Mipham 隔离更强）**     |
| 11  | 多并行子代理 TUI 卡顿             | Ink 5 + agent-view，同类 re-render 冗余风险                                 | 中   | 对标：tick 覆盖而非 append        |

### 🟢 P3 — 治理/设计（借思想）

| #   | Claude Code 变更                                  | 借鉴点                                                                                             |
| --- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 12  | `CLAUDE_CODE_SUBAGENT_MODEL` 语义「默认而非覆盖」 | env 是 fallback 不是 override，agent 定义 `model:` 优先                                            |
| 13  | Commit trailer 按模型变化                         | Mipham 已固定 `Co-Authored-By: Mipham`（产品自身，合理）；多 provider 可考虑标注实际模型（低优先） |
| 14  | 移除冷门语言高亮瘦身                              | 不适用（Ink 无 shiki 级多语言高亮）                                                                |

---

## 三、5 项专项验证结果（读代码后定论）

> 初版报告中标「待验证」的 5 项，本轮全部读完对应实现。每项附证据。

### ✅ #2 Workflow scriptPath 越权 → **不适用**

`tools/agent/workflow.ts:63-67`：`script` 参数是 `type: 'string'`，模型**内联传脚本内容**，不存在从文件路径读脚本。`workflow/runtime.ts:69` 的 `loadScript(resumeFromRunId)` 读的是内部自建 `WORKFLOW_DIR/runId/script.js`，非用户可控路径。无越权面。

### 🟡 #3 项目级 header 注入 → **非洞，是信息披露缺口**

**证据链**（加载 → 连接）：

1. `config/loader.ts:176-218` 搜索 `cwd/.mipham/mcp.json`、`cwd/.mcp.json`、`~/.mipham/mcp.json`，`headers`（含 `Authorization`）原样 `JSON.parse` 进 `config.skills.mcpServers`，**纯解析、无 trust 门、无 connect**。
2. `config.skills.mcpServers` 的 connect **仅一处入口**：`ui/commands.ts:4475` `/mcp connect <name>`。全局 grep 确认 `registerMcpServerTools`/`.connect()` 未在 `engine.ts`/`bin/` 启动时遍历调用 → **不会自动连接**。
3. `mcp/client.ts:158-185` `connect()` 无 trust 门，`transport.start(config.url, config.headers, config.env)` 直接把 headers 下发。
4. `ui/commands.ts:4497-4501` 对 HTTP server **只显示「Connecting via HTTP」**，不显示 URL、不显示将发送的 header 键名。

**结论**：

- **不存在「静默自动连接 + 静默发凭据」的高危洞**（必须用户 `/mcp connect`）。
- **中等风险**：恶意仓库在 `.mcp.json` 声明 `url: attacker.com` + `Authorization` header，README 诱导 `/mcp connect` → 凭据发到攻击者服务器；用户连接前看不到去向。
- **附带观察（低风险）**：`plugin-loader.ts:92` plugin 加载时自动 connect MCP，属「恶意 plugin」供应链面，非仓库面。

### 🔵 #7 effort + thinking → **不适用，暴露功能差距**

`providers/fetch-utils.ts:100-115`：Mipham 的 `effort`（`/effort low|medium|high|xhigh|max`）**不是发给模型的 `reasoning_effort` 参数**，而是**本地客户端「流式空闲超时」乘数**（xhigh→3× 超时，容忍长 thinking）。

- Claude Code 修的「effort=xhigh/max + thinking 关闭 → API 报错」**在 Mipham 不存在**（effort 不下发 API）。
- **但暴露功能差距**：Claude Code 的 effort 是真实思考深度控制（映射 `thinking.budget_tokens` / `reasoning_effort`），Mipham 只是本地超时。想对标「思考深度」，需 provider 层映射真实参数（**路线图项**）。

### 🟠 #9 畸形 tool_use 缺 id → **部分适用（不 crash，静默降级）**

`providers/openai-compat.ts:133-141`：`pendingToolCalls` 用 `id: ''` 兜底，`if (tc.id) pending.id = tc.id`。engine 不 crash，但：

- 缺 id 静默用空字符串，多 tool_use 全变 `''` → `addToolResult('')` **关联错乱**。
- `name` 空 → `engine.ts:686` `executeTool('', input)` 找不到工具，**静默失败**。

**结论**：比 Claude Code（直接 crash）好，但缺显式校验。对标「malformed tool call → drop broken output → clean retry」。

### ✅ #10 worktree + background 编辑 → **不适用（Mipham 隔离更强）**

四层 worktree 隔离：

1. `agent/sub-agent.ts:221` `execCwd = options.worktreePath`
2. `sub-agent.ts:226-231` worktree 自动信任（父工作区 trusted → `trust.trust(execCwd)`）
3. `sub-agent.ts:235-252` P0-4 自动禁用 Git 工具
4. `tools/exec/bash.ts:334` cd 隔离 + `tools/exec/git.ts:68-70` git 引用隔离

Claude Code 修的是「权限误拒合法编辑」的功能性 bug；Mipham 是反向「主动信任」，**该 bug 不存在**。

---

## 四、三态对账（CRSI 教训 #14：钉死「已实现 / 只记教训 / 待办」）

| 结论                         | 状态                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ✅ **已实现，无需对标**      | symlink TOCTOU（`write/read/edit.ts` 的 `O_NOFOLLOW`）、grep 跳过 symlink、MCP 握手超时（`mcp/client.ts:213`）、prompt-cache 引擎层追踪（`context-token.ts`）、worktree 四层隔离、commit trailer |
| 🔶 **数据在手，只差展示**    | prompt-cache 命中率 → `/cost` 一行（§二 #6）                                                                                                                                                     |
| ❌ **确认缺失，建议对标**    | Bash 算术赋值绕过（§二 #1）、model-switch hook（§二 #5）                                                                                                                                         |
| 🟡 **形式不同，需加固/补充** | 畸形 tool_use 显式校验（#9）、`/mcp connect` 信息披露（#3）                                                                                                                                      |
| ❓ **已核查，不适用**        | Workflow scriptPath（#2）、effort+thinking（#7）、worktree 编辑（#10）                                                                                                                           |

---

## 五、最终建议清单（按优先级）

| 序  | 项                             | 性质     | 成本 | 说明                                                                                                                                                               |
| --- | ------------------------------ | -------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **#1 Bash 算术赋值绕过**       | 安全洞   | 低   | `security/gate.ts` 加一条精确正则，只匹配整数 shell 变量（`OPTIND`/`RANDOM`/`SECONDS`/`LINENO`/数组下标）算术赋值，不 blanket 拦 `=`（避免 CRSI 教训 #1/#17 误伤） |
| 2   | **#6 `/cost` 补缓存行**        | 展示     | 极低 | `context-token.ts` 的 `cachedCount/cachedTokens` 已在手，`/cost` 多打一行 hit ratio / warm-cold                                                                    |
| 3   | **#9 畸形 tool_use 显式校验**  | 健壮性   | 低   | `engine.ts`/`openai-compat.ts` 对缺 `id`/`name` 的 tool_use 丢弃 + 触发干净重试，而非静默空 id                                                                     |
| 4   | **#3 `/mcp connect` 信息披露** | 安全加固 | 低   | connect HTTP server 前展示目标 URL + header 键名 + 来源分级（用户级 vs 项目级）                                                                                    |

### 路线图项（不急）

- **#7 真实思考深度控制**：provider 层把 effort 映射到各家 API 的真实 reasoning 参数。
- **#5 model-switch hook**：`PreModelSwitch`/`PostModelSwitch`（多模型定位下的差异化功能）。
- **#4 bash sandbox 隔离**：架构级差距，单独评估。

---

## 六、局限声明

1. **许可边界**：Claude Code 闭源；以上全部是「对标行为语义、自写实现」，不抄代码（符合 borrow-analysis 教训 #8）。
2. **置信标注**：每条均标 [高/中/低]。标「中/低」的（#8 单测、#11 TUI、#4 sandbox）尚未读透全部实现，未读透不下「我们缺 X」结论。
3. **版本时效**：分析基于 2026-08-31 的 `main` 分支 changelog；Mipham Code 代码状态基于 `v2.27.0`（2026-08-31）。
