# 设计：CRSI 评估治理三件（oracle 臂 + sealed 池 + probation 观察窗）

> **日期**：2026-11-20
> **主题**：给 CRSI 的「验证」补上界、留出集与上线后可追回
> **状态**：设计已定，待实现
> **外部参照**：Agnes Harness（`AgnesAI-Labs/agnes-harness`）的 `tools/rsi-eval` 三臂对照与
> `Agnes-Harness-Technical-Report-Nov-2026` 的 governed RSI —— **只借形状，不借实现**（它是
> Python/密封仿真，我们是 TypeScript/真实仓库）

---

## 一、问题

`/crsi modify` 已经有四道闸（blast radius → 测试 → anchor 零回退 → 方向性 regret），
`improvement-track` 也已有噪声自适应 `minEffect` 与 Wilson 改进率。缺的是三样东西：

| 缺什么     | 今天会怎样                                             | 证据                                            |
| ---------- | ------------------------------------------------------ | ----------------------------------------------- |
| **上界**   | 只知道「比上次好」，不知道「好到了手写答案的百分之几」 | `eval-harness.ts` 只有 `score`，无 oracle 臂    |
| **留出集** | 反复拿同一批题筛候选，闸门读数会被选择偏置抬高         | 任务电池仅 6 题，全部可见于选择路径             |
| **观察窗** | `approvePending()` 是终态，合并后变坏只能靠人事后发现  | `crsi-modify.ts:240`；仓库内 `probation` 零命中 |

**一条必须先说清的盘面事实**：`task-performance-tasks.json` 共 **6 题**，其中带 `skill`
标签的只有 **1 题**（`safe-coding`），而 `runTaskPerformance` 是**按 skill 名过滤取题**的
（`task-performance.ts:163`）。也就是说今天算出来的「某 skill 的 before/after」是 **n=1**
的读数 —— AGH 那条捕获率公式在我们这里**没有分母**。

## 二、目标与非目标

**目标**

1. 任务电池可按 `gate` / `sealed` 分池，sealed **永不进入候选选择路径**。
2. 电池每题带一份 `oracleCode`（手写参考解），据此计算**捕获率**：
   `(on − off) / (100 − off)`，并给出按任务重采样的 95% 区间。
3. `/crsi modify --approve` 合并后开启**试用期**；后续电池重测达 N 次时出裁定；
   判为退化时**只打印 `git revert <sha>`，不自动执行**。

**非目标**

- 不引入 TTT / 权重适配（另案；见「未采纳」）。
- 不改 40 条机制契约电池，也不改它的 `MIN_CONTRACT_COUNT`。
- 不读遥测、不新增对外上报。
- 不做自动 revert —— 破坏性 git 操作仍由人执行。

**反目标（即便技术上跑通也算失败）**

- 捕获率在没有 headroom 的题上照样出数（分母注水）。
- sealed 池以任何形式影响候选是否被接受。
- probation 用低置信读数触发一次不可逆的回退提示。
- 把模型的自评分 / 置信度直接当阈值。Sys1 报告明说它输出的是
  **"relative probabilities over the candidate set"**，而
  **"whether they correspond to empirical correctness rates must be tested
  through calibration evaluation"** —— 未过校准的分数只能当**排序**用，不能当**门槛**用。
- 把基础设施故障记成候选变差（见 §4.6）。

## 三、已选路线

对话中已在三条岔口上选定：**①A 扩题库 + ②A 任务级 sealed + ③B 报警并给出回退命令**。
另两条被否：契约级 sealed（防的是"改坏代码"，不是选择偏置）、自动 revert（与
"破坏性 git 要问"冲突，且我们的读数来源只有电池重测，信号弱）。

## 四、设计

### 4.1 数据形状

`PerformanceTask`（`task-performance.ts:13`）新增两个字段：

```ts
interface PerformanceTask {
  // …既有字段不变
  /** 手写参考解。必须能通过本任务自己的 testCode —— 由 integrity 守卫逐题验证。 */
  oracleCode: string
  /** 分池。缺省 'gate'；'sealed' 只在审批/重测路径出现。 */
  split?: 'gate' | 'sealed'
}
```

**为什么是"参考解"而不是 AGH 的"手写经验"**：我们的度量是分数（冻结测试），不是成本。
参考解把上界定死为 100，分母因此是**确定量** `100 − off`，不掺入"手写经验本身好不好"
这个未测量的变量。代价是它衡量的是「捕获了满分的百分之几」，不是「捕获了最优经验的
百分之几」—— 这一点在报告里要写明，不得混称。

**题库规模**：3 组 × 5 题 = **15 题**

