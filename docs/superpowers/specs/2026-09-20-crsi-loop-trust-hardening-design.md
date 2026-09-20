# CRSI 闭环可信度加固 — 设计规格

> **日期**: 2026-09-20
> **范围**: `apps/cli`（CRSI 自改进闭环）
> **来源**: `CosmosMind-ai/RSI-Harness`（MetaRSI-v1, arXiv 2609.06396）外部评审后的三条可借鉴点
> **状态**: 待实施

---

## 一、背景

对 RSI-Harness 的评审产出六条可借鉴点，本批取其中三条。取这三条的共同理由是**同一个缺陷形状**：一处**手写镜像**配**单向断言**，且**没有任何东西证明该断言能失败**。仓内已八次栽在这上面（见记忆 `checks-that-cannot-fail`）。

三处的具体形状：

| #   | 手写镜像                          | 今天的断言                                        | 缺的东西                                |
| --- | --------------------------------- | ------------------------------------------------- | --------------------------------------- |
| 1   | 无（producer 只有事后判定）       | `improvement-track` 的 `minEffect` 只在**事后**算 | 事前写下预期，事后才能判「预测准不准」  |
| 2   | 无（脚手架无任何预算）            | 无                                                | 自改进不得无限抬高脚手架成本的约束      |
| 3   | `ANCHOR_CONTRACT_IDS`（15 个 id） | 无                                                | 表里的 id 是否真的解析成 anchor，零校验 |

第 3 项的缺陷已实测确认：`ANCHOR_CONTRACT_IDS` 全仓库只有两处引用 —— 定义（`eval-harness.ts:58`）与回填（`:354`）。把 `'blast-radius-gate'` 敲成 `'blast-radius-gates'`，那张契约仍会跑、仍会 FAIL，但**不再是 anchor**，`regressedAnchors` 对它视而不见 ⇒ 一处安全不变量被静默降级为普通契约，全套测试与 CI 依旧全绿。

### 非目标

本批**不**处理评审报告里其余三条（失败签名分片评测、「无证据的字段留空」升为通用规则、自洽目录作为唯一可分发形态）。也**不**修 config 面上已确认的三处未接线（`features.mcp.oauthEnabled` 零读者、`setCrsiConfig` 零调用点、`loadBackgroundAgentConfig` 零调用者）—— 第 3 项原本的落点曾考虑 config 键，因守卫一落地就会在这三处变红、须连带处置而改打 anchor。

---

## 二、横切不变量（三节共同遵守）

1. **每道新闸必须配负控**，且各负控的「红集」**两两不同** —— 红集是集合，判据是它们互不相等（N3 是唯一一处：一次扰动在真值表与命中率两处可观测，如实记为 2 条红，不为此把测试挪走）。仅声明「测试通过」不算验证。
2. **不新增写死常数**。ε 不含阈值常数；B_H 不含上界常数。
3. **不动现有闸门语义**。`shouldBlockApproval`、anchor 回归闸、`getLastEvalScore` rewards 闸一律不改。

---

## 三、§1 ε 预登记与预测命中

### 3.1 目标

让循环**可以出错**。今天 producer 无论产出什么，唯一的检查是「eval 分数不退化」，而机制评分器已饱和在 **38/38** —— 该检查永远不会开火。ε 建立本循环第一个**能被证伪的量**。

### 3.2 类型面

`apps/cli/src/core/crsi-modify.ts:21-39` `CrsiProposal` 增加两个可选字段：

```ts
  /** ε：提交者事前写下的预期效果（任务表现提升点数）。缺席 = 不预测。 */
  expectedEffect?: number
  /** R：风险声明（改动可能在哪方面变差）。缺席 = 未声明。 */
  risk?: string
```

`apps/cli/src/core/crsi-producer.ts:381-386` `ProseProposalResult` 同步增加这两个可选字段。`produceCrsiProposal` / `produceRuleProposal` / `produceCrossoverProposal` 的返回**不**增加 —— 见 3.5。

