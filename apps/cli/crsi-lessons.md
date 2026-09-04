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

## eval-rigor: 晋升须统计严谨——因果归因 + 误提升预算 + 最小效应量

- 建议: 自改进的「晋升/固化」不能只靠「整体分数不退化」这一道闸，须统计严谨：① **因果归因**——只有单组件变更（其余全同）才标因果，多组件/替换永不标因果（防「改 A 碰巧 B 变好」）② **误提升预算**——campaign 级 alpha 预留 + 块不相交道，防「试到够多总能过」③ **最小效应量**——置信区间须越过最小效应，而非「分数≥阈值」④ **原子激活**——不可变 manifest + 指针 CAS 替换，读者要么见旧要么见新。
- 严重度: warning
- 生成时间: 2026-08-27
- 来源: 会话复盘（human + Claude Code，手动沉淀）
- 落地: ④ 原子激活已实现（2026-09-01 `f852214`）——`improvement-track.ts` 台账 `appendImprovement` 走 `atomicWriteFileSync`（temp+rename）、`readImprovements` 坏行跳过不抛、`setPendingVerdict` 由易失内存变量升级为 `pending-verdict.json` 原子 manifest；① ② ③ 早由同文件落地（causal / minEffect / Wilson）。

### 证据

- autocontext（Apache-2.0）`docs/context-bundles.md`：晋升八道检查，核心三条——「只有当比较恰好只省略一个 `(kind,key,digest)` 且其余全同时，才转 `causal_attribution.json`；替换/多组件永不标因果」、「campaign 级持久 alpha 预留 + 块不相交道」、「自适应确认置信区间须越过最小效应量」；激活 = 单个 `active.json` 原子指针替换 + compare-and-swap
- 对照 CRSI：`/crsi eval` 冻结 21 契约但用「整体分数不退化」单道闸——缺因果归因、缺误提升预算、缺最小效应量，可逐条补强（延伸 blastRadius 教训 + wiki 行动 D）
- kernel-evolution 补一句：「独立 primary/confirmation + per-case floor，不用一个聚合分掩盖某工作负载失败」

## boundary: 自改进边界 ≠ 执行安全，语义边界优于路径黑名单

- 建议: 评估自改进系统要把「自改进边界」和「执行安全」分开看，二者可独立强弱——一个项目可能「自改进保守、执行裸跑」。自改进边界用**语义**划分（「不可变基础 prompt」vs「可编辑补充状态」）比路径黑名单更清晰、更不易漏。
- 严重度: warning
- 生成时间: 2026-08-27
- 来源: 会话复盘（human + Claude Code，手动沉淀）

### 证据

- prime-agent（MIT）`refinement.ts`：base system prompt「immutable and MUST NOT be rewritten」、只改 harness 状态、Never edit source files directly、快照 rollback——自改进边界保守 ✅；但 README 明说「用用户权限执行模型生成 Python/命令，worker/kernel 是**生命周期**隔离、**不是安全沙箱**」——执行安全裸跑 ❌。两层独立，之前 wiki 把「更保守」误写成「更安全」
- `/refine` 要求每条 edit 附 scope metadata「帮助未来 review 理解预期 blast radius」——CRSI `blastRadius` 闸门的真实产品实现，验证 2.17.0 方向
- 映射 CRSI：`crsi-sandbox.ts` 的 `PROTECTED_PATHS` 是路径黑名单，可改为显式「immutable base」语义清单

## learning: 失败先分类再学习 + 自改进只路由不禁用

- 建议: 自改进系统的学习必须两步：① **失败先分类**——学习前先判「可恢复/环境性/用户驱动 vs 真缺陷」，可恢复失败只记录、不进成功率分母，否则会把成功率拉低、诱导系统误杀能用的能力；② **只路由、不禁用**——固化规则时加语义护栏，拒绝「禁用某内置能力」的 blanket 规则，强制改写成「prefer X over Y」。
- 严重度: warning
- 生成时间: 2026-08-27
- 来源: 会话复盘（human + Claude Code，手动沉淀）

### 证据

