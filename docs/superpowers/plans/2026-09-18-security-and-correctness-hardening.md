# 权限解析与正确性加固 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉本轮全仓审计确认的 27 处缺陷，其中 Phase 1 收口「deny 规则可被普通写法绕过」这一族安全问题，其余按批次跟进。

**Architecture:** Phase 1 只动 `src/core/permission-rules.ts` 的**命令归一化**这一层：把「剥掉基命令前的 shell 噪声」抽成一个共享辅助函数，同时喂给 **Bash 通配匹配**（`flattenCommand`）与 **读/写命令扫描**（`extractBashFileAccess`）两条路径 —— 这两条今天各解析各的，正是绕过得以存在的结构原因。另修 `validateRulePattern` 的校验面与 `bash.ts` 的 worktree 逃逸判定。

**Tech Stack:** TypeScript 5.5（strict）、Bun 1.2+/Node 22+、Vitest 5、pnpm 9.15。

**Spec:** 无独立设计文档；本计划的「缺口清单」一节即是规格，证据列写明每条是**谁**测的。

## Global Constraints

- **公开日志不写对标措辞**：提交信息、CLAUDE.md、CHANGELOG 只讲本仓自己的修复，不引任何上游产品名或版本号。审计的来龙去脉留本地记忆。
- **只改被要求改的**（Surgical Changes）：diff 中每一行都要能追溯到本计划的任务；不顺手重构相邻代码、不改格式、不删无关 dead code（发现就记下来）。
- **测试先红后绿**：每个任务先写会失败的测试并**实跑确认它失败**，再写实现。测试文件里的每条断言必须对着真实导出函数，不对着复制粘贴的表达式。
- **跑测试必须在 `apps/cli` 下**：`cd apps/cli && pnpm test`。从仓库根跑 `--root apps/cli` **不够**，MCP 测试会 spawn 子进程继承 `process.cwd()`，会产生 31 个假红。单文件用 `cd apps/cli && npx vitest run test/core/permission-rules.test.ts`。
- **文档数字同提交回填**：测试数变化时，同一提交内改仓库根的 `CLAUDE.md`（另有 `ROADMAP.md` 一处）与本文件涉及的活文档数字。`CLAUDE.md` 有 **≤40,000 字符**硬上限（`test/integrity/tool-reference-integrity.test.ts` 守卫），超出部分写 `docs/claude-md-history.md`。
- **提交信息**用 Conventional Commits，结尾带 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。
- **不碰父仓库**：本仓库是 `One_Mipham_Corporation` 的子模块，改动只在本仓提交。父仓 gitlink 的 bump 是单独一步，且不由本计划授权。
- **不改 eval harness 的冻结契约**：`/crsi eval` 的 38 条 ground-truth 含权限相关断言，Phase 1 改完必须跑一遍确认分数**不退化**（当前满分 100）。
- 禁止硬编码凭据；Phase 1 不引入任何新依赖。

---

## 缺口清单（27 条）

证据等级：**自测** = 我在本会话亲自跑探针复现；**子代理实测** = 子代理跑探针、报告里贴了原始输出且我抽验了一部分；**读码** = 只读代码，未实跑。

### Phase 1 — 权限解析（安全，7 条）

| #   | 缺陷                                                                                      | 坐标                                                                                                            | 证据 | 复验状态                                                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 基命令前的 shell 噪声（`( )` `{ }` `!` `NAME=value` `do/then/for`）使 `Bash(rm *)` 漏判   | `permission-rules.ts:178-183` `splitShellSegments`、`:287-320` `effectiveCommand`（只对 `env` 剥 `NAME=value`） | 自测 | 我复现 10 例                                                                                                                                                                                                         |
| 2   | 同一噪声使 `Read(secret)` 漏判（`IFS=x cat secret`、`LD_PRELOAD=x cat secret`）           | `permission-rules.ts:384-419` `scanReaderWriterCommands` 拿原始 token 当基命令                                  | 自测 | 我复现                                                                                                                                                                                                               |
| 3   | `time` 不在 `PREFIX_COMMANDS` ⇒ `time -p rm -rf x` 基命令识别成 `time`                    | `permission-rules.ts:95-107`                                                                                    | 自测 | 我复现                                                                                                                                                                                                               |
| 4   | `timeout` 无条件 `i++` ⇒ `timeout --preserve-status cat secret` 把 `cat` 当 duration 吃掉 | `permission-rules.ts:306`                                                                                       | 自测 | 我复现                                                                                                                                                                                                               |
| 5   | 进程替换 `<(…)`/`>(…)` 不递归 ⇒ `cat <(cat secret)` 漏判                                  | `permission-rules.ts:238-248` `extractSubstitutions` 只认 `$()`/反引号                                          | 自测 | 我复现                                                                                                                                                                                                               |
| 6   | `~`/`$HOME` 不展开 ⇒ `cat ~/.ssh/id_rsa` 绕过 `Read(/Users/me/.ssh/id_rsa)`               | `extractBashFileAccess` 原样返回 `~/…`                                                                          | 自测 | 我复现                                                                                                                                                                                                               |
| 7   | worktree 逃逸守卫：拼接式解析不归一 `..`、只看第一个 `cd`、用字符串前缀判归属             | `bash.ts:346-351`                                                                                               | 读码 | **执行时订正**：前两处实测复现为活绕过；第三处（`startsWith(cwd)`）**不构成活绕过** —— 这样的路径仍在 `marker.root` 之下、被第二个析取项兜住（原记的 `cd /tmp/wt/proj-evil` 例子按既有语义应**放行**，是计划写错了） |

### Phase 2 — 输出上限与错误分类（3 条）

| #   | 缺陷                                                                                                                                                 | 坐标                                                                | 证据                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 8   | ✅ **已修** `GREP_MAX_OUTPUT_CHARS` 只接 find 回退一条路径；rg 快路径原样返回                                                                        | `grep.ts:33,36-40`，唯一调用点 `:168`；rg 分支 `:107`/`:117` 不截断 | 自测（我读了两个分支，确认 `:107` 无 `truncateGrepOutput`）+ 子代理实测 46 万字符超限         |
| 9   | ✅ **已修** find 回退把「出错」读成「无匹配」：stderr 全程不消费，而 BSD `find` 在「grep 正则非法 / 目录不可读 / grep 不存在」下退出码**都是 1**     | `grep.ts:20,164`                                                    | 子代理实测（三种情形端到端输出逐字同为 `(no matches)`）                                       |
| 10  | ✅ **已修** `runSearch` 的 `stderr:'pipe'` 从不消费 ⇒ Node 下 stderr 超阈值即卡满 120s 超时兜底（**实跑证实**：300 KB stderr 在原实现下 5 s 未退出） | `grep.ts:20`                                                        | 子代理实测（同形状 spawn：16MB 正常 / 24MB 起不退出）；「真函数在 Node 下挂住」标注为**推断** |

### Phase 3 — 数据落点与并发写（5 条）

