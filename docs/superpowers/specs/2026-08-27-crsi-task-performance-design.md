# CRSI 任务表现评估（Task Performance Evaluation）设计

> **日期**: 2026-08-27
> **作者**: Guohua Zhang · One Mipham Corporation
> **术语**: A1 铁律 = 绝不拿 LLM 当裁判（LLM 可作被测试对象，不可作判定方）；任务表现 = AI 在冻结任务上的编码质量（测试过没过）；改进信号 = before/after 的分数 delta
> **前情**: 承接 [[2026-08-19-crsi-behavior-task-suite-design]]（行为任务集第二层 M3 的落地）与 [[2026-08-27-crsi-promotion-gate]]（因果归因 / 最小效应量 / 改进率的地基）

---

## 一、背景与动机

**eval 目前只能证「机制没坏」，不能证「改得更好了」。**

现有 `runEval()` 的 21 契约（13 机制 + 8 行为缺口）全是「机制自检」，分数只反映「CRSI 机制代码是否满足冻结契约」。因为自改进 proposal 碰不到机制代码（`PROTECTED_PATHS` 锁死），所以 `runEval()` 的分数在自改进前后**恒不变**（delta = 0）——「分数不退化」这道闸只能防倒退，不能辨「真改进 vs 碰巧」。

`crsi-lessons.md` 的 `eval-rigor` 教训明确要求：晋升须「因果归因 + 最小效应量 + 误提升预算」。但三者都要一个**随 proposal 变化**的信号。行为任务集 spec（2026-08-19）把「任务表现」（第二层）列为 M3 扩展点，卡在「代码来源」未决。

**本 spec 落地第二层**：造一个随 proposal 变化的任务表现信号，作为「改进率 / 因果归因 / 最小效应量」的地基。

---

## 二、目标与非目标

**目标**：

1. 造一个「任务表现评估器」——用 LLM 生成代码、冻结测试判绿/红，输出随改动变化的分数。
2. 把它接进 `runCrsiModification` 做 before/after，产出「改进 delta」信号。

**非目标**：

- ❌ 用 LLM 当裁判（保持 A1）——判定一律是冻结测试的确定性 pass/fail。
- ❌ 实现「因果归因 / 最小效应量」本身——那是 promotion-gate 的后续，本 spec 只造「信号」。
- ❌ 度量「文字质量」（"这段 prompt 写得好不好"）——LLM 裁判的盲区，不在范围。

---

## 三、核心设计

### 3.1 代码来源：LLM 生成行为（已决策）

第二层测「AI 完成真实任务的质量」。代码由 **LLM 生成**（**温度 0、单次采样**），判定靠冻结测试。这不破 A1——LLM 是**被测试对象**（生成行为），判定是确定性的（测试过没过）。

**已决策的三项**：

1. 代码来源 = LLM 生成行为（真测 AI 行为，非冻结片段）
2. 噪声处理 = 温度 0 + 单次采样（快、近似确定）
3. 任务集 = 人工冻结 5-10 个小任务（自包含、带冻结测试）

### 3.2 模块边界（独立于 runEval）

新增：

- `core/task-performance.ts` —— 评估器：加载任务 → 调 LLM 生成代码 → 冻结测试判定 → 打分
- `core/task-performance-tasks.json` —— 5-10 个冻结任务

修改（M2）：

- `core/crsi-modify.ts` —— 注入 before/after

**不复用 `behavior-tasks.ts`**：本模块依赖 LLM、判定跑子进程，与第一层「确定性、无 LLM」本质不同。`behavior-tasks.ts` 里的 `layer:'performance'` 类型位保留但继续不实现，本模块独立成体。

`runEval()` 保持原样（快、确定、机制哨兵）。任务表现评估是**独立的慢评估**，只在需要度量「改进」时跑。

### 3.3 任务 schema

```jsonc
// task-performance-tasks.json
{
  "version": 1,
  "tasks": [
    {
      "id": "perf-impl-quicksort",
      "category": "test-driven", // test-driven | bug-fix
      "prompt": "实现 quicksort：function quicksort(arr: number[]): number[]",
      "testCode": "import { quicksort } from './solution';\n…", // 冻结测试，统一 import ./solution
    },
  ],
}
```

- `test-driven`（先生成代码）／`bug-fix`（给 bug 代码 + 红测试，修到绿）——首批先做 `test-driven`，`bug-fix` 作后续类别。
- `testCode` 统一 `import './solution'`，与生成代码拼装后跑。

### 3.4 判定机制（关键：安全跑 LLM 生成的不可信代码）

对每个任务：

1. `llm.chat(prompt)` → 拿到生成的代码（字符串）
2. 写 `solution.ts`（生成代码）+ `solution.test.ts`（冻结 testCode）到临时目录
3. **子进程**跑 `bun test solution.test.ts`，带**超时（5s）+ 资源上限 + 无网络**
4. `exit 0` → pass，否则 fail

> ⚠️ **安全**：LLM 生成的代码是**不可信**的，必须进程隔离（子进程 + 超时 + 资源限制）。这对应 `self-eval` 教训「隔离默认 fail-closed」。容器级隔离（Docker/Podman）是后续加固项（OpenRSI 调研已列，先不做）。

