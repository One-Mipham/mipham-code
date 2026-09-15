# Changelog

All notable changes to Mipham Code will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> 0.68.0 之后的条目于 2026-09-14 依据 git 提交记录回溯补全（标签日期为准）。

## [0.81.6] — 2026-09-15

### Security

- **`Read(...)` deny 规则可被「读文件写 stdout」的命令绕过** —— `READER_COMMANDS` 缺了整类读者命令：`fmt secret` / `column -t secret` 同样把文件送进了工具的读路径，检查器却认不出这条命令是读者。补 20 条 —— 文本格式化/变换 `fmt column pr fold expand unexpand rev look bat`，结构化读者与字节工具 `jq yq base64 md5sum sha1sum sha256sum shasum cksum sum cmp iconv`。均只入读列表、不入写列表（`md5sum secret` 不该被 `Edit(...)` 规则拦下）。命令名单是唯一缺口：扫描器对每个非 `-` 开头的参数都入读列表（选项值也当路径，只多不少），文件跟在哪个选项后面不影响命中
- **`/clear` 与 `/resume` 未清空文件读取追踪** —— `engine.readFiles` 是会话级「读过才能覆盖」的凭据（`write` 工具 fail-closed 依据它拦下覆盖未读文件），却只在**同一段对话**内成立：`/clear` 清空历史、`/resume` 载入另一段历史，两者都不碰它 → 新对话可以覆盖它从没读过的文件。新增 `QueryEngine.resetFileTracking()`，在「消息历史被替换」的两条路径上调用。清空是 fail-closed 方向 —— 未读文件宁可要求重读，不可静默覆盖

### Fixed

- **MCP `tools/list_changed` 通知紧循环放大** —— 此前是「一条通知 → 一次 `tools/list` round trip → 一次下游全量重注册」，服务器按工具逐条通知（或陷入循环）时这个 1:1 就是放大器：持续高 CPU + 重注册风暴。改为每连接合并刷新：250ms 去抖窗口 + **2000ms 上限**（纯 trailing 去抖会被「永不停止通知」的服务器无限推后），in-flight 期间到达的通知排队补跑一次、不丢变更；`disconnect` / `closeAll` / `reconnect` 三处清定时器（`reconnect` 必需 —— 同名重连会让遗留定时器打到新连接上），定时器 `unref()` 不吊住 CLI 进程退出

## [0.81.5] — 2026-09-14

> 0.81.4 未作产品版本发布 —— 该号已被 VS Code 扩展的 changelog-only 重发占用（仍跑 CLI 0.81.3），产品线故跳至 0.81.5。

### Security

- **daemon 外部 API 此前可被任意网页驱动** —— 两道「安全」机制实际都只防「响应被读到」，不防「请求被发出」：`auth.ts` 用 socket IP 判 loopback 即免鉴权，而浏览器发出的请求源 IP 同样是 `127.0.0.1`（Chrome 视 `http://127.0.0.1` 为可信来源，HTTPS 页面也不触发混合内容拦截）；`cors.ts` 只在响应上加 ACAO 头，而 `mode: 'no-cors'` 强制 `text/plain`（属 CORS 安全列表内，**不触发预检**），`await req.json()` 也不看 Content-Type → 请求照发、handler 照跑。WebSocket 握手更根本不受同源策略约束：浏览器会带 `Origin` 但不会拦连接，服务端不校验即等于全开。完整攻击链：恶意网页 → WS 或 `POST /api/v1/sessions` 带任意 `cwd`（此前零校验）→ 驱动 agent 读取该目录下任意文件（`read` 为 `auto` 级，`BLOCKED_PATHS` 不含主目录）→ 结果经 WS 流回页面；`createSchedule` 还会持久化并在重启后仍存活。RCE 仅被 `write` / `edit` / `bash` 的 `ask` 挡住，而 daemon 中 `ask` 等于拒绝。修复：新增 `originMiddleware` —— 无 `Origin`（CLI / curl）放行以保持既有行为不变，有 `Origin` 且不在 `MIPHAM_CORS_ORIGINS` 白名单则 403，置于 WS upgrade 之前故握手一并覆盖（刻意不复用 `isLocalhostOrigin`，其子串匹配会让 `https://localhost.evil.example` 通过）；`POST /api/v1/sessions` 的 `cwd` 须为已信任 workspace 或 daemon 启动目录子树内。已验证 Bun 与 Node/undici 的 WS 客户端均不发 `Origin`，CLI 行为不变

### Changed