- opencrabs（MIT）`feedback_policy.rs` `is_recoverable_tool_failure`：stale-hash 重试 / channel 未连接 / bash 环境性失败 ≠ 工具缺陷，若混入成功率会「拖着 RSI 禁用能用的工具」（#236 把 hashline_edit 升级成 blanket DO NOT USE）
- `self_improve_guards.rs` `bans_builtin_tool`：语义精确拒绝「禁用内置工具」规则（区分禁用对象 / 推荐替代 / 非工具），强制「路由」
- 映射 CRSI：producer 固化规则（`crsi-managed-rules.ts`）有同样风险——可加 ① 失败分类（SIS/EffectivenessTracker 学习前先判可恢复性）② 禁用护栏（拒绝「禁用某能力」规则，只许路由）

## borrow-landing: 教训≠实现——借鉴调研须「落地对账」，别把「记了该做」当成「写了代码」

- 建议: 对外部项目做「可借鉴点」调研后，产出必须显式对账三态：① **已写代码**（文件 + 行数）② **只记了教训**（markdown，未实现）③ **仍是待办**（教训里列「可借鉴」但没动工）。三者混进一个「已落地/已实现」清单，会把「记下了该做 X」误读成「X 已实现」——教训是「意图」，代码是「交付」，边界必须钉死。
- 严重度: warning
- 生成时间: 2026-08-27
- 来源: 会话复盘（human + Claude Code，手动沉淀）

### 证据

- 2026-08-26 RSI 五家调研（OpenRSI / opencrabs / autocontext / prime-agent / Godel_Agent）→ 产出 6 条教训 + 1 份计划，被误记为「借鉴代码进仓库」
- 实际落地对账：① **代码** = `recoverable-failure.ts`（27 行，open crabs 失败分类）唯一落地；② **教训** = `crsi-lessons.md` 6 条（borrow-analysis / crsi-design / self-eval / eval-rigor / boundary / learning）；③ **待办** = 因果归因、最小效应量、误提升预算、原子激活、语义边界、RewardFn、Crossover（都在教训里列为「可借鉴」，未写代码）
- 事后对账（2026-09-01）：上条「待办」7 项已全部落地 → 因果归因/最小效应量/误提升预算/原子激活 = `improvement-track.ts`（`causal` L66 / `computeMinEffect` / `wilsonInterval` + `improvementSignalStrong` / `atomicWriteFileSync` + `pendingVerdictPath`）；语义边界 = `crsi-sandbox.ts` `PROTECTED_ROLES`；RewardFn = `reward-fn.ts`；Crossover = `crsi-producer.ts` `produceCrossoverProposal`。待办清零。
- 混淆根因：Mipham Code(deepseek) 把 `recoverable-failure.ts` 的「失败分类」错叫「因果归因的第一步」，又把 eval-rigor 教训里「记了该做因果归因」当成「因果归因已实现」——「教训」与「代码」边界不清
- 修复：本教训 + wiki `rsi-open-source-research.md` 补「落地对账」表，钉死「五家 → 6 教训 + 1 文件 + 若干待办」真实状态

## read-first: 回答代码问题前必须先读代码（未读就下结论是禁止的）

- 建议: 回答任何关于本代码库的问题（文件/函数/功能是否存在、如何工作、我们缺什么）前，必须先调 Read/Grep/Glob/graft 读实际代码；凭记忆/命名/静态清单下结论、答错后再认错，是禁止的。这条覆盖一切代码问答，不止调研/借鉴分析。
- 严重度: critical
- 生成时间: 2026-08-28
- 来源: 会话复盘（human + Claude Code，手动沉淀）

### 证据

- Mipham Code 终端功能测试会话：连续多次草率回答用户代码问题后再认错，未先读代码
- 现有 `research: 调研判断必须先读自身代码库` 教训只覆盖借鉴分析场景，漏出通用代码问答
- 根因：教训是软摘要（低优先级召回），不是顶层硬约束；本次同步在 `instructions.ts` 加系统提示顶层铁律块（Read-Code-First Rule）

## correctness: argv 解析必须做引号感知 tokenize（裸 split 拆散带空格的参数）