### 3.3 ε 从哪来（prose 一条路径）

`generateProseContent`（`crsi-producer.ts:369-379`）今天返回**裸 markdown 正文**（经 `stripMarkdownFence` 处理），不是 JSON。改法：

- `PROSE_GENERATE_PROMPT_VERSION` `'1.0.0'` → `'1.1.0'`（`crsi-producer.ts:339`）。
- prompt 要求模型**先声明意图、再给内容**：响应第一行为一行 JSON `{"expectedDelta": <number>, "risk": "<string>"}`，其后为 skill 正文。
- 解析（**顺序明确，两种情况互不混淆**）：
  1. 对**原始响应**做 `trim()`，取第一条非空行。若该行是 ` ```json ` 或 ` ``` ` 围栏，跳过它再取下一行。
  2. 对该行尝试 `JSON.parse`：成功**且**结果是非 null 对象**且** `expectedDelta` 是 number ⇒ 该行是 ε，**从正文中剥除**（连同其后的空行），余下部分照今天的路径走 `stripMarkdownFence`。
  3. 其余任何情况（首行不是 JSON、`parse` 抛错、结果是数组/标量、`expectedDelta` 缺失）⇒ **ε 缺席，整份原始响应一字不改地**走 `stripMarkdownFence`，与今天完全同行为。
- 模型可显式写 `"expectedDelta": null` 表示「无法预测」，与缺字段同义（仍剥除该行，只是不产生 `predictedDelta`）。

**为什么一行前缀而不是把正文改成 JSON**：正文路径（`stripMarkdownFence` → `runCrsiModification` 写盘）保持不变，改动面只有「首行嗅探 + 剥除」；且缺前缀时行为与今天完全一致。

**为什么不用第二次 LLM 调用**：预登记的意义是「在改动成形前写下预期」。第二次调用会看到已写好的正文，退化成从 diff 反推一个像样的数字 —— 那是 postdiction，不是 prior。

### 3.4 判定

新增纯函数于 `apps/cli/src/core/improvement-track.ts`：

```ts
/** 预测命中：事前写下的点数被实际达到。缺席预测不计入。 */
export function predictionHit(predicted: number | undefined, deltaMean: number): boolean {
  return predicted !== undefined && deltaMean >= predicted
}
```

**不叠加 `minEffect`**。ε 是提交者自己写下的数，判据就是「达到没达到」；再套一层统计阈值会让两个数打架，且使「命中」不可复算。

### 3.5 接通（本项唯一的行为变更）

今天 `measureSkillDeltaRepeated` 全仓库**只有一个调用点**：`commands.ts:871`，位于 `crsiModifyCmd` 的**手工路径**（`/crsi modify <desc> <file> <content>`，参数由人敲入）。四条 producer 路径（`962` prose / `1005` rule / `1037` crossover / `1065` lessons）调完 `runCrsiModification` 就返回，**全都不测量**。`buildImprovementReport` 同样只有 `873` 一个调用点。

⇒ 若只在 producer 侧加 ε 字段，ε 登记在 A 流程、判定在 B 流程，**两端永不相遇**。

改法：在 `commands.ts:962` 那次 `runCrsiModification` 成功之后，照 `867-875` 的形状接上测量：

```
sample = await measureSkillDeltaRepeated(llm, { filePath, originalContent, newContent })
if (sample):
  report = buildImprovementReport(sample, [filePath], proposal.expectedEffect)
  setPendingVerdict(report.verdict)
  appendImprovement({ ...report, id, timestamp })
```

`buildImprovementReport` 增加第三个可选参数 `predicted?: number`。

**副作用（须计入）**：prose 路径每次提案多 6 次 LLM 调用（`867` 行注释所述成本），并开始写 `improvements.jsonl` 与 `pending-verdict.json`。后者会参与后续 `/crsi modify --approve` 的拦截 —— 语义一致（producer 路径本来也要人 `--approve`），但这是行为变更，不是纯加字段。