- 内置 `superpower` skill 2.0.0 → 2.1.0：选择性吸收上游 `obra/superpowers` 增量 —— `<SUBAGENT-STOP>` 守卫（子代理拿到具体任务时忽略此技能）、announce 约定（`Using [skill] to [purpose]`）、Red Flags 表 5 → 12 行
- 修正该 skill 中引用了 Mipham 并不存在的技能名（`brainstorming` / `systematic-debugging` / `frontend-design` / `mcp-builder` → `to-spec` / `debug-loop` / `implement` / `codebase-design`），并补全 `User Instructions` 的优先级链（用户指令 > 技能 > 默认行为）。明确**不**引入上游 `Platform Adaptation` —— 那是 Codex / Pi / Antigravity / Hermes 各家 harness 的分支指引，对本项目自己的 harness 无意义

## [0.81.3] — 2026-09-14

### Fixed

- `.mipham/rules/*.md` 路径作用域规则此前**从不注入** —— `RulesLoader` 自引入起就未接线（生产零调用点、模块从不加载；knip 未报，系覆盖率实测发现）。现已接线：启动时加载规则，并在**两处**工具执行后注入 —— 首轮工具与多轮工具循环。后者原先完全未接，只补前者会让规则迟一整轮用户输入才生效

## [0.81.2] — 2026-09-14

### Added

- knip 未接线检测（报告制）—— `pnpm knip` 列出生产零调用的模块；带 `--no-exit-code`，不进 CI 闸门

### Fixed

- 首装向导不再写裸 `models:` 行，保住内置模型的元数据
- `doctor` 的 CLAUDE.md 审计跳过已披露章节，防 `prompt-exclude` 剥掉正文指针
- `deploy status` 子命令不再重复打印状态

### Changed

- 移除失效的静态页部署链 `deploy-cn.sh`
- CLAUDE.md 事实校正：`vajra/compose` 通路未接 live startup、测试数 2259→2266、Vitest 5、测试分项表按 `test/` 各目录实测重算
- 变更记录表拆分到 `docs/claude-md-history.md`

## [0.81.1] — 2026-09-13

### Fixed

- session 持久层的家目录解析统一走 `os.homedir()` —— 原先依赖 `process.env.HOME`，HOME 分裂时会话日志写到错误位置

### Changed

- 全量统一家目录解析：`apps/cli/src` 对 `process.env.HOME` 的直接引用归零

## [0.81.0] — 2026-09-12

### Added

- `workflow` 的 `parallel()` 并发上限可配置：`MIPHAM_WORKFLOW_MAX_CONCURRENT_AGENTS`（1–256，默认按 CPU 取 16）

### Fixed

- 安全：前缀命令（`sudo` / `env` / `timeout` / `nohup` / `command` / `eval` / `nice` / `xargs` / `doas` / `exec` / `stdbuf`）不再绕过 Read / Edit / Bash 的 deny 规则 —— 新增 `PREFIX_COMMANDS` + `effectiveCommand()` 剥离包装命令定位真命令
- Web：React 18→19 统一，修 `build-web` 与 typecheck 失败

### Changed

- 依赖升级：vitest 4→5、eslint、@typescript-eslint、@types/bun、actions/setup-java
- Dependabot PR 在 CI 绿后自动 squash 合并（npm 生态）

## [0.80.1] — 2026-09-12

### Fixed

- 欢迎屏 banner 间歇重复：MCP 注册 / 连接消息改走 `console`，不再用 `process.stderr.write` 直写 stderr 绕过 Ink 的 `patchConsole` 光标追踪

## [0.80.0] — 2026-09-12

### Changed

- 升级 Ink 5.2.1 → 7.1.1、React 18 → 19

### Fixed

- 欢迎屏 banner 间歇重复（升级尝试，未根治；真根因见 0.80.1）

## [0.79.1] — 2026-09-11

### Fixed

- Backspace 键回归修复 —— Ink 把 macOS Backspace（`\x7f`）映射成 `key.delete` 而非 `backspace`
- 上下键历史导航抽为纯函数

## [0.79.0] — 2026-09-11

### Added

- 输入光标左右移动 —— `applyEdit` 纯函数 + `MiphamTextInput` 光标跟踪

### Fixed

- 底部状态行行距统一；`graft` / `ctx` 状态行去掉 dim 字体
- 欢迎屏 `/help` 重复
- release 管线：npm 11 安装改用 sudo；JetBrains 重复版本幂等跳过

### Changed

- npm 发布切换为 OIDC trusted publishing

## [0.78.0] — 2026-09-11

### Added

- skill `trim-process-prose` —— 压缩冗余的过程叙述

### Changed

