# Claude Code slash command 对标：能力级补齐（设计）

> 日期：2026-11-28
> 状态：待批准
> 范围：`apps/cli` 的 slash command 面（`src/ui/commands.ts`）

## 一、实测事实

Claude Code **2.1.332**（本机真实 `/help` 捕获，500 行终端）：

| 页签                             | 条数    | 交叉核对                |
| -------------------------------- | ------- | ----------------------- |
| General commands（版本内置）     | **80**  | 小终端「6 + ↓74 more」  |
| Custom commands（插件/用户技能） | **116** | 小终端「6 + ↓110 more」 |
| 合计                             | **196** | 两个视口一致            |

- 用户提出的「198」在本机不成立；Custom 条数随安装环境变化，不是版本常量。
- Mipham Code registry 实测 **141 个键 / 111 个顶层命令**，内置数量已超过 CC 的 80。
- 按名字对比有 33 个 CC 内置名没有同名 Mipham 键；逐项映射后约 20 个是 CC 专属产品面或既有等价物。

## 二、目标与非目标

**目标（用户已选 B：能力级对齐，别名一起落）**

1. 补齐 6 个有真实落点、Mipham 确实缺的能力命令。
2. 补 3 个语义一致的 CC 兼容别名。
3. 其余 CC 命令**不**造空壳；在本文「跳过清单」里逐条写明理由。

**非目标**

- 不追求 196/198 的数量对齐（那需要把插件技能当命令搬进来）。
- 不新增 CC 专属产品面（移动端、广播、贴纸、Design 云集成等）。
- 不改现有命令语义，不顺手重构。

## 三、落地的命令（5 个）

### 1. `/insights` — 本地会话语料报告

- 行为：扫描 `~/.mipham/sessions/*.jsonl`（按 mtime 取最近 ≤200 个文件，单文件 ≤20 MiB），聚合：
  - 会话数、事件数、user/assistant 消息数
  - 工具调用总数 + Top 10（按名字）+ 失败数（`tool/result.result.success === false`）
  - 压缩次数、session/start 里的 provider/model 分布
  - 时间范围
- 落点：新增纯函数模块 `core/session-insights.ts`（可单测），命令只负责读目录并渲染。
- 计数口径（避免静默少算）：`messageToEvents` 只把**单块**工具消息拆成 `tool/call`/`tool/result`，多块回合整条存为 `*/message`，故工具调用与失败必须**同时**从事件和消息内容块里数；恢复时补的「结果未知」`tool/result` 单列为 `toolUnknown`，不算失败。
- 读取预算：单文件 20 MiB、总预算 64 MiB、最多 200 个文件；超出部分计入 skipped，不阻塞到无上限。
- 隐私：只统计维度与计数，不输出消息正文、不输出工具输入内容。
- 与现有命令的区别：`/stats`、`/usage` 只报当前会话；`/insights` 是跨会话语料。
- 无日志时如实说「No session logs found at <path>」，不是空表。

### 2. `/statusline [full|compact|off]` — 页脚状态区

- 行为：
  - `full`（默认）：现状（graft 行 + 权限/提示行 + git 分支）。
  - `compact`：隐藏 graft 行与提示长句，保留权限档位与 git 分支。
  - `off`：隐藏 graft 行、提示长句与 git 分支，**仍保留权限档位与 Ctrl+C 警告**（安全信息不隐藏）。
- 落点：
  - `CommandContext` 新增 `setStatuslineMode?`；`App` 新增 state，初值读 `preferences.json` 的 `statuslineMode`。
  - 渲染处按模式条件渲染 `GraftStatusLine`、提示句、git 分支。
  - 命令同时 `setPreference('statuslineMode', mode)` 持久化。
- 无参数时打印当前模式与三种取值。

### 3. `/autocompact [<percent>|default]` — 自动压缩阈值