**ε 不进 `pending-verdict.json`**：该文件只服务 `shouldBlockApproval`，而 ε 不是闸（不变量 3）。ε 在 `buildImprovementReport` 的作用域内直接传入。

### 3.6 记账与指标

- `ImprovementReport`（`improvement-track.ts:15-26`）增加 `predictedDelta?: number`、`predictionHit?: boolean`。
- `improvements.jsonl` 每条因此多 2 个字段。旧记录无此字段 ⇒ 读取侧（`readImprovements`）天然兼容，无需迁移。
- 新增 `predictionHitRate(records)`：分母 = **有预测的记录数**，复用既有 `wilsonInterval`。缺席既不计入分子也不计入分母。

### 3.7 作废条款

本机制**允许被判为失效**：

- 样本 < 5 ⇒ 只输出「样本不足」，不下任何结论。
- 记录总数达 **20** 而判定样本仍 < 5 ⇒ `/crsi stats` 明写「ε 机制失效：prose 路径使用率过低」，该结论同时落台账。

### 3.8 诚实边界

ε 只在 **prose 一条路径**上成立，且这是**原理性的**，不是遗漏：

- `produceCrsiProposal`（`buildLessonContent`，`crsi-producer.ts:79-95`）与 `produceRuleProposal`（`renderManagedRuleSource`）是**模板化、无 LLM** 的纯字符串拼装 —— 模板没有「预期效果」这种信念可登记，硬给一个常数就是空预测。
- `produceCrossoverProposal` 的产物是教训文件，而 `measureSkillDeltaRepeated` 量的是 **skill** ⇒ 不可测量。

---

## 四、§2 B_H — 合并型收敛闸

### 4.1 形态（含一次返工）

初版设计为「非增长不变量，对一切提案生效」。**该形态已被证伪**：`produceCrsiProposal`（`crsi-producer.ts:138-167`）产出教训的唯一方式是**追加**（`newContent = currentLessons + '\n\n' + lesson`），而 `buildLessonContent` 首行即 `## ${category}: ${title}`（`:85`）⇒ 每条新信号都是净 +1 段 ⇒ 闸会**禁掉学习路径本身**，`/crsi propose` 从此永久不可用。

**学习这件事本身就是增长。** RSIH 的 B_H 之所以是数值上界而非非增长，正因为它必须允许学到上界、到顶再强制合并（其原话 "merge with dedup + hard complexity bound" —— bound 是数，dedup 才是非增长那一半）。

本仓**已有 dedup 那一半**（path 1 按 `## category: title` 幂等、path 2 按规则 id 幂等）。本批补的是另一半，但以零常数的方式：**闸只在「试图整合」那一刻开火**。

### 4.2 度量

纯函数于 `apps/cli/src/core/crsi-sandbox.ts`（与 `validateBlastRadius` 相邻 —— 二者是同顺序、同位置的 pre-worktree 闸）：

```ts
/** 脚手架三项计数。按 filePath 分派：教训段数 / 规则条数 / 字节数。 */
export function measureScaffold(
  filePath: string,
  content: string,
): { lessons: number; rules: number; bytes: number }
```

分派规则：

| filePath             | 计数                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| `LESSONS_FILE`       | 匹配 `^## ` 的行数 → `lessons`；`rules` = 0                          |
| `MANAGED_RULES_FILE` | `id: '` 出现次数 → `rules`；`lessons` = 0                            |
| 其余（skill 等）     | 无语义单位可用，退到 UTF-8 字节数 → `bytes`；`lessons` = `rules` = 0 |

**为什么教训/规则文件只计语义单位、不计字节**：合并会**重写散文**，字节数随措辞涨落 —— 把字节计入，会让「删二增一」因新写的合并段比原来两段更长而被误拦，即闸会挡掉它本该允许的那件事。skill 文件没有可用的语义单位（其「条数」就是文件本身），才退到字节数。

### 4.3 闸