- 建议: 用 argv 数组 spawn 子进程时，绝不能 `command.split(/\s+/)` 裸拆——它不做引号解析，`-m "multi word"` 会被拆成多个参数（空格变分隔符、引号变字面字符）。必须用引号感知的 tokenizer（单引号/双引号/反斜杠转义），否则任何带空格的参数（commit message、`--author="John Doe"`、含空格文件名）都会失效。
- 严重度: warning
- 生成时间: 2026-08-29
- 来源: 会话复盘（human + Claude Code，手动沉淀）

### 证据

- `git.ts:118` 用 `command.split(/\s+/)` 拆 `git commit -m "docs: add ..."` → `-m` 只吃到 `"docs:`，其余词全变 pathspec，报 `pathspec 'add' did not match`
- 根因：`split(/\s+/)` 按空白正则拆分、不做 shell 引号解析；`bash.ts` 走 `bash -c` 交给 shell 解析所以无此 bug，只有 git 工具有
- 修复：新增 `splitCommand()`（单/双引号 + 反斜杠转义），替换裸 split；+6 测试（1 集成捕获 argv + 5 单元），issue #22 关闭

## security-rule: 安全正则须区分「执行」与「描述」——config user.* blanket 误拦说明文本

- 建议: 危险命令正则（`DANGEROUS_GIT_PATTERNS` 等）对**命令字符串**做 blanket 匹配时，无法区分「我正要执行这个命令」vs「我在描述一个例子」（如 issue body / 说明文本里出现 `git config user.name` 字面量）。同一类「把合法描述当危险命令」的过度拦截，与教训 #1（`$()` blanket）同源——安全规则只拦「具体危险动作」，不拦「字面提及」。
- 严重度: warning
- 生成时间: 2026-08-29
- 来源: 会话复盘（human + Claude Code，手动沉淀）

### 证据

- 建 issue #22 时，`gh issue create --body "..."` 里「影响面示例」出现 `git config user.name` 字面量，被 `bash.ts` 引入的 `DANGEROUS_GIT_PATTERNS`（`/\bconfig\s+.*user\./`）误判「身份伪造」拦截
- 根因：`bash.ts` 把针对 git 命令的 `DANGEROUS_GIT_PATTERNS` 应用到**所有** bash 命令文本，`config user.*` 正则命中 body 里的描述性字面量
- 状态：**已修复（2026-09-01 2.28.0）**——`bash.ts` 加 git 前缀门 `/(?:^|[\s;&|])git\s+/`，只对含 `git ` 子命令的文本扫 `DANGEROUS_GIT_PATTERNS`，`gh` 不再扫；`bash.test.ts:156-173` 锁死「`gh issue create --body "git config user.name"` 放行」+「`git config user.name "attacker"` 拦截」

## verify-before-build: 对标外部生态前先核实「标准是否真实存在」+「自身是否已实现」

- 建议: 收到「对标 X / 兼容 X 生态」的需求时，动手写码前必须过三道核实：① **外部标准真实性**——查官方文档/真实生态，确认 X 的标准究竟是什么（文件是 .md 还是 .json、确切文件名、schema），禁止凭命名臆测（把「SKILL.md 单文件约定」臆测成「SKILLS.md」、把 settings.json / plugin.json / .mcp.json 臆测成 HOOKS.md / PLUGINS.md / MCP.md）；② **自身现状**——grep/read/graft 查自己是否已实现，禁止凭印象说「我们缺 X」然后从零重复造；③ **目标自身是否回退**——读目标的 CHANGELOG **后续版本段**（不只当前版），看该机制/修复有没有在后面的版本被 Revert / Changed back——上游「加了又回退」= 该方案有过度/缺陷，是上游自己否定的信号，对标者照抄会复刻一个被否的方案。三道核实都没做就直接开发 = 先造空中楼阁再返工，白费一整轮。
- 严重度: critical
- 生成时间: 2026-08-31
- 来源: 会话复盘（human + Claude Code，手动沉淀）

### 证据

