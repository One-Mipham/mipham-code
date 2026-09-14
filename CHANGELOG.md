# Changelog

All notable changes to Mipham Code will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> 0.68.0 之后的条目于 2026-09-14 依据 git 提交记录回溯补全（标签日期为准）。

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