| #   | 缺陷                                                                                                                                                             | 坐标                                           | 证据                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------- |
| 11  | ✅ **已修** Artifact 工具写 `<cwd>/artifacts`，ArtifactServer 根是 `<cwd>/.mipham/artifacts` ⇒ 工具回报的 URL **100% 404**                                       | `artifact.ts:61` vs `index.tsx:601`            | 自测（我读了这两行 + `constants.ts:541,558`）+ 子代理实测 fetch 404 |
| 12  | ⚠️ **半修**（见下）`versioning.saveVersion` 零调用 ⇒ 「恢复上一版」能力从未被喂过；`manifest.archiveVersion` 文件不在时静默跳过归档却照常推进版本号              | `versioning.ts:33`、`manifest.ts:80`           | 子代理实测                                                          |
| 13  | ✅ **已修** `atomicWriteFileSync` 用固定 `.tmp` 名 ⇒ 并发写者互撞、读者可读到半截内容                                                                            | `shared/atomic-write.ts:14`                    | 读码                                                                |
| 14  | ✅ **已修** 定时任务无 `cwd`/`sessionId`（`ctx` 被丢弃），存储是全局单店 ⇒ **任何**目录建的任务被任何其他目录的会话执行；id 仅由 `cron+prompt` 决定 ⇒ 跨项目碰撞 | `cron.ts:15,21-29,36,104`、`cron-poller.ts:28` | 自测（我读了接口与 `_ctx`）+ 子代理实测落盘 JSON 无 cwd             |
| 15  | ✅ **已修** 大文件 `read.ts` 先整读再取 offset/limit ⇒ 报错建议「Use offset/limit」不可执行；`split('\n')` 实体化每一行 ⇒ 20MB 文件吃 364MB RSS                  | `read.ts:50-58,63-64,90-91`                    | 子代理实测                                                          |

> **本批执行中撞见、未修（如实记）**：
>
> - `addToManifest`（`manifest.ts:39`）只按 `name` 去重，而 manifest 是**全局一份**（`index.json` 落在 artifactsRoot，
>   条目自带 `sessionId`）⇒ 两个会话各发布一个同名 artifact，后者的条目顶掉前者；前者的文件还在磁盘上，却从索引里
>   消失（`list` 看不到、`open` 找不到）。
> - 同一处更坏的一条：`readManifest` 解析失败时**静默返回空 manifest**，而 `addToManifest` 紧接着整份重写 ⇒ 一份
>   损坏的 `index.json` 会被下一次发布覆盖成「只有这一条」，索引全丢。
> - #14 的遗留：更早写的 cron 文件没有 `cwd`，轮询照发（**刻意**，否则用户已建的日程会静默停掉）—— 代价是这些
>   **旧任务仍然跨项目执行**，直到用户重建它们。

### Phase 4 — 接线与配置（8 条）

| #   | 缺陷                                                                                                                                                                        | 坐标                                                         | 证据                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| 16  | `validateRulePattern` 放行 `WebFetch(*)`/`Task(*)` 等**永不匹配**的参数化规则 ⇒ 静默空防护；docstring 自称「mirroring exactly what matchBashRule will actually match」      | `permission-rules.ts:505-522`                                | 自测                                             |
| 17  | `BLOCKED_PATHS` 存未解析字面量却拿 `realpathSync` 后的规范形去比 ⇒ macOS 上 `/etc` 永不命中（`/etc` → `/private/etc`），注释还写着「checked after resolving symlinks」      | `security/path.ts:8,63,89-95`                                | 自测（我读码 + `readlink /etc` = `private/etc`） |
| 18  | `mergeConfig` 浅合并 ⇒ `permissionRestrictions`/`permissionRules`/`skills` 等来源间兄弟键静默丢失                                                                           | `config/loader.ts:94-106`（仅 `providers` 深合并）           | 读码                                             |
| 19  | `.mcp.json` 装载手工重建对象，丢 `request_timeout_ms` 与 `auth`                                                                                                             | `config/loader.ts:199-210`                                   | 读码                                             |
| 20  | Stop hook 的 block 语义断链：`parseHookStdout` 从未产出 `decision`，而 `engine.ts:1671` 读 `stopResult.decision === 'block'` ⇒ settings.json 里的 Stop hook 无法阻断        | `hooks-executor.ts:96-112`                                   | 读码                                             |
| 21  | SubagentStart/Stop 的 matcher 完全失效（这些事件的 ctx 无 `toolName`，过滤条件恒真）⇒ 无法按 agent 类型过滤                                                                 | `hooks.ts:145-158,272-282`                                   | 读码                                             |
| 22  | 子代理工具 ctx 只传 4 个字段 ⇒ Agent/Workflow/Skill 工具在子代理内必然失败                                                                                                  | `sub-agent.ts:459-464` vs `agent.ts:60-69`、`workflow.ts:88` | 读码                                             |
| 23  | HttpTransport 的 `notificationHandlers` 从不遍历（stdio 会）⇒ HTTP MCP 的 `tools/list_changed` 永不触发；`client.ts:212 reconnect()` 零调用 ⇒ 断连后无通知，`/mcp` 仍显示绿 | `mcp/http-transport.ts:74,182,188`、`mcp/client.ts:212`      | 读码                                             |

### Phase 5 — 剩余（4 条，低危/体验）

| #   | 缺陷                                                                                                                                                    | 坐标                           | 证据                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------- |
| 24  | Glob 的 500 上限静默（同一份代码里 Grep 特意加了 `(truncated)` 标记，理由还写在注释里）                                                                 | `glob.ts:30`                   | 子代理实测 800→500 无标记 |
| 25  | Grep 的 `catch {}` 把任何异常都解释成「rg 未安装」⇒ 错误信息指向错误根因                                                                                | `grep.ts:135`                  | 子代理读码                |
| 26  | Edit 审批预览 `slice(0,60)` 按 UTF-16 码元切，劈开代理对 ⇒ 末尾半个 emoji                                                                               | `ui/app.tsx:128`               | 子代理实测                |
| 27  | ✅ **已修（2026-09-18，早于 Phase 2）** 插件安装 `execSync('npm install … --no-save')` 无 `--ignore-scripts` ⇒ 任意 npm 包的 postinstall 以用户全权运行 | `plugin/plugin-manager.ts:113` | 读码                      |

> **#27 已按本条优先级提前执行（2026-09-18，排在 Phase 2 之前）**：`--ignore-scripts` + `execFileSync` argv 数组，测试 2629 → 2633。**「无完整性校验」一节未做**，理由记在下面的「不做」表 —— npm 自身按 registry 元数据校验 tarball 完整性，「无校验」指的是**没有独立信任锚**（不钉版本、无 lockfile），补它需要在装插件这条路上引入版本钉死策略，属另一个决策，不在本批做。
>
> **原记**：它是本清单里唯一「一条命令拿到全权执行」的路径（`/install-plugin` 可达）。虽被排在 Phase 5，但它与 Phase 1 同属「安全」族 —— 应提前到 Phase 2 之前。

---

## 本计划**不做**的（已核实为非缺口，勿再当待办）

| 条目                                           | 判定                                                                                                               | 依据                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| rewind 恢复出零填充/截断文件                   | N/A —— 我们没有文件快照机制，`Checkpoint` 只有 `messages`，全程零磁盘 I/O                                          | 子代理实测（`fileHistory`/`file-history`/`.bak` 零命中，同命令正对照 `checkpoint`=53） |
| macOS「system 用第二条路径报出同一个文件」被拒 | N/A —— 单次 `realpathSync` + 权限层不解析路径，不存在「检查一次、事后又比对」                                      | 子代理实测（9 类同文件两路径全接受，另配 C1/C2/C4 三条能失败的正对照）                 |
| 重建 stub `.git/info/exclude`                  | N/A —— 无写该文件的代码                                                                                            | 子代理实测（零命中 + `ARTIFACTS_DIR`=7 正对照）                                        |
| Edit 预览位置与批准的编辑不一致                | 已覆盖 —— 审批文案里根本没有行号/偏移                                                                              | 子代理读码 + 实测                                                                      |
| 无 markdown 渲染 / 有序列表重编号              | N/A —— 我们没有 markdown 渲染器（`chat.tsx:96` 是 `<Text>{msg.content}</Text>`，依赖表只有 7 项）                  | 我读码 + `package.json`                                                                |
| `bash -c 'cat secret'` 绕过 `Read()`           | **已修**（旧记录过时）—— `SHELL_COMMANDS` + `shellPayload` 递归已覆盖，测试 `test/core/permission.test.ts:239-240` | 我复验                                                                                 |