| 组            | 题数 | gate | sealed | 角色                                        |
| ------------- | :--: | :--: | :----: | ------------------------------------------- |
| `safe-coding` |  5   |  4   |   1    | 被测组（既有 1 题 + 新增 4）                |
| `tdd`         |  5   |  4   |   1    | 被测组（新增）                              |
| 无标签        |  5   |  4   |   1    | **空对照**：`on ≡ off` ⇒ 捕获率**必须是 0** |

每组 1 题 sealed 是下限：少于 1 题则 sealed 无内容，报告须明说而非静默跳过。

无标签组不是"死重"：它是**量具的正对照**。同一份 skill 文本注入与不注入是同一个东西时，
捕获率若不为 0，说明 `capture-rate` 的分子分母算错了 —— 这是这套仪器唯一能自我证伪的地方。

### 4.2 捕获率（新模块 `core/capture-rate.ts`）

**先解耦**：今天 `runTaskPerformance` 用**同一个参数**同时决定"跑哪些题"和"注入什么文本"
（`task-performance.ts:162-163`），所以 `off` 臂对 `safe-coding` 组根本表达不出来。改为：

```ts
runTaskPerformance(llm, {
  tasks: PerformanceTask[],        // 选择：由调用方给定（新）
  skillText?: string,              // 注入：与选择无关（新）
})
// 旧签名 { skill: { name, text } } 保留为薄包装，行为不变（既有调用点零改动）
```

```
off    = 组内 gate 题，不注入任何文本
on     = 同一批题，注入被测 skill 文本
oracle = 本题 oracleCode 直接判定（零 LLM 调用）
```

- **oracle 臂不需要生成**：`judgeGeneratedCode(task.testCode, task.oracleCode)` 直接跑。
  它必须 100 分；若不满分，是**题或参考解坏了**，捕获率整轮作废（fail-closed）。
- **每题每臂的取值** = 该题在 k 次（**非截断**）生成中的通过率，0–100。
  截断的生成**丢弃、不记 0**；某题在任一臂上非截断样本为 0 ⇒ **两臂同时**剔除该题
  （配对剔除）。报告里的 `N of M` 指「有 headroom **且**两臂配对完整」的题数。
- 每题 headroom `h = 100 − off`。`h <= 0` 记为 **no headroom**，从分子分母剔除并计数。
- `capture = Σ(on − off) / Σ(100 − off)`，只在有 headroom 的题上求和。
- 区间：**按任务重采样**（1,000 次，固定种子），每次重采样内重新判定 headroom。
- **没有题剩下 ⇒ 没有率**，打印 `no headroom`，**不得**当作 0 或 1，也不得当作"通过"。
- 报告必须写成 `rate = 分子/分母 over N of M tasks; 95% CI a–b`，永不输出裸数字。
- **正对照必跑**：无标签组 `on ≡ off` ⇒ 捕获率必须为 0；不为 0 时整轮作废。

### 4.3 sealed 池

- `loadPerformanceTasks()` 增加可选 `pool: 'gate' | 'sealed'`，**缺省 `'gate'`** ——
  所有既有的选择/改进路径因此天然只看到 gate，无需逐处修改。
- sealed 只出现在 **两处读数**：`/crsi bench --sealed` 与 `--capture` 报告里的并排列。
  **sealed 永不进入任何裁定**（不进 `/crsi modify` 的闸，不进 probation 的 verdict）——
  它只是「gate 上的捕获率会不会是过拟合」的旁证。
- 判读规则写死在报告里：`capture(sealed)` 显著低于 `capture(gate)` ⇒ 该 skill 在 gate 题上过拟合。
- **守卫**（可失败）：
  - `test/integrity/task-battery.test.ts`：每题 `oracleCode` 必须过自己的 `testCode`；
    每题必须声明 `split`；sealed 题数 ≥1 且 ≤ 组内 1/3。
  - `test/core/capture-rate.test.ts`：gate 池**不得**含任何 sealed id（两向列举比对）。

### 4.4 试用期（新模块 `core/probation.ts`）

**只对"有一次任务表现测量"的合并开启** —— 因为随机（LLM）信号只在那条路径上存在。
其余合并（如 `core/*.ts`）**不开 probation**，`/crsi stats` 明确打一行
`no stochastic instrument for this merge`，而不是静默跳过。

```ts
interface ProbationRecord {
  id: string
  filePath: string
  skillName: string
  commitHash: string // sandbox.merge() 已有的 commitHash（crsi-sandbox.ts:621）
  baselineScores: number[] // 合并时的 k 个 post 臂采样（不是标量）
  checks: number[] // 观察窗内每次同口径重测
  verdict?: ImprovementVerdict
  timestamp: string
}
```

