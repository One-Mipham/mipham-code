# CRSI Lessons

本文件由 CRSI producer（`/crsi propose`）自动追加教训。每条教训由 CrsiSandbox 跑全量测试验证、经人类批准后合入。

<!-- CRSI lessons are appended below this line. -->

## security-rule: 命令替换 $() 的 blanket 拦截是误伤

- 建议: 安全规则只拦「具体危险内容」，不拦「合法语法本身」。$() / 反引号命令替换是 Bash 合法特性，其危险内容（curl|sh、base64 -d、python -c、eval、bash -c、source 等）应被具体模式覆盖，而非一棒子拦掉整个语法。
- 严重度: warning
- 生成时间: 2026-08-24
- 来源: 会话复盘（human + Claude Code，手动沉淀）

### 证据

- `apps/cli/src/tools/exec/bash.ts` 的 `/\$\(/` blanket 拦了 `echo $(pwd)` 等合法命令，会话日志「Pattern matched: \$\(」误伤 ×2
- 修复：删 blanket 拦截，危险内容仍被 curl|sh / base64 -d / python -c / eval 等具体模式扫到（含 $() 内部）
- 同类隐患：`src/security/gate.ts` 的 `SecurityGate.checkBashCommand` 也有同样误伤，一并修

## simplicity: 未要求的功能是负债（违反简洁优先）

- 建议: 不添加未被真实用户要求的功能。每个没人用的功能 = 维护成本 + bug 风险；功能要「用户请它才来」，不是「它挡用户路」。**差异化/创新本身不是加功能的理由**——「为创新而创新、为特色而特色」是同一坑的更隐蔽形态：给没人要的功能披上「我们与众不同」的外衣，最终仍是负债 + bug 温床。
- 严重度: critical
- 生成时间: 2026-08-24
- 来源: 会话复盘（human + Claude Code，手动沉淀）

### 证据

- vim 模式（2026-08-21 添加）无真实用户需求，主用户（非技术）不使用，却引入 Esc 切换陷阱
- 用户实测「打不出字 / 回车不了 / 冻住」——根因是 Esc 误触 vim 普通/搜索模式
- 修复：整个删除 vim 模式（7 文件 −521 行），输入框回归单一 `>` 提示符
- 6 权限模式里的 auto/dontAsk 两档（2026-08-25 复盘）：为「对标 Claude Code 之外再加特色」而加，非真实需求；`auto` 与 legacy config 字段 `auto` 同名不同义，映射错 → 用户启动即落入「全自动执行」静默改文件。修复：收敛回 Claude Code 的 4 档（default/acceptEdits/plan/bypassPermissions）

## doc-drift: help 文案必须与实现一致

- 建议: 面向用户的文案（/permissions 输出、占位符、错误提示）必须与真实行为一致。文案漂移比没文案更糟——它误导用户往错误方向排查。
- 严重度: warning
- 生成时间: 2026-08-24
- 来源: 会话复盘（human + Claude Code，手动沉淀）

### 证据

- `/permissions` 显示旧的 3 级 auto/ask/bypass，与真实 6 模式不符，用户找不到如何授权 bash
- 占位符写「Esc 取消」，但空闲时 Esc 实际切 vim 模式——文案与行为矛盾
- 修复：重写 /permissions 显示真实 6 模式 + Shift+Tab；占位符改「Esc 清空」；拒绝提示补指引