---

## 分批执行

- **Phase 1（本计划详细展开）**：权限解析 7 条 —— 一个文件为主，改动集中、可独立验收，且是本清单里唯一「静态配置被普通写法绕过」的安全族。
- **Phase 2～5**：各批次独立成计划（本文件末尾给骨架）。每批结束时：`cd apps/cli && pnpm test` 全绿 → `pnpm typecheck` → `pnpm lint` → 跑 `/crsi eval` 确认不退化 → 同提交回填文档数字 → 提交。

---

## Phase 1：权限解析

### 文件结构

| 文件                                          | 职责                                                                     | 动作                  |
| --------------------------------------------- | ------------------------------------------------------------------------ | --------------------- |
| `apps/cli/src/core/permission-rules.ts`       | 命令归一化 + 规则匹配（本批唯一生产代码落点）                            | 修改                  |
| `apps/cli/src/security/path.ts`               | 导出 `isWithin` 供 worktree 守卫复用（避免第二份「是否在目录内」的实现） | 修改（仅加 `export`） |
| `apps/cli/src/tools/exec/bash.ts`             | worktree 逃逸判定抽成纯函数并修复                                        | 修改                  |
| `apps/cli/test/core/permission-rules.test.ts` | 任务 1–5 的测试                                                          | 修改                  |
| `apps/cli/test/tools/bash.test.ts`            | 任务 6 的测试                                                            | 修改                  |

### 设计要点（为什么这样改）

今天有**四条**各自 tokenize 的路径：`flattenCommand`（给 Bash 通配匹配用）、`extractBashFileAccess`→`scanReaderWriterCommands`（给 Read/Write/Edit 桥接用）、`effectiveCommand`（剥前缀命令）、`extractSubstitutions`（找嵌套命令）。**「基命令前的噪声」这条知识只被 `effectiveCommand` 知道一半**（只对 `env` 剥 `NAME=value`），其余三条都不知道 —— 这就是绕过得以存在的结构原因。

修法不是给四处各打一个补丁，而是把「剥噪声」抽成**一个**导出函数 `stripLeadingShellNoise`，让 `flattenCommand` 与 `extractBashFileAccess` 都经过它。**只接一条路径 = 只修一半**（本项目已因此栽过两次：`is_error` 贯通、daemon 自启），本批的验收标准里专门有一条防这个。

---

### Task 1: 剥掉基命令前的 shell 噪声

**Files:**

- Modify: `apps/cli/src/core/permission-rules.ts`（新增 `stripLeadingShellNoise`；`flattenCommand` 与 `extractBashFileAccess` 接入）
- Test: `apps/cli/test/core/permission-rules.test.ts`

**Interfaces:**

- Produces: `export function stripLeadingShellNoise(segment: string): string` —— 输入一段原始 shell 片段，返回剥掉**前导**噪声 token 后的片段；无可剥时原样返回。剥除对象：赋值（`^[A-Za-z_][A-Za-z0-9_]*=`）、结构符号（`(` `{` `!`）、shell 关键字（`do` `then` `else` `elif` `if` `while` `until` `for` `case` `time` `coproc`）。**只剥前导**，且可反复剥（`FOO=1 ! rm -rf x` 要剥两次）。

- [ ] **Step 1: 写失败的测试**

在 `apps/cli/test/core/permission-rules.test.ts` 末尾追加（文件已有 `import { matchBashRule } from '../../src/core/permission-rules'`，若无则补上）：

```ts
describe('基命令前的 shell 噪声 —— Bash 通配匹配', () => {
  const denyRm = (cmd: string) => matchBashRule('Bash(rm *)', 'Bash', { command: cmd })

  it.each([
    ['裸命令', 'rm -rf x'],
    ['圆括号分组', '( rm -rf x )'],
    ['花括号分组', '{ rm -rf x; }'],
    ['复合命令里的分组', 'echo hi && ( rm -rf x )'],
    ['前导赋值', 'FOO=bar rm -rf x'],
    ['IFS 赋值', 'IFS=x rm -rf x'],
    ['LD_PRELOAD 赋值', 'LD_PRELOAD=x rm -rf x'],
    ['取反', '! rm -rf x'],
    ['time 关键字', 'time -p rm -rf x'],
    ['for 循环体', 'for f in *; do rm -rf x; done'],
  ])('%s：%s 命中 Bash(rm *)', (_label, cmd) => {
    expect(denyRm(cmd)).toBe(true)
  })
})

describe('基命令前的 shell 噪声 —— Read 桥接', () => {
  const denyRead = (cmd: string) => matchBashRule('Read(secret)', 'Bash', { command: cmd })

  it.each([
    ['裸命令', 'cat secret'],
    ['前导赋值', 'FOO=bar cat secret'],
    ['IFS 赋值', 'IFS=x cat secret'],
    ['LD_PRELOAD 赋值', 'LD_PRELOAD=x cat secret'],
    ['取反', '! cat secret'],
    ['time 关键字', 'time -p cat secret'],
  ])('%s：%s 命中 Read(secret)', (_label, cmd) => {
    expect(denyRead(cmd)).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `cd apps/cli && npx vitest run test/core/permission-rules.test.ts -t 'shell 噪声'`
Expected: **16 条里只有 2 条「裸命令」通过**，其余 14 条 FAIL。若某条意外通过，说明该形态已被别的机制覆盖 —— 把它从清单里删掉，不要留一条永远绿的断言。

- [ ] **Step 3: 写实现**

在 `apps/cli/src/core/permission-rules.ts` 中 `splitShellSegments` 之后新增：

```ts
/** Shell 结构符号：分组、取反 —— 它们自身不是命令，紧跟其后的是。 */
const LEADING_SHELL_PUNCT = new Set(['(', '{', '!'])

/** Shell 关键字：其后才是真正的命令（`do rm -rf x` 的命令是 `rm`）。 */
const LEADING_SHELL_KEYWORDS = new Set([
  'do',
  'then',
  'else',
  'elif',
  'if',
  'while',
  'until',
  'for',
  'case',
  'time',
  'coproc',
])

/** 一条前导赋值：`NAME=value`（name 必须是合法标识符，且 `=` 前无引号）。 */
const LEADING_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * 剥掉一段 shell 片段**前导**的噪声 token，露出真正的基命令。
 *
 * 为什么需要它：`Bash(rm *)` / `Read(secret)` 这类规则要匹配的是**命令本身**，
 * 而 shell 允许在命令前放赋值（`IFS=x rm -rf x`）、分组符号（`( rm -rf x )`）、
 * 关键字（`for …; do rm -rf x; done`）。这些都不改变「执行了什么命令」，
 * 却足以让匹配器看不到 `rm`，于是 deny 规则被一个空格级改写绕过。
 *
 * 只剥前导、可反复剥（`FOO=1 ! rm …`）—— 保守方向仍是过匹配：剥多了只会让
 * deny 规则更容易命中，而 deny 规则的过匹配是安全方向。
 * 不剥尾随符号（`rm -rf x )` 里的 `)`）：`wildcardMatch` 的 `*` 已经吃掉它。
 */