- **基线** = `measureSkillDeltaRepeated` 的 `postScores`（新文本那一臂），不是 `delta`，
  也不是 pre 臂 —— 观察窗问的是「合并后的状态会不会回落」。
  该样本在 `measureModification`（`commands.ts:1108`）里**当前被丢弃**；改为随
  `pendingSandbox` 一起存进 `crsi-modify` 的模块级 `pendingProbation`（生命周期与
  `pendingSandbox` 完全一致：同进程、approve 时消费）。
- **口径必须同池**：`checks` 与 `baselineScores` 都来自**同一 skill 组的 gate 池**。
  sealed 不参与（见 §4.3）。
- **窗口 N = 3 次合格重测**（不是 200 任务）。合格 = 同一 skill、同一 gate 池、`k ≥ 3`；
  `k=1` 冒烟**永不**计入。
- 判据：`noise = max(stdDev(baselineScores), stdDev(checks))`；
  **`minEffect = max(2 × (100 / poolSize), 2 × noise)`** —— 4 题池即 50 分。
  这不是另造口径，而是给 `computeMinEffect` 加一个 floor 参数：
  现有 `MIN_EFFECT_FLOOR = 20` 保持不变，probation 传自己的 floor。
  **理由**：一个 4 题池上单题翻转 = 25 分，若按 20 分地板判退化，正落在
  §二「低置信读数触发回退提示」的反目标上；两题翻转（50）才判，是可解释的下限。
- 落盘 `~/.mipham/crsi/probation.jsonl`，与 `improvements.jsonl` / `eval-scores.jsonl` 同族。
- 触发点：`approvePending()` 成功 → `openProbation`；`/crsi bench`（合格口径）→
  `settleProbation`；`/crsi stats` 显示未结试用期与 `verdict`。
- **裁定为 `regressed` 时**：打印 `git revert <commitHash>` 与两侧读数，**不执行**。
- 窗口未满时 `verdict` **缺席**（不是 `inconclusive`）——「还没到能判的时候」与
  「判了但判不出」必须不同形，与 `improvement-track` 的三态一致。

### 4.5 成本边界

- 一次完整捕获测量 ≈ **k × 15 次生成**（oracle 臂零生成）：`off`/`on` 各跑 12 道 gate 题。
- `k` 默认 3 仅用于 `/crsi bench --capture`；`k=1` 只用于冒烟，报告标注 `k=1` 且**不计入**
  任何 verdict / probation。
- 捕获测量的 token 由既有 `runTaskPerformance.tokensUsed` 求和后**打印**；
  **不写** `improvements.jsonl`，因此 `measurementTaxSummary`（只聚合该文件）**不适用** ——
  这是刻意的：捕获率是读数，不是改进记录，混进台账会让 `improvementRate` 的分母变味。

### 4.6 基础设施故障 ≠ 答错（捕获率成立的前提）

**问题**：`runTaskPerformance` 现在把"没生成代码"一律记 `passed: false`
（`task-performance.ts:176-184`）。一次 provider 抽风就会让 `off` 臂凭空掉分 ——
分母被污染，捕获率是假的；同样地，`improvement-track` 会把一次网络故障判成"候选退化"。

**判据**（复用既有的"没报 ≠ 报了 0"语义，`task-performance.ts:145-150`）：

| 观测                 | 记作                | 是否进分数                 |
| -------------------- | ------------------- | -------------------------- |
| 有文本，判定失败     | `fail`              | 进（模型确实答错）         |
| 有 usage、零文本     | `fail`              | 进（模型作答失败，要记账） |
| **无 usage、零文本** | **`uncertain`**     | **不进**（仪器/上游故障）  |
| 生成被截断           | `truncated`（既有） | 不进（既有）               |

- `uncertain` 与 `truncated` 同族但**不同名**：前者是"没测到"，后者是"没做完"。
  两者都不进 `score`，但报告要分开计数 —— 合成一个数字会让"上游挂了"和"输出上限太短"
  在读数上同形。
- 捕获率里，`uncertain` 的采样按 §4.2 的**配对剔除**处理，不算 0。
- 这一条是 §4.2 的前提：**分母可信，捕获率才可信**。

### 4.7 删除教训的墓碑（守卫测试）

Harness 报告 Limitations 第 3 条自曝：一条 live-note 被折进压缩摘要之后，
**删掉源文件不会在摘要上留下 CLEARED 墓碑**，摘要里那份会继续生效。

我们同构：教训/规则被删之后，含它的历史摘要仍在上下文里。**本轮只加一条守卫测试**：