- skill 重命名 `systematic-debugging` → `debug-loop`（frontmatter 的 `name:` 才是真名，文件名仅作回退）

### Removed

- skill `pre-push-checks`

## [0.77.2] — 2026-09-10

### Added

- Bash 工具 description 指引：用大白话描述命令，不回显命令本身

### Fixed

- 安全：marketplace 路径净化 —— 未净化的 skill 名拼进文件路径可致 path traversal

## [0.77.1] — 2026-09-09

### Security

- 修 audit 高危依赖：next 15.5.25（2 个 critical RCE）、sharp 0.35.4、js-yaml 4.3.2

## [0.77.0] — 2026-09-09

### Security

- 不可信内容规则：读取外部产出（artifact / MCP / web）时当数据处理、不当指令 —— 双层固化（`instructions.ts` always-on 规则 + self-critique 审计准则）

## [0.76.0] — 2026-09-07

### Added

- 新增 Provider：MiniMax（国内 / 国际两区域，API key 按区域发放）、GPT-6 Astra、Claude Mythos 5（受限模型）
- `skills.reminder` 启动 token 开关：full / compact / off

### Fixed

- 安全：Bash 规则递归替换 `$()` / 反引号 —— 堵 zsh 赋值隐藏替换绕过 deny 规则

## [0.75.0] — 2026-09-05

### Added

- `/skill-doctor` —— 列出未使用 skill 及其 context 成本，按证据 prune
- 状态栏 PR 指示器 —— 分支名旁显示 PR #N（按状态着色）

## [0.74.0] — 2026-09-04

### Added

- CRSI eval harness 增加 self-report-diagnostic 锚点（评分路径不含 LLM）

### Fixed

- 粘贴乱序 / 丢内容 / 冻住：换掉 `ink-text-input`（分块投递时读渲染闭包旧值切片插入）→ `MiphamTextInput` ref 原子追加 + 归一化 `[\r\n\t]+` + 移除节流

## [0.73.1] — 2026-09-04

### Fixed

- Grep 顶层范围 fail-fast：`rg` exit 2 不再被误判为「未安装」而回退慢 `find`（曾致硬扫家目录、15 分钟卡死）
- 会话退出兜底按真名落盘，并补 `SIGHUP` 处理

### Changed

- banner 副标题更新为「超级智能体」

## [0.73.0] — 2026-09-04

### Added

- 权限规则结构校验：畸形规则不再静默失效，并输出 stderr 告警

### Fixed

- Read→Bash 保守范围回归（避开上游 CC 259→260 的误拦回退）
- `sync` 脚本写双副本；om-v5 模型重同步

### Changed

- 首屏不再显示 contextWindow 原始数字，`/models` 改用友好单位

## [0.72.0] — 2026-09-02

### Added

- WebFetch / WebSearch 失败时提示改走 `web-access`(CDP)

### Fixed

- 安全：Bash deny 规则边界扩展 + 复合命令分段（堵 `cat` 绕过 Read deny）

## [0.71.0] — 2026-09-01

### Added

- `/memory dedup` —— 只读的近重复记忆报告
- `/cost` 增加 prompt-cache 行；`/mcp connect` 输出 HTTP 信息披露
- managed rule 禁用护栏：拒绝「禁用某能力」的 blanket 规则
- CRSI 原子激活：台账原子写 + pending verdict 持久化 manifest

### Fixed

- 安全：git 危险守卫移除对 `gh` 的误拦（不再因命令中含 git 描述文本而拦截 gh）
- Provider：畸形 `tool_use` 丢弃空 name；`[DONE]` 路径补 id 兜底

## [0.70.0] — 2026-08-31

### Added

- marketplace 源机制 —— 任意公开仓库的 skill 可安装；社区 registry 增加 `grill-me` / `eli5`
- hooks 全链路对齐 Claude Code：stdin / stdout JSON 协议 + `settings.json` 接线
- `/fix` —— 确定性自修复命令；`/fix test` —— LLM 修复失败测试（复用 bench 冻结判定）

### Changed

- `/loop init` 删去 `.sh` 约定；`/hooks` 改为指向 `settings.json`

## [0.69.0] — 2026-08-31

### Added

- CRSI Recuris 记忆进化四组件 + 记忆卫生
- CRSI 工作记忆 Phase 2：证据接地状态机
- CRSI 工作记忆接线 TaskList —— 任务完成证据门（软门）

## [0.68.0] — 2026-08-30

### Added

- 补全 init 规范文件（CHANGELOG / DEVELOPMENT / TRADEMARKS / .github/CODEOWNERS）
- 本 CHANGELOG 自此版本起开始维护
