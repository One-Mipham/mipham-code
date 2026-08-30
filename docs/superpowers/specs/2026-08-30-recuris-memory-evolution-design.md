# Recuris 记忆进化四组件借鉴 — 最小落地设计

> **日期**: 2026-08-30
> **作者**: Guohua Zhang · One Mipham Corporation
> **术语**: 借鉴论文 [Recuris（arXiv:2608.24876）](https://arxiv.org/abs/2608.24876) 的「递归经验–工作记忆进化」——把 agent 记忆层拆成 `M=(E,W,ρ,C)` 四组件、失败归因到单一组件、只 patch 被牵连组件、门「修源任务 + 不回归 anchor」。仅借概念不借代码。
> **前情**: 我们的 CRSI 已有 E（skills + crsi-lessons + managed-rules）、ρ 的部分（RulesLoader）、G（「分数不退化」闸）。缺 **W 工作记忆 / C 事后检查器 / A 组件归因 / 门细粒度化（anchor）**。
> **总原则**: 四件全部向后兼容、可独立落地、互不阻塞；每件以「eval harness 加一条冻结契约」为可验证的完成标准（先写测试再实现）。

---

## 一、落地顺序与依赖

| #   | 模块                           | 依赖               | 体积 | 价值/代价比                      |
| --- | ------------------------------ | ------------------ | ---- | -------------------------------- |
| ④   | Anchor 契约（门细粒度化）      | 无                 | 小   | 最高（纯 harness，零运行时风险） |
| ①   | 组件归因 `component` 字段      | 无（默认 E）       | 小   | 高（类型安全 + 未来地基）        |
| ③   | 事后检查器 `PostFlightChecker` | 无（按工具作用域） | 中   | 中高                             |
| ②   | 工作记忆 `WorkingMemory`       | ③ 更完整           | 大   | 思想级，最后、分阶段             |

**关键认知**：①③② 的顺序是「先铺类型/证据管道，再上重的状态机」。② 是地基，但 ①③ 不依赖它也能先落地（① 默认 E 零回归；③ 按「工具后置条件」作用域，不依赖 goal 状态机）。

---

## 二、④ Anchor 契约 — eval 门细粒度化（先落地）

**现状**（`eval-harness.ts:99 runEval`）：约 33 条冻结契约混在一起，`score = passed/total*100`（`:262`）。门是 `runCrsiModification`（`crsi-modify.ts:104-112`）里的「总分数不退化」（`rewardFn.evaluate()` → `report.score < last` 即拒）。粗粒度问题：**一个 patch 可能「修 A 破 B」——总分涨（B 的缺口补上），但 A 这条当前已通过的契约被打破，粗闸看不出来。**

**目标**：把「当前机制已经能解的 anchor」和「应该新补的 target 缺口」分开，门 = ① 修 target（FAIL→PASS）且 ② anchor 零回退（PASS→PASS），两者都不退才放行。

**最小改动**（3 处）：

1. `EvalResult`（`eval-harness.ts:29`）加 `role?: 'anchor' | 'target' | 'neutral'`（默认 `neutral`）。
2. 给现有契约打标签——**anchor**（当前机制必过，绝不许回退）：`rule-timeout`、`rule-git-force`、`rule-disabled-skip`、`constitution-8-principles`、`constitution-facets`、`constitution-preamble`、`sandbox-protected-constitution`、`sandbox-protected-tests`、`sandbox-protected-machinery`、`protection-completeness`、`blast-radius-gate`、`red-team-zero-gaps`、`producer-rule-shape`、`producer-rule-idempotent`；**target**（缺口/覆盖，应被补）：`gap-rm-rf` ~ `gap-crontab-r` 8 条 + 行为任务集；其余 `neutral`。
3. 新增纯函数 `regressedAnchors(results): string[]`——返回 `role==='anchor' && !passed` 的 id 列表；空 = 无回退。

**接线**：`runCrsiModification` 的 gate 在「分数不退化」之前加一道：`regressedAnchors(report.results ?? [])` 非空 → 拒。`ScoreReport`（`reward-fn.ts:9`）加可选 `results?: EvalResult[]`（`runEval` 返回的 `EvalReport` 是其结构化超集，机制哨兵天然带 `results`；任务表现 reward 无 `results` → anchor 检查自动跳过，符合「任务表现尚无 anchor 概念」）。

**接口**：

```ts
// eval-harness.ts
export type ContractRole = 'anchor' | 'target' | 'neutral'
export interface EvalResult {
  /* 现有 */ role?: ContractRole
}
export function regressedAnchors(results: EvalResult[]): string[]

// reward-fn.ts
export interface ScoreReport {
  /* 现有 */ results?: EvalResult[]
}
```

**测试计划**（TDD）：① `regressedAnchors` 单测（anchor 翻 FAIL 返回该 id / 全绿返回空 / target 翻 FAIL 不算）；② eval 契约 `anchor-gate`（冻结「所有 anchor 契约当前必须全绿」，total 33→34）；③ `crsi-modify` 门测试（注入自定义 rewardFn，含 failed anchor，断言 `Anchor regression` 拒绝，即使 score 未退）。

**代价**：近零。风险是「标签错分」——用 `anchor-gate` 契约锁当前 anchor 全绿自检。

---

## 三、① 组件归因 — `CrsiSignal.component` 字段

**现状**（`crsi-producer.ts:24`）：`CrsiSignal = {category, title, severity?, suggestion, evidence[]}`，`category` 是自由字符串（`auto-memory.ts:309` 只有 `'timeout'`/`'tool-params'` 两类 autoApplicable）。**没有「这次失败该改哪个记忆组件」的结构化归因。**

**目标**：给信号加组件标签，对齐 Recuris 的 `z ∈ {E, W, ρ, C}`。**诚实标注：这是「修复决策」而非「因果断言」**（Recuris 原文明确区分）。

**最小改动**（向后兼容的枚举 + 默认值）：

```ts
// crsi-producer.ts
export type MemoryComponent = 'experiential' | 'working' | 'invocation' | 'checker'
export interface CrsiSignal {
  category: string
  title: string
  severity?: string
  suggestion: string
  evidence: string[]
  /** 修复决策：该失败最可能被哪个记忆组件的局部干预修复。缺省 experiential（现状 = 教训/技能/受管理规则，全属 E）。 */
  component?: MemoryComponent
}
```

**归因来源（分层，不一步到位）**：

- **现在**：所有 producer（`produceCrsiProposal`/`produceRuleProposal`/`produceProseProposal`/`produceCrossoverProposal`）默认 `component: 'experiential'`，**零行为变化**。
- **③ 落地后**：PostFlightChecker 的 `rejected` 决策 → 产 `component: 'checker'` 的信号。
- **② 落地后**：工作记忆状态缺口（goal 遗漏/误标 done）→ `component: 'working'`；ρ 调用时机错（漏调/迟调/无关调）→ `component: 'invocation'`。

**接线**：`selectCrsiSignal`（`:39`）透传 `component`；`buildLessonContent`（`:70`）在教训 markdown 多一行 `- 组件: ...`（可读、可召回）。`renderManagedRuleSource`（`:190`）保持只处理 `experiential`（timeout/tool-params 本就是 E），加 `component !== 'experiential'` 时返回 null 的 guard。

**测试计划**：eval 契约 `producer-component-tag`——冻结「所有 producer 产出 signal 的 `component` 落在四值枚举内、缺省为 `experiential`」。

**代价**：低。风险是枚举名歧义——用 Recuris 原文语义名（experiential/working/invocation/checker），不缩写成 E/W/ρ/C 以免可读性下降。

---

## 四、③ 事后检查器 — `PostFlightChecker`

**现状**：`PreFlightChecker`（`preflight-checker.ts:63`）是**事前**拦截（ErrorSignatureDB + RuleEngine，action allow/warn/fix/block）。`bash.ts` 的 `detectViolations` 是**事后**但只覆盖 Bash 沙箱违规（exit-0 + stderr）。**没有通用的「观察是否支撑状态变更」的事后验证层。**

**目标**：落地 Recuris 核心原则——**「调用技能/尝试工具 ≠ 完成证据；只有工具/env 的观察结果支撑才算」**。把检查器抽象成「完成谓词 `(observation) => boolean`」，事后对工具结果验证，并把决策写进会话轨迹（供 ① 归因 + eval 打分）。

**最小改动**（新模块，不碰现有 PreFlightChecker）：

```ts
// apps/cli/src/core/post-flight-checker.ts
export type CheckerDecision =
  | { verdict: 'supported'; checkerId: string }
  | { verdict: 'rejected'; checkerId: string; reason: string }
  | { verdict: 'no-checker' }

/** 完成谓词：工具/env 观察是否支撑「该变更已生效」。绝不信任模型自称成功。 */
export type Checker = (observation: unknown) => boolean

export class PostFlightChecker {
  register(checkerId: string, toolName: string, predicate: Checker): void
  /** 事后核对一次工具结果。无匹配 checker 时返回 no-checker（不阻塞）。 */
  check(toolName: string, observation: unknown): CheckerDecision
}
```

**首批 checker（最小、确定性、可测）**：

- `write-exists`：`Write` → 谓词 = 文件存在且长度一致。
- `edit-applied`：`Edit` → 谓词 = 工具返回 applied 且 new_string 已生效（可退化为「无 old_string 残留」）。
- `bash-exit`：`Bash` → 谓词 = exit code 0（对齐 `detectViolations` 语义，不重复实现）。

**接线**：工具执行后（`engine.ts` 工具结果落点，读确认行号）调 `postFlight.check(toolName, result)`，`CheckerDecision` 追加进 `session-log`（`core/session-log.ts`，M1 append-only JSONL）。**默认 `no-checker` 静默、`rejected` 只记录不阻塞**（第一阶段只产证据，不做强制拦截——对齐「受约束、最小干预」）。

**与 ① 的闭环**：`rejected` 决策累积到 AutoMemoryEngine → 产 `component: 'checker'` 信号 → producer 能修检查器本身（对应 Recuris「false-pending / false-completion 可归因到 C」）。

**测试计划**：TDD 先写 `post-flight-checker.test.ts`——① `write-exists` 对「存在且长度一致」supported、对「不存在」rejected；② 未注册工具 no-checker；③ `rejected` 决策写入 session-log（字节级可逆，对齐 M1 不变量）。eval 契约 `postflight-bash-exit`：冻结「exit 0 判 supported、exit 非 0 判 rejected」。

**代价**：中。风险是「谓词误判」（尤其 `edit-applied`）。缓解：首批只上 3 个高置信谓词，`rejected` 只记录不拦截（误判只污染证据、不阻断执行）。

---

## 五、② 工作记忆 — `WorkingMemory` 检索接口

**现状**：`MemoryManager.recall(context, limit)`（`memory-manager.ts:115`）→ `tfidf.ts` 的 TF-IDF 余弦，对**已存记忆**做语义匹配。**检索输入是「当前说了什么」，不是「任务还剩什么没做」**——历史越长越难捞出当前一步需要的经验。这正是 Recuris 用 W 解决的：「该取什么」绑定到「已验证的任务进度（pending/done/blocked）」。

**目标**：加紧凑「工作状态」作为召回前置信号，让 `recall` 从「语义相似」升级到「状态接地 + 语义相似」。**不重复造 goal 状态机——复用现有任务追踪。**

**最小改动**（新模块 + 一处召回接线）：

```ts
// apps/cli/src/core/working-memory.ts
export type GoalStatus = 'pending' | 'done' | 'blocked'
export interface GoalState {
  id: string
  content: string
  status: GoalStatus
  evidence: string[]
}

export class WorkingMemory {
  /** 紧凑序列化：把当前任务进度渲染成检索/系统提示用的块。 */
  renderWorkingState(): string
  // 形如：
  // [WORKING] pending: install deps, write test
  // [WORKING] done: read eval-harness
  // [WORKING] blocked: (none)
}
```

**状态源（决策点，建议复用）**：CLI 内已有任务追踪（Task 工具 + `ui/goal-progress.tsx` + `task-performance`）。**推荐**：`WorkingMemory` 读现有 task 列表（pending/done 已存在），不新建第二套状态。**备选**：若现有 TaskList 无 `blocked` 态，仅映射 `pending/done`，`blocked` 预留。

**接线（最小）**：`MemoryManager.recall` 的调用方（`memory-manager.ts:197` 的 `relevant`）召回时把 `renderWorkingState()` 拼进 query 作加权 grounding 项（或用 tfidf 对 `renderWorkingState()` 单独召回 pending 相关记忆）。**这一步就实现「状态接地」，不动 tfidf 算法本身。**

**与 ③ 的闭环**：`done` 只能由 `PostFlightChecker` 的 `supported` 决策推进（证据接地，非模型自称）；`blocked` 由 `rejected` 决策置位。**复现 Recuris「w_t → ρ → E_t → (a,o) → C → w\_{t+1}」环。**

**测试计划**：`working-memory.test.ts`——① `renderWorkingState()` 输出紧凑块、含三态；② `done` 只在 `checker supported` 时推进（`rejected` 状态不变）；③ 空状态渲染空块。eval 契约 `working-memory-evidence-gated`：冻结「状态推进必须过 checker，模型自称不算」。

**代价**：**大**。唯一需要动运行时语义的件。**建议拆两阶段**：Phase 1 只做「读 task 列表 → 渲染 → 拼进 recall」纯只读接线（不推进状态、不改 tfidf），先看「状态接地召回」效果；Phase 2 再接 ③ 的 evidence-gated 状态推进。**若 Phase 1 无收益，可停，不空转**（对齐「目标驱动执行」）。

---

## 六、一句话总结

| 件               | 一句话                                                      | 风险           |
| ---------------- | ----------------------------------------------------------- | -------------- |
| ④ anchor         | 门从「总分不退」细化为「anchor 零回退 + target 补齐」       | 近零           |
| ① component      | 信号加 `component` 枚举（默认 E），失败可归因到单一记忆组件 | 低             |
| ③ post-flight    | 事后验证「观察支撑变更」，决策入 trace，供归因              | 中             |
| ② working-memory | 用「已验证任务进度」接地召回，复用 task 列表                | 大（分两阶段） |