> 写入一条规则 → 触发压缩 → 删除该规则 → 断言**下一次**注入的规则集里不含它，
> 且压缩摘要不得被当作规则的来源。

不做主动墓碑机制（那是 producer/context 层的改动，属下一批）。

### 4.8 模型自带分数的用法边界

任何把模型自评分当门槛的地方，必须先有校准读数；没有校准的时候，分数
**只能排序、不能定阈值**。本轮不新增这样的门槛，此条写给将来的实现者。

## 五、风险

| 风险                             | 处置                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 题太容易（off=100）⇒ 无 headroom | 守卫报告每组有 headroom 的题数；某组 <2 题时该组捕获率不出数                                                 |
| 15 题 + 参考解是内容工程，易写错 | `oracleCode` 过自己测试由守卫逐题机械验证；写错即红                                                          |
| sealed 泄漏进选择路径            | `loadPerformanceTasks` 缺省 `'gate'`；两向列举守卫                                                           |
| probation 读数太稀               | 窗口只认"电池重测"，不认遥测；未满即缺席，不猜                                                               |
| 新增测试使 `TEST_COUNT` 漂移     | 同批回填 `shared/package-info.ts` 的 `TEST_COUNT` 与 `CLAUDE.md` 三处写法（`published-counts.test.ts` 守着） |

## 六、落地顺序（每步自带验证点）

1. **`uncertain` 三态**（§4.6）：先改 `runTaskPerformance` 的记录形状 + 单测。
   它是捕获率的地基，必须最先落地；既有调用点行为**不变**（`uncertain` 只是不进分数）。
2. **电池扩容 + oracleCode**（纯数据 + 守卫）：`pnpm test test/integrity/task-battery.test.ts` 绿。
3. **sealed 池**：`loadPerformanceTasks({pool})` + 守卫；既有调用点行为不变（缺省 gate）。
4. **capture-rate 模块**：纯函数 + 重采样单测；不接线前即可测（喂合成数组）。
5. **接线 `/crsi bench --capture`**：真跑一次 `k=1` 冒烟，报告打印 `over N of M tasks`。
6. **probation 模块**：`open/settle/verdict` 单测（注入假时钟，不跑真实 git）。
7. **接线 approve/stats**：`merge()` 补 `commitHash` 返回；`/crsi stats` 显示未结试用期。
8. **压缩墓碑守卫**（§4.7）：一条测试，钉住"删掉的规则不得经由摘要复活"。
9. **回填计数与文档**。

## 七、未采纳（留作回访）

- **TTT**：需权重可见 + 可反传 + 请求内改参数；我们主路径是 chat-completions 接口。
  Sys1 技术报告本身也**没有任何 TTT 实验结果**，只有评测计划。
- **自动 revert**：见 §三。
- **契约级 sealed**：见 §三。
- **三验固化 + 自动撤销**（AGH §7.3）：同一值在 3 次已验证任务里一致才固化；源标签被推翻
  或模式变更则撤回。对 `crsi-producer` 直接可用，但它改的是 **producer 语义**（一条教训
  何时有资格成为受管理规则），不是评估体系 —— 与本批的 diff 方向不同，单独立项。
- **快照钉版**（AGH 不变量 5）：运行中任务保持启动时的 Playbook digest。我们是逐轮从文件
  注入规则，会话中途改规则会立刻生效。钉不钉是**产品决定**，先记录现象，不改行为。
- **Ledger / 一次性 permit / 九道必选缝**：那是"物理设备 + 多面客户端"的运维内核；
  我们的对应物是权限层与 CrsiSandbox。硬搬会把 CLI 撑成 daemon。
- **200 任务试用期**：我们没有 200 任务的流水，以电池重测替代（§4.4）。

## 八、留给实现者的决定

- 15 题的具体题目与参考解（按组各 5，须覆盖 test-driven 与 bug-fix 两类）。
- 重采样种子固定方式（次数已定 1,000）。
- `PROBATION_FLOOR` 是否随 `poolSize` 之外再引入最小样本数（如 `checks.length < 2` 时即便
  窗口未满也先出一次中间读数）—— 倾向不引入，保持"未满即缺席"。

## 九、边界（不是缺陷，是范围）

- **非 skill 合并没有 probation**：没有随机信号可用。要覆盖它们，需要一条"每次合并都跑
  电池"的臂（成本与延迟都落在 `/crsi modify` 的主路径上），本轮不做。
- **sealed 只有 1 题/组**：它的用途是"gate 捕获率会不会是过拟合"的旁证，不是稳定的第二读数；
  想让它出区间，得先把 sealed 扩到每组 ≥3 题。
