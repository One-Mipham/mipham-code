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

## onboarding: 用户「愣建文件夹」是产品缺引导，非用户错

- 建议: 用户不会自觉走规范流程，产品必须主动引导——检测到空目录/未初始化项目时温和提示 `mipham init`，而非假设用户知道、让用户自己摸索。修根因（补引导入口）优先于怪用户「冷建立文件」。
- 严重度: warning
- 生成时间: 2026-08-25
- 来源: 会话复盘（human + Claude Code，手动沉淀）

### 证据

- 用户「愣建文件夹/冷建立文件」→ 缺项目脚手架：`/init` 被「用户 config」占用（同名不同义），`/setup 1` 只生成 MIPHAM.md 不含 CLAUDE.md/README.md
- 修复：新增 `mipham init` 脚手架（CLAUDE.md/MIPHAM.md/README.md + 可选 git init）+ 空目录启动提示

## reproducibility: 一次性抽取工具必须入库（勿放 /tmp）

- 建议: 任何「一次性」但未来可能复用的工具（PDF 抽取、数据清洗、迁移脚本）都必须固化入库并提交，不能留在 /tmp 或未提交的工作区。工具是「数据的钥匙」——丢了工具等于丢了重做数据的能力。可复现性 = 源数据 + 抽取工具 + 配方三者都进版本控制（大体积源数据可 gitignore，但工具与配方必须入库）。
- 严重度: warning
- 生成时间: 2026-08-26
- 来源: 会话复盘（human + Claude Code，手动沉淀）

### 证据

- 高中课标（20 科）PDF 抽取脚本 2026-08-25 一次性放 /tmp、未入库，事后连同 pdftotext 依赖一起丢失，无法复现抽取
- 义务教育课标（16 科，1829 页图片型 PDF）2026-08-26 被迫从零重建抽取工具：装 pymupdf + pyobjc-Vision、重写 OCR 脚本、排查「无文本层需 OCR」
- 修复：本次把 `extract_pdf_ocr.py` + `extract_dir_ocr.py` 固化进 `backend/scripts/` 并提交，杜绝二次丢失

## research: 调研判断必须先读自身代码库再下结论

- 建议: 对外部项目做「可借鉴点」分析时，声称「我们缺 X」之前必须先读自己的代码库验证是否真的缺。未经验证的判断写进交付报告，等于制造 doc-drift——把「我猜的」当「事实」给用户。
- 严重度: warning
- 生成时间: 2026-08-26
- 来源: 会话复盘（human + Claude Code，手动沉淀）

### 证据

- 本次调研 A 项「启动 digest 回读」：报告称「CRSI 缺启动 digest 回读，值得补」，实际 `instructions.ts` 已实现（loadCrsiLessons + buildCrsiLessonsBlock + crsi-lessons-recall.test.ts 6 个测试）
- 同一会话第二次：默认「/crsi propose 适用」却没读 selectCrsiSignal 的 autoApplicable 过滤（仅 timeout/tool-params），直到读码才发现不匹配

## correctness: 自我纠错必须闭环——发现错误要回改产物，不只写教训

- 建议: 自我纠错不止「发现错误 → 沉淀教训」。发现自己交付的产物（笔记/报告/代码/文档）里有错误时，必须**先回去改掉错误产物本身**，再沉淀教训。教训是给「未来」的防复发机制，但「现在」的错误产物会继续误导读者/用户——只写教训不修产物 = 半成品纠错。
- 严重度: warning
- 生成时间: 2026-08-27
- 来源: 会话复盘（human + Claude Code，手动沉淀）

### 证据

- 2026-08-26 RSI 调研会话：写 wiki 笔记 `rsi-open-source-research.md`，其中 A 项「启动 digest 回读应立即做」错误（`instructions.ts` 早已实现 loadCrsiLessons + buildCrsiLessonsBlock + crsi-lessons-recall.test.ts 6 测试）
- AI 事后读码发现自己错了，commit 了教训 `0039122`（「调研判断必须先读自身代码库」），但没回去把错误笔记的 A 项改掉——错误产物原样留在 wiki，未来读者仍会被误导
- 正确顺序：发现错误 → ① 立即回改错误产物 → ② 沉淀教训防复发（两步都要做，缺一是半成品）

## borrow-analysis: 借鉴外部项目必须同时查许可 + 安全/执行边界