- 行为：
  - 无参数：显示当前阈值（%）与 context window。
  - `0.85` / `85%`：设置覆盖值，限制在 `0.50–0.95`，越界拒绝并说明。
  - `default`：清除覆盖，回到按窗口自算。
- 落点：
  - `ContextManager` 新增 `thresholdOverride` 字段与 `setCompactionThresholdOverride(n | null)`；`calculateThresholds()` 有覆盖值时优先使用（模型切换后仍生效）。
  - 命令调用 setter 并 `setPreference('autocompactThreshold', ...)` 持久化。
  - 启动时（`index.tsx` 创建 engine 后）读偏好并应用。
- 为什么不复用 `/effort`：`/effort` 只缩放流式空闲超时，不控制压缩阈值。
- 边界：本命令只改**硬压缩**阈值；微压缩仍按自己的窗口公式更早触发。attached（daemon）会话拒绝并说明 daemon 拥有该阈值。

### 4. `/reload-plugins` — 会话内重载已启用插件

- 行为：重新扫描 `PluginManager` 状态，对**所有**已登记插件先 `hookEngine.unregisterSource(name)`，再跑一次 `loadPlugins(...)`，报告启用插件数、技能总数。
- 落点：
  - `index.tsx` 里构造 `reloadPlugins()`（那里同时持有 pluginManager/agentRegistry/skillsLoader/hookEngine/mcp/tools），经 props 下传到 `App`，再进 `CommandContext`。
- 诚实边界（输出里明说）：
  - 已连接的 MCP server 不会断开重连（`McpClient.connect` 对 connected 幂等）。
  - 已禁用/已移除插件此前加载进内存的 skills/agents 不会卸载，需重启会话。
  - hooks 会按 source 先清后重注册，不会累积重复。
- 失败：回调缺失时返回「not available in this session」，不假装成功。

### 5. `/subtask <prompt>` — 带完整上下文派子代理

- 行为：返回 `forwardToAI` 指令，让模型用 `Agent` 工具、`subagent_type: "fork"` 执行任务，并把结果带回当前对话。
- 落点：复用已有 `fork` 子代理（`agent.ts:143` 会把父会话消息副本 `inheritContext` 下发；空上下文时工具自身拒绝）。
- 无参数时打印用法。
- 这是「命令 → AI 工具」桥，不是新的执行引擎；输出明确说明走的是 Agent(fork)。

### 6. `/security-review` — 安全专项审查

- 行为：走 `gitDiffBridgeCmd`，读当前未提交改动并转发一条**安全专项**指令给现有 `security-review` skill（注入、鉴权绕过、密钥泄露、反序列化、路径穿越、依赖风险）。
- 与 `/code-review` 的分界：后者只承诺 bugs + CLAUDE.md violations，不含安全焦点；因此本命令**不是**它的别名。
- 无改动时沿用现有的「没有可审查的改动」分支，不假装跑过。

## 四、别名（3 个）与第 6 个命令

| 新名字         | 指向          | 语义核对                                                   |
| -------------- | ------------- | ---------------------------------------------------------- |
| `/bug`         | `/bug-report` | 等价（诊断报告）                                           |
| `/plugin`      | `/plugins`    | 等价（CC 的插件管理入口；Mipham 的安装/卸载/启停另有命令） |
| `/list-agents` | `/agents`     | 等价（列出后台代理会话）                                   |

**`/security-review` 不落成别名，落成独立命令**：`/code-review` 真正发给模型的指令只有「bugs and CLAUDE.md violations only」，从不含 security 焦点；别名会让用户以为拿到的是安全审查。改用 `gitDiffBridgeCmd` + 现有 `security-review` skill 的安全专项 prompt，属于真实能力，不是空壳。

**不落的别名：`/background`** —— CC 的语义是把**当前会话**放后台并释放终端；Mipham 的 `/bg` 是派一个后台代理。两者同名不同事，别名会做出一个错误的承诺。建议保持不落（本设计按不落处理）。