- 用户要求「兼容 AGENTS.md / SKILLS.md 等生态文件」，Claude 凭臆测发明 SKILLS.md / HOOKS.md / PLUGINS.md / MCP.md 四个 .md「标准」并开发对应读取代码（instructions.ts），用户点破这些 .md 根本不存在——真实生态是 SKILL.md 单文件约定 + settings.json（permissions+hooks）+ plugin.json（.claude-plugin）+ .mcp.json，**全是 JSON 不是 .md**
- 用户再问「是否对标开发 hooks/plugins/MCP 走 JSON」，Claude 凭印象以为「没做」，读码才发现 executeHook（hooks-executor.ts）、loadHookConfigs（hooks-config.ts）、loadMcpJson（loader.ts）、claude-plugin.ts 早已实现——真正缺的只有 loadHookConfigs 零调用点（没接线到 settings.json 读取）
- 双重弯路同一根因：① 未核实外部标准真实性 → 开发了不存在的东西；② 未查自身现状 → 差点从零重复造已存在的轮子
- ③ 的实演（2026-09-04）：Claude Code 2.1.259 加了「Read() deny 规则扩展到 Bash 参数」，2.1.260 直接回退（"Reverted the 2.1.259 change applying Read() deny rules to Bash arguments; it denied `npm run build` under a `Read(./**/build/**)` rule in every mode and made `cd … && grep` prompt even in auto mode"）。Mipham v0.72.0（`7446106`，#52+#44）独立落地了同类 Read→Bash deny 扩展，但范围更保守（只扫 reader/writer 命令白名单 + 重定向，不扫任意参数/选项值），天然避开上游两个假阳性。教训：只读 2.1.259 会以为该机制值得照抄，读到 2.1.260 才知上游自己否掉了它。落地：P0 回归测试锁死 `npm run build` / `cd src && grep foo` 不被 `Read(./**/build/**)` 误拦（permission-rules.test.ts）。

## security-benchmark: 对标安全漏洞须验证前提——黑名单缺模式 ≠ 有漏洞

- 建议: 对标外部项目的安全修复时，不能「它修了 X 类型漏洞、我黑名单没这个模式 → 我也缺 X」。必须先追「这条命令在自身权限模型里到底走哪条路径」：漏洞成立的前提（如「按内容自动放行看似无害命令」的启发式）在自身架构里是否真的存在。黑名单是「阻断侧」（deny），漏洞通常出在「放行侧」（auto-approve）——只读黑名单、没读放行侧决策流程就下「确认缺失」，是机械套用。白名单 auto-approve + 默认 ask 的架构，漏洞前提天然不成立。
- 严重度: warning
- 生成时间: 2026-09-01
- 来源: 会话复盘（human + Claude Code，手动沉淀）

### 证据

- 对标 Claude Code v2.1.251「Bash 权限自动放行整数 shell 变量算术赋值（OPTIND=1/0、RANDOM=2+2）」：初版只读黑名单 `security/gate.ts:30-38`（4 条 DANGEROUS_BASH_PATTERNS，无算术赋值模式）就断言「确认缺失，建议做」
- 误判根因：未读 Bash 权限决策流程。真相——Bash 默认 `permission: 'ask'`（`bash.ts:313`），唯一「按内容自动放行」路径是 acceptEdits 模式的 `isVerificationCommand`（`permission.ts:17-61`），是**白名单**（L22 排除 shell 元字符 + 只匹配 pnpm test/tsc/git status 等显式命令），`OPTIND=1/0` 不含白名单命令名 → 落到 ask，**无自动放行路径**
- Claude Code 漏洞前提 =「auto mode 黑名单分类器按内容自动放行」；Mipham =「白名单 auto-approve + 默认 ask」，前提不成立 → 结论应为「不适用」而非「确认缺失」
- 修复：对标文档 #1 改「不适用」+ 新增 §三 专项核查 + §附 误判复盘；本条教训固化进 crsi-lessons.md

## causal-memory: Zeva 因果交互记忆——对齐 CRSI + 2 条因果归因深化缺口

- 建议: Zeva（arXiv 2608.30880）核心论点「存 action→state-change 的**因果关系**，而非 observation 片段」对齐 Mipham CRSI 的「不 retrain、只注入」路线，但暴露 2 条「因果归因」可深化的真缺口：① **阶段条件检索**——Zeva 用 phase token 按任务阶段索引记忆，Mipham recall 只有 TF-IDF cosine + category + path，缺「阶段」维度（编码任务天然有 读码→规划→实现→测试→review）② **结构化因果边**——Zeva 显式存 (action, state-change, 方向) 三元组，Mipham 的 `causal: changeSet.length === 1` 是粗布尔，非「哪个改动→哪个效果→哪个方向」的一等对象 ③ 确定性相似度合并——已实现（见证据「已实现」项）。
- 严重度: warning
- 生成时间: 2026-09-01
- 来源: 会话复盘（human + Claude Code，手动沉淀）