- 建议: 对外部项目做「可借鉴点」分析时，不能只记「机制/架构」，必须同时核查三样：① 许可证（能否抄代码/权重 vs 只能借思想）② 安全/执行边界（它怎么跑不可信代码、隔离强度如何）③ 自身是否真缺（避免声称「我们缺 X」）。三样都查清才可下结论，否则「拿来主义」会踩 CC BY-NC 等许可地雷，或误判安全强度。
- 严重度: warning
- 生成时间: 2026-08-27
- 来源: 会话复盘（human + Claude Code，手动沉淀）

### 证据

- OpenRSI（FrontisAI）调研：许可证是 **CC BY-NC 4.0（非商用）**，昨晚笔记只标了 HyperAgents 的 CC BY-NC-SA，漏了头号推荐 OpenRSI 的许可——Mipham Code（Apache-2.0 商业）不能抄代码/权重，只能借思想
- OpenRSI 执行隔离：OpenMLE Sandbox = Docker/Podman **断网容器 + 资源/文件系统限制**（OS 级隔离、无 gVisor），自动评分在隔离容器内跑——强度「够用非顶级」
- 可借鉴机制（思想层，不受许可限制）：① 四原子算子（Draft/Improve/Debug/Crossover）→ CRSI producer 补 **Crossover 算子** ②「改进率本身当优化目标」→ CRSI eval 从「分数不退化」升级「改进率不退化」 ③ 可验证任务环境规模化（5758 可执行任务）→ eval harness 扩展方向

## crsi-design: 受约束 vs 无约束自改进——隔离与回滚是安全分水岭

- 建议: 评估自改进系统时，「隔离」与「回滚」是安全的分水岭，比「许可证能否抄」更重要。无约束自改进（in-process exec / 猴子补丁、无沙箱、无快照）即便 MIT 许可可抄实现，也不该抄——那是生产级漏洞的根源。真正值得抄的是「接口层抽象」：把 reward/evaluate 显式化为 `policy → feedback` 接口，让评估器可插拔。
- 严重度: warning
- 生成时间: 2026-08-27
- 来源: 会话复盘（human + Claude Code，手动沉淀）

### 证据

- Godel_Agent（北大 ArvidYin，**MIT 许可**）：`action_run_code` 用 `exec(code, globals())` + `subprocess.run(shell=True)` **无沙箱**执行；`action_adjust_logic` 用 `exec(compile())` + `setattr` 猴子补丁自修改；**无 snapshot/rollback**，改坏自己只靠 `evolve≥100` 的 `sys.exit(1)` 兜底；`goal_prompt` 明授 "unrestricted access / install external libraries"（可 `pip install` 任意包）
- 对比：OpenRSI（CC BY-NC）有 Docker/Podman 断网容器隔离；CRSI 有 worktree + 全量测试 + diff + approve/reject + PROTECTED_PATHS + 分数不退化闸
- 结论：**MIT 可抄 ≠ 该抄实现**；该抄的是「reward function = policy→feedback」这类接口抽象，落到 CRSI = `/crsi eval` 的 evaluate 抽成 `RewardFn` 接口（wiki 行动清单 D/E 延伸）

## self-eval: 隔离须默认 fail-closed + 自报分数不可信

- 建议: 自改进系统的两条执行安全铁律：① 隔离必须是**默认**且 fail-closed——找不到隔离设施就拒绝执行，不能「opt-in 才隔离、默认裸跑」；② **模型自报的分数不可信**，只能作诊断，父代选择/合入必须靠独立评估（沙箱重跑），不采纳模型自评。
- 严重度: warning
- 生成时间: 2026-08-27
- 来源: 会话复盘（human + Claude Code，手动沉淀）

### 证据

- OpenRSI（CC BY-NC）源码核实：`run_task_process` 默认 `execution_mode="process"`（宿主机裸跑），`isolated` 是 opt-in——虽有 `test_isolated_mode_never_falls_back` 保证不静默降级，但「默认裸跑」仍是盲点；对比其 isolated 模式加固（`--cap-drop ALL` / `--no-new-privileges` / `--network none` / `--read-only` / `noexec,nosuid tmpfs` / pids·mem·cpu 上限）是认真做的
- OpenRSI `overview.md` 反作弊：模型自报分数默认不作父代选择依据（`trust_model_validation_score=false`）
- 映射 CRSI：CrsiSandbox 已用 worktree 隔离（比容器更保守）、eval harness 已独立评估（分数不退化闸）——本轮价值 = ① 把「隔离默认 fail-closed」显式固化 ② 把「自报分数只作诊断」显式进 eval harness 契约