## 五、跳过清单（不造空壳）

| CC 命令                                                                                                                                                                                           | 为什么不落                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `/debug`                                                                                                                                                                                          | Mipham 没有调试日志子系统；`/doctor` + `/status` + `MIPHAM_DEBUG_INPUT` 只覆盖片段。真做需要先建日志采集，是独立项目 |
| `/run`                                                                                                                                                                                            | 需要一个「识别并运行本项目」的 skill；通用运行器有安全风险，不在本批                                                 |
| `/sandbox`                                                                                                                                                                                        | 没有 OS 级沙箱；`--safe-mode` 是启动期开关，无法会话内切换                                                           |
| `/btw`                                                                                                                                                                                            | 没有并发侧问通道；落成普通消息就是改名不换事                                                                         |
| `/output-style`                                                                                                                                                                                   | 没有输出风格系统；MIPHAM.md 人格是权威来源，不宜由命令旁路覆盖                                                       |
| `/design-login` `/design-sync` `/mobile` `/radio` `/stickers` `/team-onboarding` `/tui` `/claude-api` `/dataviz` `/plugin-authoring` `/workflow-authoring` `/fewer-permission-prompts` `/powerup` | CC 专属产品面或技能内容，不是 Mipham CLI 的能力                                                                      |

## 六、数量与文档同步

新增 6 命令 + 3 别名 ⇒ `getCommandNames().length` 141 → **150**。

同一提交内必须同步：

- `packages/shared/package-info.json`、`packages/shared/src/package-info.ts`、`apps/cli/src/shared/package-info.ts` 的 `SLASH_COMMAND_COUNT`
- 根 `README.md`、`apps/cli/README.md` 的命令总数声明
- `packages/shared/src/i18n/locales/{en-US,zh-CN}.json` 的 `web.features.slash_commands`（守卫同时扫 `apps/cli/src/i18n-core/locales/` 两份）
- 仓库根 `CLAUDE.md` 的「Slash 命令系统（141 个）」
- `apps/telemetry/src/allowlist.json`：用 `UPDATE_TELEMETRY_ALLOWLIST=1` 重新生成（9 个新标签，逐元素比对）
- `/commands` 的 `catMap`：新命令归入对应分类（Other 兜底，但不能靠兜底）
- 若新增测试，`TEST_COUNT` 三份副本与 `CLAUDE.md` 三种写法同步（见发布流程硬约定）

## 七、测试计划

- 新增 `test/ui/cc-command-parity.test.ts`：
  - 4 个别名与目标 handler 是同一个函数（`getCommand(alias) === getCommand(target)`）
  - `/subtask` 无参用法、有参 `forwardToAI` 含 `fork` 与原 prompt
  - `/reload-plugins` 回调缺失/成功/抛错三态
  - `/statusline` 三种模式与非法值；回调被调用；持久化调用
  - `/autocompact` 设置/清除/越界；ContextManager 覆盖值在 `calculateThresholds()` 后仍生效
- 新增 `test/core/session-insights.test.ts`：用夹具事件数组验证计数、Top N、失败数、空输入
- 现有 `published-counts` 守卫会强制三份 `SLASH_COMMAND_COUNT` 一致
- 回归：`cd apps/cli && pnpm test`、根 `pnpm -r typecheck`、`pnpm lint`、`pnpm format:check`、`apps/cli` 的 `test/integrity`

## 八、风险与边界

- `/reload-plugins` 是**部分重载**，输出必须如实写明未卸载项；不得说成完整重载。
- `/autocompact` 覆盖值会改变压缩时机，但不会关闭压缩；`default` 是唯一清除方式。
- `/statusline` 的 `off` 不隐藏权限档位（安全信息）。
- `/insights` 只做计数与名字，不读消息正文；文件读取有上限，坏行跳过并计数。
- 全部改动是新增命令 + 少量显式接缝，不改既有命令行为。