```ts
/** 合并型提案的收敛闸。返回拒绝理由，合法时返回 null（同 validateBlastRadius 的签名）。 */
export function validateMergeConvergence(proposal: {
  filePath?: string
  originalContent?: string
  newContent?: string
  merge?: boolean
}): string | null
```

判据：`merge === true` 时，`measureScaffold(filePath, newContent)` 的每一项都必须 **≤** `measureScaffold(filePath, originalContent)` 的对应项；否则返回点名是哪一项上升的理由串。

- `merge !== true` ⇒ 返回 `null`（新增型提案不受此闸，幂等仍生效）。
- `originalContent` 为空串或 `undefined` ⇒ 返回 `null`。理由：**无基线不是有增长**。手工路径在文件不存在时正是这个形态（`commands.ts:845-852` 的宽松模式）。

### 4.4 位置

`apps/cli/src/core/crsi-modify.ts` `runCrsiModification` 内，`validateBlastRadius`（`:55-71`）**之后**、`sandbox.createWorktree()`（`:73`）**之前** ⇒ 零副作用。

因为 `originalContent` / `newContent` 都已在 proposal 上，闸是**纯字符串比较，零磁盘 I/O**。

### 4.5 触发面

`CrsiProposal` 增加 `merge?: boolean`。`produceCrossoverProposal`（`crsi-producer.ts:571-611`）置 `merge: true` —— 它本来就有 `titleA`/`titleB`，无需从字符串推断。

---

## 五、§3 anchor 守卫（重版：真两向）

### 5.1 把真源移到契约定义处

RSIH 的做法（`test/pi-surface.test.ts`）是让真源成为**类型声明**、手写清单成为镜像，然后两向比对。移植：

- `apps/cli/src/core/eval-harness.ts` `EvalResult`（`:39-46`）增加可选字段 `anchor?: true`。
- 在 **anchor 契约的 `results.push` 处内联 `anchor: true`**（今天的 15 个取自 `ANCHOR_CONTRACT_IDS`，`:58-74`；连同 §6.1 新增的两条，本批后为 **17 处**）。
- `role` 的回填（`:352-355`）**改为从内联标记派生**：`if (r.anchor) r.role = 'anchor'`。`ANCHOR_CONTRACT_IDS` 保留为**独立声明**，不再作为回填来源。

于是两处独立陈述同一件事 ⇒ 它们可以不一致 ⇒ 守卫才有内容。

### 5.2 守卫

新增 `apps/cli/test/integrity/anchor-contract-wiring.test.ts`（结构对齐 `daemon-capability-parity.test.ts`）：

| 断言                                                   | 抓什么                                          |
| ------------------------------------------------------ | ----------------------------------------------- |
| `声明集 == 内联集`（两向相等，`.sort()` 后 `toEqual`） | 声明了但没内联（含**拼错 id**）／内联了但没声明 |
| `声明集 ⊆ runEval().results 的 id 集`                  | 表中的 id 在产出里根本不存在（拼错或契约被删）  |
| `声明集.size >= 15`                                    | 空转守卫：集合被清空或抽取失效后静默全绿        |
| 负控：`[...声明集, 'blast-radius-gates']` 跑同一判据   | 判据**能失败**                                  |

### 5.3 为什么值得加 15 处内联

只做「声明 → 产出」一向，交付的是**一半**：它抓得到拼错与删除，抓不到**新加的安全契约忘了进表**。红队契约 `red-team-zero-gaps` 当初正是这样加进来的，`blast-radius-gate` 同理。第二向覆盖的正是这条路径。

---

## 六、附带闭环收口

### 6.1 两条新 eval 契约

| id                           | 断言                                                                                           | anchor |
| ---------------------------- | ---------------------------------------------------------------------------------------------- | ------ |
| `merge-convergence-gate`     | 合并型净增被拒、删二增一通过、`merge=false` 净增通过                                           | 是     |
| `prediction-hit-truth-table` | `predictionHit` 的三行真值表：`(50, 20) → false`、`(10, 20) → true`、`(undefined, 20) → false` | 是     |