### 证据

- Zeva（清华 AIR + 域变换）三组件：Causal Interaction Extractor（CTE 融合视觉 latent + 动作 + 观测到的状态变化 → phase token + causal signal）、双时标记忆（BIT 近期 attempt 内 + PIM 跨 attempt 相似度合并）、In-Context Policy Injection（phase-conditioned retrieval → Causal Prompt → 注入冻结 diffusion policy 的 full-attention 块）
- 对齐（已覆盖 / 领先）：冻结参数 + 记忆侧学习 = CRSI 核心；自进化随经验提升 = improvement-track（verdict + improvementRate + Wilson CI）；防错误经验积累 = eval harness 33 契约 + 分数不退化闸 + 只拦 regressed（**领先**——这是 Zeva 明列的 open challenge，我们已有确定性格门）；因果归因 = `causal`；合并 = crossover 算子；双时标 = session-log vs memory/lessons
- 不适用（别硬套）：视觉 latent / diffusion policy / full-attention 注入是具身 VLA 实现细节，Mipham 对应物是 prompt 注入（已覆盖）；连续物理状态空间 vs 编码任务离散状态（测试通过/失败、diff）
- 深化方向（2 真缺口，但**无观察痛点、暂不实现**——2026-09-04 决策）：① phase 维度检索键 ② 结构化因果边 (change→effect→方向)。属 borrow-driven 非 pain-driven，按 `simplicity` 教训搁置（「差异化/创新本身不是加功能的理由」）；等真实需求（召回误阶段 / 因果误判）出现再动，接 eval-rigor #11 方向
- 已实现（verify-before-build 复现）：③ 确定性相似度合并——初判为缺口，读码发现 `memory-manager.ts` 早有 `findNearDuplicate`（写时去重，`DEDUP_THRESHOLD` 0.65，同 type 余弦>阈值→合并 union relevance）+ `consolidateAutoMemories`（贪心聚簇 auto-* → lesson-*，`CONSOLIDATE_THRESHOLD` 0.5），都是确定性 cosine 无 LLM。误判根因：把 LESSON 的 LLM crossover 与 MEMORY 的确定性去重混为一谈
- 转帖标题出入（verify-before-build 复现）：转帖写「In-Context Causal Interaction Memory for Embodied Action Generalization」，arXiv 实为「In-Context Causal Learning for Generalizable Embodied Manipulation」——「Causal Interaction Memory」是机制名不是标题

## network-fallback: 网络降级只能靠 CDP，curl/Jina/DuckDuckGo 是伪改进

- 建议: 联网工具（WebFetch/WebSearch）遇网络直连受限（GFW）时，「加 curl/Jina 降级」或「加 DuckDuckGo 免 key 回退」是伪改进——它们同样被墙。唯一可靠通道是用户 Chrome（CDP，web-access skill）。落地应是「失败信号明确提示改用 web-access」，保持模型编排回退，而非工具层硬编码降级（避免耦合 web-access 的 localhost:3456 proxy）。
- 严重度: warning
- 生成时间: 2026-09-02
- 来源: 会话复盘（human + Claude Code，手动沉淀）

### 证据

- 实测本机（2026-09-02）：原生 fetch（WebFetch 用）、curl → raw.githubusercontent.com、curl → r.jina.ai（Jina）均超时（exit 28，GFW 封锁）；唯一成功的是 CDP（用户 Chrome，web-access skill 走 localhost:3456），拿到 604KB changelog
- 结论：DuckDuckGo / Brave / Jina 全是被墙对象，「免 key 回退」与「curl/Jina 降级」在 GFW 环境同样失败，属「改了也没用」
- 落地：WebFetch/WebSearch 失败信号 + 无 key 场景补「建议走 web-access(CDP)」提示（web-fetch.ts / web-search.ts）；不加工具层自动降级，回退决策仍在模型