### 3.5 LLM 注入（与现有 eval 的本质区别）

入口签名：`runTaskPerformance(llm: Llm): TaskPerformanceReport`，`llm` 来自 Vajra 内核的 `ctx.llm`。

`runEval()` 现在**无 LLM**（全隔离组件）。本模块必须有 LLM，所以必须独立、不能塞进 `runEval()`——这也正是「独立慢评估」的架构理由。

### 3.6 before/after 接线（M2）

`runCrsiModification(proposal, sandbox, llm)` 增加 `llm` 参数：

- worktree 改动后，跑 `baseline = runTaskPerformance(llm, 主仓 skill)` ＋ `post = runTaskPerformance(llm, worktree skill)`
- `delta = post.score - baseline.score` → 「改进信号」，喂给后续因果归因

> M2 的难点是「skill 的旧版/新版注入」——把 skill 散文作为上下文喂给 LLM。M1 先**不做 skill 注入**，只测「当前 AI 编码能力」。

---

## 四、A1 铁律边界

| 角色             | 定义                             | A1 是否禁止                 |
| ---------------- | -------------------------------- | --------------------------- |
| LLM 当裁判       | 用 LLM 判「这个改动/输出好不好」 | ❌ **禁止**（自我指涉腐败） |
| LLM 作被测试对象 | LLM 生成代码，冻结测试确定性判定 | ✅ 允许                     |

判定环节永远用**冻结测试的确定性 pass/fail**，绝不改用 LLM 打分。此铁律在任务表现评估里一分不破。

---

## 五、数据流

### M1（独立基准器）

```
/crsi bench
  → runTaskPerformance(ctx.llm)
      ├─ 加载 task-performance-tasks.json
      ├─ 逐任务：llm.chat(prompt) → 生成代码 → 子进程跑冻结测试 → pass/fail
      └─ score = passed / total
```

### M2（before/after，接进自改进闭环）

```
/crsi modify proposal
  → validateBlastRadius（现有）
  → worktree → apply 改 skill → runTests（现有单元测试）
  → runEval（机制哨兵，现有，不变）
  → 【新】runTaskPerformance(before: 主仓 skill) vs (after: worktree skill)
  → delta → 因果归因（promotion-gate 后续消费）
```

---

## 六、里程碑

| 里程碑 | 内容                                                             | 交付物                |
| ------ | ---------------------------------------------------------------- | --------------------- |
| **M1** | 独立基准器：`task-performance.ts` + `tasks.json` + `/crsi bench` | 能跑、能打分          |
| **M2** | before/after 接线 + skill 注入                                   | delta 信号 → 因果归因 |

M1 是本次 spec 的完整实现范围。M2 依赖「skill 注入机制」的细化，另立计划（或 M1 完成后顺延）。

---

## 七、测试

- **判定函数单测**：给定生成代码 + 冻结测试，pass/fail 判定正确
- **超时/资源限制**：死循环代码被超时杀掉，不挂起评估器
- **加载测试**：`tasks.json` 可解析、结构合法、id 唯一
- **无 LLM 断言**：判定环节不触发任何 LLM 调用（LLM 只在「生成」阶段，判定是纯本地）
- （M2）**before/after delta**：baseline/post 分数差计算正确

---

## 八、风险与开放问题

1. **【关键】任务相关性**：任务必须与被测 skill 的领域匹配，否则改 skill 不影响任务分——「delta 恒为 0」会以新面孔回来。M1 冻结任务时就须明确「这些任务在测哪个 skill」。
2. **【残余噪声】温度 0 仍可能有余噪**（尤其某些模型），「改进」判定要设最小效应阈值，不能 `delta > 0` 就算变好——此为 M2/后续的最小效应量前置。
3. **【成本】每次 before/after = 2 × N 次 LLM 调用**（N = 任务数）。M1 的 5-10 任务 + 温度 0 单次，成本可控；扩容任务集时需重新评估。
4. **【开放】`bug-fix` 类别**：需要「bug 代码 + 红测试」的冻结，构造成本高于 `test-driven`，首批暂缓。
5. **【开放】skill 注入机制**：M2 的「旧版/新版 skill 作为上下文注入」细节未定，M2 启动时单独设计。

---

## Self-Review 记录

- **决策固化**：代码来源（LLM 生成）、噪声（温度 0 单次）、任务集（人工冻结 5-10）三项已在头脑风暴中定稿，写入 §3.1。
- **A1 边界**：LLM 作被测试对象、冻结测试判定，一分不破（§四）。
- **架构理由**：独立慢评估（不复用 runEval / behavior-tasks），因为本模块依赖 LLM、判定跑子进程（§3.2）。
- **安全**：生成代码不可信，子进程 + 超时 + 资源限制 + 无网络，对应 `self-eval` 教训（§3.4）。
- **依赖诚实标注**：M2 的 skill 注入未细化、`bug-fix` 类别暂缓，均标为开放问题（§八），不假装已解决。