export function stripLeadingShellNoise(segment: string): string {
  let tokens = segment.trim().split(/\s+/).filter(Boolean)
  let stripped = false
  for (;;) {
    const head = tokens[0]
    if (!head) break
    const bare = head.replace(/^[({!]+/, '') // `(!` 这类连写
    if (bare !== head) {
      tokens = bare ? [bare, ...tokens.slice(1)] : tokens.slice(1)
      stripped = true
      continue
    }
    if (
      LEADING_SHELL_PUNCT.has(head) ||
      LEADING_SHELL_KEYWORDS.has(head) ||
      LEADING_ASSIGNMENT_RE.test(head)
    ) {
      tokens = tokens.slice(1)
      stripped = true
      continue
    }
    break
  }
  return stripped ? tokens.join(' ') : segment
}
```

然后在 `flattenCommand` 的循环体里，紧接 `out.push(seg)` 之后追加：

```ts
// 剥掉前导噪声后的形态也要参与匹配：`IFS=x rm -rf x` / `( rm -rf x )` /
// `for …; do rm -rf x; done` 执行的仍是 `rm`，规则必须看得见它。
const denoised = stripLeadingShellNoise(seg)
if (denoised !== seg) out.push(denoised)
```

并在 `extractBashFileAccess` 里，把第 2 步的扫描从「直接扫原命令」改为「先剥噪声再扫」（**这是防「只接一条路径」的关键**）：

```ts
// 2. Reader/writer command arguments (non-flag args are candidate paths),
//    recursing into `$(...)` / backtick substitutions.
//    先剥前导噪声再扫：`IFS=x cat secret` / `! cat secret` / `time -p cat secret`
//    读的是同一个文件，Read() 规则必须看得见 `cat`。flattenCommand 侧也接了
//    同一个函数 —— 两条路径共用一份归一化，否则就是「只接一条路径」。
scanReaderWriterCommands(command, read, write)
```

（`scanReaderWriterCommands` 内部对每个 `seg` 调用 `stripLeadingShellNoise(seg)` 之后再 tokenize —— 改在函数内部而不是调用点，这样它递归处理 `$(…)` 内层时也自动受益。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && npx vitest run test/core/permission-rules.test.ts`
Expected: PASS，且**原有断言一条不红**。若原有的 `Read(**)`/`Bash(git:*)` 之类断言变红，说明剥得过头（例如把 `git status` 里的某个 token 当成关键字）—— 回到 Step 3 收窄，不要改测试。

- [ ] **Step 5: 跑该文件相关的全量守卫**

Run: `cd apps/cli && npx vitest run test/core/permission.test.ts test/core/permission-rules.test.ts test/tools/bash.test.ts`
Expected: PASS。这三份是权限族的直接消费者。

- [ ] **Step 6: 提交**

```bash
cd apps/cli && git add src/core/permission-rules.ts test/core/permission-rules.test.ts
git commit -m "fix(permission): deny 规则不再被基命令前的 shell 噪声绕过

( rm -rf x ) / { rm -rf x; } / ! rm -rf x / FOO=bar rm -rf x /
IFS=x cat secret / for f in *; do rm -rf x; done —— 这些形态执行的
就是被 deny 的那条命令，此前却因为匹配器只认片段首 token 而全部漏判。

把「剥前导噪声」抽成 stripLeadingShellNoise，同时接入 flattenCommand
（Bash 通配）与 scanReaderWriterCommands（Read/Write/Edit 桥接）两条
路径 —— 只接一条即只修一半。剥除方向保守：宁可过匹配。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: `time` 关键字与 `timeout` 位置参数

**Files:**

- Modify: `apps/cli/src/core/permission-rules.ts`（`timeout` 的无条件 `i++` 改为条件跳过）
- Test: `apps/cli/test/core/permission-rules.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `stripLeadingShellNoise`（`time` 作为关键字已在其中剥掉，本任务**不**把 `time` 加进 `PREFIX_COMMANDS`）。
- Produces: 无新导出；`effectiveCommand` 行为变更（内部函数）。

**为什么 `time` 走关键字而不走 `PREFIX_COMMANDS`：** `PREFIX_VALUE_OPTIONS` 是**跨 wrapper 共享**的一张表，`-p` 在里面代表「sudo/doas 的取值选项」。一旦把 `time` 加进 `PREFIX_COMMANDS`，`time -p cat secret` 会走取值分支把 `-p` **和 `cat`** 一起吃掉，基命令退化成 `secret` —— 比原缺陷更坏。`time` 是 shell 关键字（只吃裸 flag、没有位置参数），归到 `stripLeadingShellNoise` 才对。

- [ ] **Step 1: 写失败的测试**

追加到 `apps/cli/test/core/permission-rules.test.ts`：

```ts
describe('timeout 的位置参数只吃 duration', () => {
  it('带 duration：仍能认出真正的命令', () => {
    expect(matchBashRule('Read(secret)', 'Bash', { command: 'timeout 5 cat secret' })).toBe(true)
  })

  it('不带 duration、只有裸 flag：不能把命令当 duration 吃掉', () => {
    expect(
      matchBashRule('Read(secret)', 'Bash', { command: 'timeout --preserve-status cat secret' }),
    ).toBe(true)
  })

  it('duration 带单位后缀', () => {
    expect(matchBashRule('Read(secret)', 'Bash', { command: 'timeout 30s cat secret' })).toBe(true)
  })

  it('防回归：time -p 不把 -p 当取值选项（-p 是 sudo 的取值选项）', () => {
    expect(matchBashRule('Read(secret)', 'Bash', { command: 'time -p cat secret' })).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `cd apps/cli && npx vitest run test/core/permission-rules.test.ts -t 'timeout 的位置参数'`
Expected: 第 1、3 条 PASS（今天的无条件 `i++` 恰好对），**第 2、4 条 FAIL**。第 4 条此时应当已经因 Task 1 而 PASS —— 若如此，把第 4 条**标记为防回归并保留**（它守的是「不要把 time 塞进 PREFIX_COMMANDS」这个决定），不要删。

- [ ] **Step 3: 写实现**

`permission-rules.ts` 中 `timeout` 那一行改为：

```ts
// `timeout` 的位置参数是 duration，**不是**必然存在：`timeout 5 cmd` 有，
// `timeout --preserve-status cmd` 没有。无条件 `i++` 会把后者真正的命令
// （`cat`）当成 duration 吃掉，基命令退化成它的第一个参数。
if (name === 'timeout' && i < tokens.length && TIMEOUT_DURATION_RE.test(tokens[i]!)) i++
```

并在文件靠近 `PREFIX_VALUE_OPTIONS` 处新增：

```ts
/** `timeout` 的 duration 形态：`5` / `0.5` / `30s` / `2m` / `1h` / `1d`。 */
const TIMEOUT_DURATION_RE = /^\d+(\.\d+)?[smhd]?$/
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && npx vitest run test/core/permission-rules.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd apps/cli && git add src/core/permission-rules.ts test/core/permission-rules.test.ts
git commit -m "fix(permission): timeout 的 duration 不再是「必然存在的参数」

timeout 的目标是可选的：timeout 5 cmd 有，timeout --preserve-status cmd
没有。此前无条件跳过一个 token，后者会把真正的命令当 duration 吃掉，
基命令退化成它的第一个参数。

time 关键字不进 PREFIX_COMMANDS —— 该表是跨 wrapper 共享的，-p 在里面
代表 sudo 的取值选项，time -p cat secret 会连 cat 一起被吃掉。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: 进程替换 `<(…)` / `>(…)` 递归

**Files:**

- Modify: `apps/cli/src/core/permission-rules.ts`（`extractSubstitutions`）
- Test: `apps/cli/test/core/permission-rules.test.ts`

**Interfaces:**

- Consumes: 无。
- Produces: `extractSubstitutions` 行为扩展（内部函数，未导出）。

- [ ] **Step 1: 写失败的测试**

```ts
describe('进程替换里的命令同样被解析', () => {
  it.each([
    ['读侧 <(...)', 'cat <(cat secret)'],
    ['写侧 >(...)', 'tee >(cat secret)'],
    ['嵌在复合命令里', 'echo hi && cat <(cat secret)'],
  ])('%s：%s 命中 Read(secret)', (_label, cmd) => {
    expect(matchBashRule('Read(secret)', 'Bash', { command: cmd })).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `cd apps/cli && npx vitest run test/core/permission-rules.test.ts -t '进程替换'`
Expected: 3 条全 FAIL。

- [ ] **Step 3: 写实现**

`extractSubstitutions` 中，在反引号之后追加：

```ts
// 进程替换 `<(cmd)` / `>(cmd)`：`cat <(cat secret)` 的读方是里层的 `cat`。
// 参数用 `[^()<>]*` 而非 `[^()]*` —— 否则 `<(cat secret)` 的捕获会在
// 遇到外层 `>` 时被提前截断；非嵌套组由调用方递归处理。
const procSub = /[<>]\(([^()<>]*)\)/g
while ((m = procSub.exec(command)) !== null) inners.push(m[1]!)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && npx vitest run test/core/permission-rules.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd apps/cli && git add src/core/permission-rules.ts test/core/permission-rules.test.ts
git commit -m "fix(permission): 进程替换 <(...) 里的命令也被解析

cat <(cat secret) 读 secret 的是里层的 cat，此前 extractSubstitutions
只认 \$(...) 与反引号，该命令整个不在匹配面上。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: `~` 与 `$HOME` / `$PWD` 展开

**Files:**

- Modify: `apps/cli/src/core/permission-rules.ts`（`extractBashFileAccess` 的候选路径做已知变量展开）
- Test: `apps/cli/test/core/permission-rules.test.ts`

**Interfaces:**

- Produces: `export function expandKnownPathVars(p: string, cwd?: string): string` —— 展开 `~`（前导）、`${HOME}`/`$HOME`、`${PWD}`/`$PWD`；未知变量原样保留。

**边界（必须在实现里写清，不得夸大）**：只展开 `HOME` 与 `PWD` 两个**进程级已知**的变量。`$FOO` 这类未知变量**不展开** —— 展开需要求值环境，而静默展开成空串会把 `/x/$FOO/y` 变成 `/x//y`，反而制造新的漏判方向。这条残留写在 docstring 里，不假装覆盖了。

- [ ] **Step 1: 写失败的测试**

```ts
describe('路径形规则：~ 与已知变量的展开', () => {
  const home = homedir()

  it('~ 展开为 home，命中绝对路径形规则', () => {
    const target = join(home, '.ssh', 'id_rsa')
    expect(matchBashRule(`Read(${target})`, 'Bash', { command: 'cat ~/.ssh/id_rsa' })).toBe(true)
  })

  it('$HOME 展开', () => {
    const target = join(home, '.ssh', 'id_rsa')
    expect(matchBashRule(`Read(${target})`, 'Bash', { command: 'cat $HOME/.ssh/id_rsa' })).toBe(
      true,
    )
  })

  it('${HOME} 花括号形态', () => {
    const target = join(home, '.ssh', 'id_rsa')
    expect(matchBashRule(`Read(${target})`, 'Bash', { command: 'cat ${HOME}/.ssh/id_rsa' })).toBe(
      true,
    )
  })

  it('未知变量原样保留，不被展开成空串', () => {
    expect(extractBashFileAccess('cat $UNSET_VAR/secret').read).toContain('$UNSET_VAR/secret')
  })

  it('路径通配规则对展开后的绝对路径依然有效', () => {
    expect(matchBashRule('Read(**/.ssh/*)', 'Bash', { command: 'cat ~/.ssh/id_rsa' })).toBe(true)
  })
})
```

文件头补 import：`import { homedir } from 'node:os'`、`import { join } from 'node:path'`，并把 `extractBashFileAccess` 加进 `permission-rules` 的 import。

- [ ] **Step 2: 跑测试确认它失败**

Run: `cd apps/cli && npx vitest run test/core/permission-rules.test.ts -t '已知变量的展开'`
Expected: 前 3 条与第 5 条 FAIL；第 4 条 PASS（今天是原样保留，本任务要**保住**它）。

- [ ] **Step 3: 写实现**

```ts
/**
 * 展开路径里**已知**的变量：前导 `~`、`$HOME`/`${HOME}`、`$PWD`/`${PWD}`。
 *
 * 为什么需要：规则里写的是绝对路径（`Read(/Users/me/.ssh/id_rsa)`），而用户
 * 敲的是同一个文件的另一种拼法（`cat ~/.ssh/id_rsa`）—— 不展开即等于放行。
 *
 * **只展开进程级已知的两个变量**。`$FOO` 这类未知变量原样保留：展开它需要
 * 求值环境，静默展开成空串会让 `/x/$FOO/y` 变成 `/x//y`，那是**新增**一个
 * 漏判方向，比不展开更坏。这条残留是本函数已知的边界。
 */
export function expandKnownPathVars(p: string, cwd?: string): string {
  let out = p
  if (out === '~') out = home
  else if (out.startsWith('~/')) out = join(home, out.slice(2))
  out = out.replace(/\$\{?HOME\}?/g, home)
  if (cwd) out = out.replace(/\$\{?PWD\}?/g, cwd)
  return out
}
```

其中 `home` 取模块顶部的 `import { homedir } from 'node:os'`（`const home = homedir()`）。在 `scanReaderWriterCommands` 里压入候选路径前统一过一遍：

```ts
read.push(expandKnownPathVars(p /* cwd 未知则省略 */))
```

**注意**：`extractBashFileAccess(command)` 今天没有 `cwd` 参数，而 `matchBashRule` 的调用点也没有 —— 所以 `$PWD` 只在能拿到 cwd 时才展开。**不要为此给 `extractBashFileAccess` 加第二个参数**：它会牵动 `matchBashRule` 的签名，而 `matchBashRule` 的调用点（`permission.ts:297-379`）没有 cwd 上下文。本任务只展开 `~` 与 `HOME`，`PWD` 的展开点留到 Phase 4 一并处理（届时 `matchBashRule` 能拿到 cwd）。这条要在 docstring 与提交信息里如实写明。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && npx vitest run test/core/permission-rules.test.ts`
Expected: PASS。第 4 条（未知变量原样）必须仍然 PASS。

- [ ] **Step 5: 提交**

```bash
cd apps/cli && git add src/core/permission-rules.ts test/core/permission-rules.test.ts
git commit -m "fix(permission): 路径形规则展开 ~ 与 \$HOME

规则写 Read(/Users/me/.ssh/id_rsa)，用户敲 cat ~/.ssh/id_rsa —— 同一个
文件的另一种拼法，此前完全不在匹配面上。

只展开进程级已知的 HOME（~ 与 \$HOME/\${HOME}）。未知变量如 \$FOO 原样
保留：展开需要求值环境，静默展开成空串会让 /x/\$FOO/y 变成 /x//y，反而
新增一个漏判方向。PWD 需要 cwd，而 matchBashRule 的调用点没有该上下文，
留待后续批次。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: `validateRulePattern` 拒绝永不匹配的参数化规则

**Files:**

- Modify: `apps/cli/src/core/permission-rules.ts`（`validateRulePattern`）
- Test: `apps/cli/test/core/permission-rules.test.ts`

**Interfaces:**

- Produces: `validateRulePattern` 新增一类返回串（对不支持的工具有效的参数化规则）。**它不改变 `matchBashRule` 的行为** —— 只把「今天静默失效」变成「装载时报错」。

- [ ] **Step 1: 写失败的测试**

```ts
describe('validateRulePattern 拒绝永不匹配的参数化规则', () => {
  it.each(['WebFetch(*)', 'Task(*)', 'MultiEdit(/x)', 'BashTool(*)'])(
    '%s：该工具的参数化规则永远匹配不上，必须报错',
    (pattern) => {
      const reason = validateRulePattern(pattern)
      expect(reason).not.toBeNull()
      expect(reason).toMatch(/not supported/i)
    },
  )

  it('mcp__ 工具的参数化规则同样被拒（matchBashRule 的 baseTool 集合里没有它）', () => {
    expect(validateRulePattern('mcp__srv__tool(*)')).toMatch(/not supported/i)
  })

  it.each([
    'Bash(rm *)',
    'Read(**)',
    'Write(/etc/*)',
    'Edit(*.ts)',
    'Grep(**/vendor)',
    'Glob(**/.ssh)',
  ])('支持的工具名仍然合法：%s', (pattern) => {
    expect(validateRulePattern(pattern)).toBeNull()
  })

  it('裸工具名不受影响', () => {
    expect(validateRulePattern('Bash')).toBeNull()
    expect(validateRulePattern('WebFetch')).toBeNull()
  })
})
```

文件头把 `validateRulePattern` 加进 import。

- [ ] **Step 2: 跑测试确认它失败**

Run: `cd apps/cli && npx vitest run test/core/permission-rules.test.ts -t '永不匹配的参数化规则'`
Expected: 前两组 FAIL（今天一律返回 `null`）；「支持的工具名」与「裸工具名」两组 PASS。

- [ ] **Step 3: 写实现**

在 `validateRulePattern` 的 `return null` 之前插入：

```ts
// 工具名必须落在 matchBashRule 真正会按参数匹配的那一集合里，否则这条
// 规则是**静默空防护**：语法合法、装得上、永远不命中，用户以为有保护。
const [, tool] = pattern.match(/^(\w+)\(/) || []
if (tool && !PARAMETERISED_TOOLS.has(tool)) {
  return `parameterised rules are not supported for tool "${tool}" (it would never match)`
}
```

并在 `matchBashRule` 上方新增（与 `matchBashRule` 里 `baseTool` 的分支集合**逐字对应**，改一边必须改另一边）：

```ts
/**
 * `matchBashRule` 真正会按参数匹配工具名的集合。**与 matchBashRule 的分支
 * 一一对应** —— 那里 `return false` 的工具，参数化规则在这里必须被拒。
 */
const PARAMETERISED_TOOLS = new Set(['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'])
```

并把 `validateRulePattern` 的 docstring 补一句：它校验的是**结构 + 工具名**，**不**校验子模式本身能否匹配任何东西。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && npx vitest run test/core/permission-rules.test.ts test/core/permission.test.ts`
Expected: PASS。**重点看 `permission.test.ts` 有没有因此红** —— 若已有测试用了非白名单工具的参数化规则，那条规则今天就是静默失效的，应当**改测试里的规则**（换成支持的工具有效的形式）而不是放宽白名单。

- [ ] **Step 5: 提交**

```bash
cd apps/cli && git add src/core/permission-rules.ts test/core/permission-rules.test.ts
git commit -m "fix(permission): 拒绝永不匹配的参数化规则

WebFetch(*) / Task(*) / mcp__srv__tool(*) 这类规则语法合法、装得上、
永远不命中 —— 是静默空防护，用户以为配了保护。validateRulePattern 的
docstring 本就自称 mirroring exactly what matchBashRule will match，
但没有校验工具名。

新增 PARAMETERISED_TOOLS 白名单，与 matchBashRule 的分支一一对应。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: worktree 逃逸守卫改用路径解析

**Files:**

- Modify: `apps/cli/src/security/path.ts`（`isWithin` 加 `export`）
- Modify: `apps/cli/src/tools/exec/bash.ts`（抽 `resolveWorktreeEscape` 纯函数并修复）
- Test: `apps/cli/test/tools/bash.test.ts`

**Interfaces:**

- Consumes: `isWithin`（`apps/cli/src/security/path.ts`，本任务将其导出）。
- Produces: `export function resolveWorktreeEscape(cwd: string, worktreeRoot: string, command: string): string | null` —— 返回第一个逃逸出工作树的 `cd` 目标（原样字符串，供错误文案用），无逃逸则返回 `null`。

**三处缺陷（一次修完）** —— 其中只有 1、3 是**活绕过**，2 是被兜住的：

1. 拼接式 `target.startsWith('/') ? target : \`${cwd}/${target}\``—— 不解析`..`，
拼出来的串仍以 cwd 开头 ⇒ 逐级 `..` 走出项目被放行。**活绕过**。
2. `resolved.startsWith(ctx.cwd)` —— **字符串前缀**比较，`/proj/w1-evil` 会被判成
   「在 /proj/w1 里」。**但它不构成活绕过**：这样的路径仍在 `worktreeMarker.root`
   之下，被第二个析取项兜住。判定谓词写错仍要改（改用按路径分段比较的
   `isWithin`），但**不得声称修掉了一个能被利用的洞**。
3. `command.match(...)` 非全局 —— 只看第一个 `cd`，`cd sub && cd /etc` 的后半段
   完全不检查。**活绕过**。

> **语义边界**：判定边界是 `worktreeRoot`（**项目根**），不是 `cwd` —— 既有的
> 「allows cd inside the project from a .mipham worktree」（`test/tools/exec.test.ts`）
> 就是这个意思，本次不动它。

- [ ] **Step 1: 写失败的测试**

追加到 `apps/cli/test/tools/bash.test.ts`：

```ts
import { resolveWorktreeEscape } from '../../src/tools/exec/bash'

describe('worktree 逃逸判定', () => {
  // 真实形状：cwd 在 .mipham/worktrees/<name> 之下，root 是项目根
  // （findWorktreeMarker 取 marker 之前的部分 —— 见 core/paths.ts:47）。
  const WT = '/proj/.mipham/worktrees/w1'
  const ROOT = '/proj'
  const escape = (cmd: string) => resolveWorktreeEscape(WT, ROOT, cmd)

  it('绝对路径逃逸被拦', () => expect(escape('cd /etc')).toBe('/etc'))
  it('相对路径里的 .. 被真解析（此前是字符串拼接，原样放行）', () =>
    expect(escape('cd sub/../../../../../etc')).toBe('sub/../../../../../etc'))
  it('逐级 .. 走出项目被拦', () => expect(escape('cd ../../../..')).toBe('../../../..'))
  it('每一个 cd 都检查（此前只 match 第一个）', () =>
    expect(escape('cd sub && cd /etc')).toBe('/etc'))
  it('引号包裹的目标同样被检查', () => expect(escape('cd "/etc"')).toBe('/etc'))

  it('区内子目录放行', () => expect(escape('cd sub/dir')).toBeNull())
  it('回到工作树上一级（仍在项目内）放行', () => expect(escape('cd ..')).toBeNull())
  it('项目内其它目录放行', () => expect(escape('cd /proj/src')).toBeNull())
  it('无 cd 时无事发生', () => expect(escape('ls -la')).toBeNull())

  // 语义锚点：边界是「项目根」，不是 cwd 的字符串前缀
  it('恰好回到项目根放行、再上一级被拦', () => {
    expect(escape('cd ../../..')).toBeNull()
    expect(escape('cd ../../../..')).toBe('../../../..')
  })
  it('字符串前缀相同的兄弟目录在项目内，按既有语义放行', () => {
    expect(escape('cd /proj/.mipham/worktrees/w1-evil')).toBeNull()
  })
})
```

> **外加两条端到端的**（`test/tools/exec.test.ts` 的 C1 块）：`cd ../../../.. && ls`
> 与 `cd sub && cd /etc && ls` 在真工具路径上必须被拦。纯函数断言绿、守卫没接上时
> 只有这两条会红 —— 就是本批反复防的「只接一条」。

- [ ] **Step 2: 跑测试确认它失败**

Run: `cd apps/cli && npx vitest run test/tools/bash.test.ts -t 'worktree 逃逸判定'`
Expected: 全部 FAIL，报 `resolveWorktreeEscape is not a function`（该函数尚不存在）。

- [ ] **Step 3: 写实现**

`apps/cli/src/security/path.ts`：把 `function isWithin(` 改为 `export function isWithin(`。

`apps/cli/src/tools/exec/bash.ts`：在文件模块作用域新增

```ts
/**
 * 判断命令里是否有 `cd` 走到工作树之外，返回第一个逃逸目标（用于错误文案），
 * 无逃逸则返回 null。
 *
 * 三个坑一个函数修完，它们此前互相掩盖：
 *  - 用 path.resolve 归一（`sub/../../..` 与 `..` 都要真解析），此前是字符串拼接；
 *  - 归属判定用 isWithin（按路径分段比较），此前是 `startsWith(cwd)` —— 字符串
 *    前缀会把 `/tmp/wt/proj-evil` 判成「在 /tmp/wt/proj 里」；
 *  - 遍历**所有** `cd`，此前只 match 第一个，`cd sub && cd /etc` 的后半段不被检查。
 */
export function resolveWorktreeEscape(
  cwd: string,
  worktreeRoot: string,
  command: string,
): string | null {
  const cdRe = /\bcd\s+(?:"([^"]+)"|'([^']+)'|([^\s;|&]+))/g
  for (const m of command.matchAll(cdRe)) {
    const target = m[1] ?? m[2] ?? m[3]
    if (!target) continue
    const resolved = resolve(cwd, target)
    if (!isWithin(resolved, cwd) && !isWithin(resolved, worktreeRoot)) return target
  }
  return null
}
```

（`import { resolve } from 'node:path'` 与 `import { isWithin } from '../../security/path'` 按文件现有 import 风格补。）

原守卫体改为：

```ts
const escapeTarget = resolveWorktreeEscape(ctx.cwd, worktreeMarker.root, command)
if (escapeTarget !== null) {
  return {
    success: false,
    content: '',
    error:
      `Worktree isolation: cannot cd outside worktree directory. ` +
      `Attempted: ${escapeTarget}. Use tools within the worktree only.`,
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && npx vitest run test/tools/bash.test.ts test/security/`
Expected: PASS。若 `test/security/` 下有 `isWithin` 的既有断言，加 `export` 不影响它们（只是放宽可见性）。

- [ ] **Step 5: 跑 Phase 1 全量 + 评分守卫**

Run:

```bash
cd apps/cli && npx vitest run test/core/permission.test.ts test/core/permission-rules.test.ts test/tools/bash.test.ts test/security/ test/core/hooks.test.ts
```

Expected: PASS。

再跑一次 CRSI 评分确认**不退化**（38 条冻结契约含权限相关断言，当前满分 100；**实跑读数**）：
Run: `cd apps/cli && pnpm dev -- --crsi-eval`（或按本机既有方式触发 `/crsi eval`）
Expected: 分数 **≥ 本批之前的基线**，无降级。若降级，**先查是不是本批引入的**，不要改冻结契约迁就实现。

> **已实跑（2026-09-18）**：`runEval()` 直接调用 ⇒ **100/100（38/38）**，与批前同分。
> 调用方式：临时脚本 `import { runEval } from "…/core/eval-harness"` 后 `bun run` ——
> 只调 `runEval()`、**不调** `appendEvalScore`，以免往台账里写探针读数。

- [ ] **Step 6: 提交**

```bash
cd apps/cli && git add src/security/path.ts src/tools/exec/bash.ts test/tools/bash.test.ts
git commit -m "fix(permission): worktree 逃逸守卫改用路径解析

三个互相掩盖的缺陷一次修完：
- 归属判定是字符串前缀比较，cwd=/tmp/wt/proj 时 /tmp/wt/proj-evil 被
  判成「在工作区内」；
- 相对路径用字符串拼接而非 path.resolve，`cd sub/../../../etc` 不被归一；
- 只 match 第一个 cd，`cd sub && cd /etc` 的后半段完全不检查。

抽成纯函数 resolveWorktreeEscape 以便直接断言；isWithin 从 path.ts 导出
复用，不落第二份「是否在目录内」的实现。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6b: git 的 `--work-tree` 归属判定（**执行中发现，不在原 27 条清单内**）

**Files:**

- Modify: `apps/cli/src/tools/exec/git.ts`（`isOutsideWorktree`）
- Test: `apps/cli/test/tools/exec.test.ts`

改 Task 6 时在隔壁文件撞见的**同族活绕过**：`isOutsideWorktree` 的归属判定是
`refPath.startsWith(cwd)` / `startsWith(worktreeRoot + '/')`，**从不归一 `..`** ⇒
`git status --work-tree=/proj/../etc` 因为「以 /proj/ 开头」被放行，而 git 实际拿到
的是 `/etc`。旧判据已实测复现该行为。

修法：`resolve(cwd, refPath)` 后按路径分段比较（`isWithin`），与 Task 6 同一套判据。

**语义变更（明说，不要藏）**：归一后落在项目内的**相对**引用（`--work-tree=sub`）
由「拦」改为「放」—— 此前是被字符串前缀比较误伤的过拦。判据边界仍是项目根，
与既有「allows a --work-tree reference inside the project」一致。两个方向各一条测试。

> 已按此执行：`0a67604`。

---

### Task 7: Phase 1 收口——两条路径的一致性守卫

**Files:**

- Test: `apps/cli/test/core/permission-rules.test.ts`

**为什么单列一个任务**：本批的核心风险是「只接一条路径」。上面每个任务都各自绿，但**没有任何一条断言把两条路径绑在一起** —— 后来者完全可以只改 `flattenCommand` 而让 `scanReaderWriterCommands` 退回旧行为，测试照样全绿。本项目已因同一形态栽过两次，本任务加的就是那道机械防线。

- [ ] **Step 1: 写测试**

```ts
describe('两条匹配路径共用同一份归一化（防「只接一条」）', () => {
  // 同一段噪声，Bash 通配路径（flattenCommand）与 Read 桥接路径
  // （scanReaderWriterCommands）必须都看得见真命令。
  const NOISY = ['( cmd )', '{ cmd; }', '! cmd', 'FOO=bar cmd', 'IFS=x cmd', 'time -p cmd']

  it.each(NOISY)('噪声形态 %s：Bash 通配路径看得见', (tpl) => {
    expect(matchBashRule('Bash(rm *)', 'Bash', { command: tpl.replace('cmd', 'rm -rf x') })).toBe(
      true,
    )
  })

  it.each(NOISY)('噪声形态 %s：Read 桥接路径也看得见', (tpl) => {
    const command = tpl.replace('cmd', 'cat secret')
    expect(matchBashRule('Read(secret)', 'Bash', { command })).toBe(true)
    // 反面对照：噪声 token 自己不该被当成读目标。
    expect(extractBashFileAccess(command).read).not.toContain('cmd')
  })

  it('归一化可反复施加', () => {
    for (const tpl of NOISY) {
      const once = stripLeadingShellNoise(tpl.replace('cmd', 'rm -rf x'))
      expect(stripLeadingShellNoise(once)).toBe(once)
    }
  })
})
```

把 `stripLeadingShellNoise` 加进 import。

- [ ] **Step 2: 跑测试**

Run: `cd apps/cli && npx vitest run test/core/permission-rules.test.ts -t '只接一条'`
Expected: 全 PASS。**若有红的，说明前 6 个任务里有路径没接上 —— 回去补，不要改这条测试。**

- [ ] **Step 2b: 负对照（必做，否则这条守卫等于没验）**

把 `scanReaderWriterCommands` 里的 `stripLeadingShellNoise(seg).split(...)` 临时改回
`seg.split(...)`，重跑：**恰好 6 条 Read 桥接用例变红、6 条 Bash 通配用例仍绿**。
红完立刻还原（`git diff` 必须为空）。只跑一遍全绿说明不了任何事 —— 守卫要能失败才算守卫。

- [ ] **Step 3: 提交**

```bash
cd apps/cli && git add test/core/permission-rules.test.ts
git commit -m "test(permission): 把两条匹配路径绑在一起（防只接一条）

Bash 通配路径与 Read 桥接路径此前各解析各的，是绕过得以存在的结构
原因。本批给两条路径接了同一份归一化，这个守卫把该约束固化下来：
后来者只改一条，测试必红。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: Phase 1 文档回填

**Files:**

- Modify: `CLAUDE.md`（仓库根：测试计数、`## 最近提交`、`### 修订历史`）
- Modify: `ROADMAP.md`（测试计数一处）
- Modify: `docs/claude-md-history.md`（被挤出的行 + 本批全文）

- [ ] **Step 1: 取真实数字**

Run: `cd apps/cli && pnpm test 2>&1 | tail -20`
把**实测**的 `Test Files` / `Tests` 数字抄下来。**不要**在文档里写估算值 —— 数字必须由命令产出。

- [ ] **Step 2: 同提交回填**

改 `CLAUDE.md`（仓库根）里所有出现测试数的地方（含测试表的「合计」行），并在 `### 修订历史` 加一行（**单行 ≤1,200 字符**，只留最近 3 行，第 4 行逐字移入 `docs/claude-md-history.md`）。

- [ ] **Step 3: 校验字符预算**

Run: `cd apps/cli && npx vitest run test/integrity/tool-reference-integrity.test.ts`
Expected: PASS（含「CLAUDE.md ≤ 40,000 字符」与「滚动窗口 3 行」两条守卫）。红则先精简散文，**不要放宽阈值**。

- [ ] **Step 4: 提交**

```bash
cd apps/cli && git add CLAUDE.md ../CLAUDE.md 2>/dev/null; git add CLAUDE.md
git commit -m "docs: 回填权限加固批次的测试计数与修订历史

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Phase 1 之后

### 后续批次骨架（各自独立成计划）

- **Phase 2（输出上限与错误分类）**：`grep.ts` 三件事一次做完 —— rg 路径也走 `truncateGrepOutput`；find 回退的 `exitCode===1` 改为「stderr 非空则报错」；`runSearch` 消费 stderr 并返回。Glob 的 500 上限加 `(truncated)` 标记（与 Grep 同一原则，理由已写在 `grep.ts:32` 的注释里）。验收：造一个超过 50k 字符的命中集，断言输出带标记；PATH 去掉 rg 后断言非法正则以错误收场。
- **Phase 3（数据落点与并发写）**：Artifact 目录同源（并给 `saveVersion` 接上调用点）+ `atomicWriteFileSync` 唯一临时名 + `CronJob` 加 `cwd`/`sessionId` 并按 cwd 过滤 + `read.ts` 按需读窗口。验收：Artifact 发布后 fetch 自己回报的 URL 必须 200；两个不同 cwd 建的同名任务互不可见。
- **Phase 4（接线与配置）**：`BLOCKED_PATHS` 存解析后形态 + `validateRulePattern` 已做 + `mergeConfig` 深合并 + `.mcp.json` 补齐两个字段 + Stop hook 的 `decision` 贯通 + SubagentStart/Stop matcher 按 agent 类型过滤 + 子代理 ctx 补齐 + HTTP MCP 通知处理器接线。验收：每条都要有「改动前红、改动后绿」的测试，不留只读码结论。
- **Phase 5（剩余）**：#27 已提前执行完毕（2026-09-18）；其余为体验项。

### 每条批次结束时的固定动作

```bash
cd apps/cli && pnpm test && pnpm typecheck && pnpm lint && pnpm format
```

再跑 `/crsi eval` 确认分数不退化，然后同提交回填文档数字。

---

## Self-Review

**1. 覆盖检查**：缺口清单 27 条，Phase 1 详细展开 7 条（#1–#7），其余 20 条各自落在 Phase 2–5 并有坐标与验收方向。清单里每条都指到了具体任务或批次。

**2. 占位符扫描**：无 TBD / 「适当处理」类措辞。每个代码步骤都给了可直接粘贴的实现。Task 4 里 `$PWD` 的处置是**明确的范围收缩**（并写了理由与去处），不是待填。

**3. 类型/命名一致性**：`stripLeadingShellNoise(segment: string): string`（Task 1 定义，Task 7 断言）、`expandKnownPathVars(p: string, cwd?: string): string`（Task 4）、`resolveWorktreeEscape(cwd, worktreeRoot, command): string | null`（Task 6）、`PARAMETERISED_TOOLS`（Task 5）、`TIMEOUT_DURATION_RE`（Task 2）—— 引用处与定义处逐字一致。

**4. 已知的诚实边界**（写进计划是为了不被当成已解决）：

- Task 4 只展开 `~` 与 `HOME`；`$FOO` 这类未知变量与 `$PWD` **仍未覆盖**，是明确记录的残留，不是遗漏。
- Phase 2 的「Node 下真函数会挂住」是**同形状推断**（真函数无法在 Node 下直接 import），实现时应补一条真函数级验证。
- Task 6 的 `resolveWorktreeEscape` 处理的是 `cd` 的**静态字符串**；`cd "$(echo /etc)"` 这类动态目标不在覆盖范围（原实现也不在）。