两条都进 `ANCHOR_CONTRACT_IDS` 与内联标记 ⇒ **新的闸自己也被闸保护**。

契约总数 **38 → 40**；anchor 数 **15 → 17**。

### 6.2 受影响的既有断言

`apps/cli/test/core/eval-harness.test.ts:29-31` 硬写 `total === 38`、`passed === 38`、`score === 100` ⇒ 改为 **40**（`score` 仍为 100，`failures` 仍为空）。

### 6.3 文档回填（同提交内）

按既有硬纪律「改被测数量的提交须同提交内回填活文档数字」：

- `apps/cli/README.md` 与 `CLAUDE.md` 中的测试数（当前 249 文件 / 2891 测试）、anchor 数、契约数。
- `CLAUDE.md` 头部 `最后更新` 行 + 修订历史窗口行（严格遵守 5 行窗口，被挤出行逐字移入 `docs/claude-md-history.md`）。
- 父仓 gitlink 同步与本仓交付分开，不混提交。

---

## 七、验证计划

### 7.1 负控矩阵（各须只红一条）

| #   | 扰动                                                     | 期望                               |
| --- | -------------------------------------------------------- | ---------------------------------- |
| N1  | 从 `ANCHOR_CONTRACT_IDS` 删一个 id（内联仍在）           | §3 守卫红                          |
| N2  | 把某内联 `anchor: true` 去掉（声明仍在）                 | §3 守卫红                          |
| N3  | `predictionHit` 改为 `predicted !== undefined`（不比较） | §1 契约 + `predictionHitRate` 红   |
| N4  | 首行 JSON 不剥除即当正文                                 | §1「正文不含前缀」用例红           |
| N5  | `validateMergeConvergence` 恒返回 `null`                 | §2 契约红                          |
| N6  | `measureScaffold` 的 `^## ` 改为 `^#`                    | §2 契约红（计数变）                |
| N7  | `originalContent` 为空时改为拒绝                         | §2「无基线不拦」用例红             |
| N8  | 撤掉 `merge === true` 判断                               | §2「`merge=false` 净增通过」用例红 |
| N9  | 解析兜底改为「首行无论如何都剥掉」                       | §1「非 JSON 首行不丢内容」用例红   |

N9 针对的是 §3.3 的情况 3 —— 它和 N4 是一对反向：N4 证明**该剥的剥了**，N9 证明**不该剥的没剥**。只做 N4 会漏掉「凡首行皆吃」这种实现。

### 7.2 正控（证明判据不是恒假/恒真）

- 真实 crossover「删二增一」⇒ 通过。
- `predictionHit(10, 20) === true`。
- 合法的 17 条 anchor ⇒ §3 守卫绿。

### 7.3 回归

- `cd apps/cli && pnpm test` 全绿（**必须在本目录跑** —— 从仓库根跑会因 MCP 子进程路径产生 31 个假红）。
- `pnpm typecheck`、`pnpm lint`、`pnpm format`。
- `runEval()` 仍为 100 分（40/40）。

---

## 八、交付切分

三个提交，各自独立可回退，均落在 `apps/cli`：

1. `feat(crsi): ε 预登记与预测命中（prose 路径接通测量）` — §1 + `prediction-hit-truth-table` 契约。
2. `feat(crsi): 合并型提案的脚手架收敛闸 B_H` — §2 + `merge-convergence-gate` 契约。
3. `test(integrity): anchor 契约守卫（真源内联于契约定义处，两向派生）` — §3。

每个提交内同批回填该提交影响的文档数字（§6.3）。

**注意**：三个目标文件 `crsi-producer.ts`、`crsi-modify.ts`、`crsi-sandbox.ts` 均在 `PROTECTED_ROLES.selfImprovement`，`improvement-track.ts`、`eval-harness.ts`、`apps/cli/test/` 在 `PROTECTED_ROLES.evaluator` ⇒ 本批全部**人工编写、人工审阅**，不可由 `/crsi modify` 产出或批准。这是设计正确性的证据，不是障碍。
