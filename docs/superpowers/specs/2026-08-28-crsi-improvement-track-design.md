# CRSI 改进轨（Improvement Track）设计

> **日期**: 2026-08-28
> **作者**: Guohua Zhang · One Mipham Corporation
> **术语**: A1 铁律 = 绝不拿 LLM 当裁判（LLM 可作被测试对象，不可作判定方）；delta = before/after 任务表现分数差；minEffect = 最小效应量（噪声自适应阈值）；verdict = 改进判定（improved/regressed/inconclusive）；改进率 = improved / total（带 Wilson 置信区间）
> **前情**: 承接 [[2026-08-28-crsi-task-performance-m2b-design]]（M2b 已产出随 proposal 变化的 delta 信号）；复活 [[2026-08-27-crsi-promotion-gate]]（被否——其因果归因/最小效应量/误提升预算建在 `runEval` 恒 0 的 delta 上）

---

## 一、背景与动机

M2b 的 `measureSkillDelta` 产出了**真的随 proposal 变化**的 delta。但它是一个**原始信号**：单样本、温度 0 仍有余噪，`delta > 0` 不能断言「改好了」。

被否的 promotion-gate 计划早已把改进轨四项（因果归因 / 最小效应量 / 误提升预算 / 改进率）设计出来，只差一个正确的信号源。现在信号齐了，本 spec 把这四项落地，把「原始 delta」升级为「可辩护的改进判定」。

**四项的地基关系**（前一轮头脑风暴的「两轨划分」）：

| 项         | 依赖                               | 本 spec 定位        |
| ---------- | ---------------------------------- | ------------------- |
| 因果归因   | 需 `changeSet`（单组件才可标因果） | 记录性 flag         |
| 最小效应量 | 需噪声方差（多次采样）             | 判定阈值            |
| 误提升预算 | 需台账累计 + 诚实区间              | campaign 级诚实判定 |
| 改进率     | 需 verdict + 台账                  | 汇总度量            |

---

## 二、目标与非目标

**目标**：

1. 造一个**噪声自适应**的改进判定器：多次采样 before/after → 估噪声 → verdict（improved / regressed / inconclusive）。
2. 把 verdict 接进 `/crsi modify`：**只拦 regressed**（真倒退才拒绝 `--approve`），其余放行。
3. 建 append-only 台账，产出**改进率**（带 Wilson 置信区间）作为 CRSI 循环的有效性度量。

**非目标**：

- ❌ 改 `runCrsiModification`（保持 sync/纯、无 LLM 依赖）——测量/判定都在 async 命令层，与 M2b 同构。
- ❌ 用 LLM 当裁判（A1 不破）——verdict 是确定性算术（多次采样分数 → 均值/标准差 → 阈值比较）。
- ❌ 独立轨 5 项（禁用护栏 / 语义边界 / Crossover / 原子激活 / RewardFn 接口）——另立计划。
- ❌ 全闸（「须证明更好才允许合并」）——已决策为「倒退才拦」，中性/美容性改动放行。
- ❌ 持久化 delta 之外的探索机制（改进率作为优化目标驱动 producer）——方向性大改，另立计划。

---

## 三、核心设计

### 3.1 模块边界

| 文件                                | 动作     | 职责                                                                                                           |
| ----------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `core/task-performance.ts`          | Modify   | 加 `measureSkillDeltaRepeated`（多次采样）；抽出共享 `resolveSkillProposal` 供单/多样本复用                    |
| `core/improvement-track.ts`         | **新增** | verdict 分类 + 噪声阈值 + Wilson + 台账 + pending verdict 闸                                                   |
| `~/.mipham/crsi/improvements.jsonl` | **新增** | append-only 台账（同 `eval-scores.jsonl` 风格）                                                                |
| `ui/commands.ts`                    | Modify   | `crsiModifyCmd` 接 verdict + `--approve` 拦 regressed + 显示改进率；**前提修复**：补 `blastRadius: [filePath]` |

`runCrsiModification` **零改动**。`measureSkillDelta`（M2b 单样本版）**保留**（供 `/crsi bench` 快速基准与未来单样本场景），但 `crsiModifyCmd` 改用多次采样路径。

### 3.2 四项怎么落

| 项             | 落法                                                                                                                                                                  | 决策性                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **因果归因**   | `causal = changeSet.length === 1`（autocontext「只省略一个变量才标因果」）；`changeSet = proposal.blastRadius`。单文件 modify → 恒 true；多文件 producer 提案 → false | 记录性，不拦          |
| **最小效应量** | `minEffect = max(MIN_EFFECT_FLOOR, NOISE_K × noise)`，`noise` = 基线 K 次分数的标准差                                                                                 | 判定阈值              |
| **误提升预算** | 单提案假改进被 2σ 阈值压在 ~5%；台账累计后 `improvementSignalStrong` 判「改进率 Wilson 95% CI 下界 > 假阳性基线 5%」——campaign 级诚实判定                             | 诚实呈现，不单独 gate |
| **改进率**     | `improved / total`（含 Wilson 区间），随 `/crsi modify` 显示                                                                                                          | 汇总度量              |

### 3.3 采样 + verdict（核心）

```
K         = 3（默认常量，非用户配置）
baseline  = 跑 K 次 runTaskPerformance(旧 skill) → 分数数组 b[0..K-1]
post      = 跑 K 次 runTaskPerformance(新 skill) → 分数数组 p[0..K-1]
deltaMean = mean(p) - mean(b)
noise     = stdDev(b)                       // 基线是噪声参照（post 可能含真实位移）
minEffect = max(MIN_EFFECT_FLOOR, NOISE_K × noise)

verdict（纯函数 classifyDelta）:
  deltaMean <= -minEffect  → 'regressed'   ← 唯一会拦的
  deltaMean >= +minEffect  → 'improved'
  |deltaMean| < minEffect  → 'inconclusive'
```

常量默认值：`SAMPLE_K = 3`、`MIN_EFFECT_FLOOR = 20`、`NOISE_K = 2`、`FALSE_POSITIVE_BASELINE = 0.05`。

A1 不破：K 次全是「LLM 生成 → 冻结测试判定」，verdict 是均值/标准差/阈值比较的确定性算术，零 LLM 裁判。

### 3.4 接口契约

**`core/task-performance.ts`（加）**：

```typescript
export interface SkillDeltaSample {
  skillName: string
  baselineScores: number[]
  postScores: number[]
}

export async function measureSkillDeltaRepeated(
  llm: Llm,
  proposal: { filePath: string; originalContent?: string; newContent: string },
  opts?: { k?: number },
): Promise<SkillDeltaSample | null>
```

返回 `null` 当：不是 skill 文件 / 该 skill 无绑定任务集 / 旧 skill 不可读（与 M2b 的 `measureSkillDelta` 同门）。

**`core/improvement-track.ts`（新增）**：

```typescript
export type ImprovementVerdict = 'improved' | 'regressed' | 'inconclusive'

export interface ImprovementReport {
  skillName: string
  changeSet: string[]
  causal: boolean
  baselineScores: number[]
  postScores: number[]
  deltaMean: number
  noise: number
  minEffect: number
  verdict: ImprovementVerdict
}

export interface ImprovementRecord extends ImprovementReport {
  id: string
  timestamp: string
}

// 纯函数
export function computeMinEffect(noise: number): number
export function classifyDelta(deltaMean: number, minEffect: number): ImprovementVerdict
export function buildImprovementReport(
  sample: SkillDeltaSample,
  changeSet: string[],
): ImprovementReport
export function wilsonInterval(
  improved: number,
  total: number,
  z?: number,
): { lo: number; hi: number }
export function improvementRate(records: ImprovementRecord[]): {
  total: number
  improved: number
  rate: number
  lo: number
  hi: number
}
export function improvementSignalStrong(records: ImprovementRecord[]): boolean

// 台账
export function appendImprovement(record: ImprovementRecord): void
export function readImprovements(): ImprovementRecord[]

// pending verdict 闸（倒退才拦）
export function setPendingVerdict(v: ImprovementVerdict | null): void
export function getPendingVerdict(): ImprovementVerdict | null
export function shouldBlockApproval(v: ImprovementVerdict): boolean
```

### 3.5 接线 `/crsi modify`（倒退才拦 + 前提修复）

**前提修复**（P0，当前命令被 blast-radius 闸拒绝）：`crsiModifyCmd` 与 `/crsi propose --prose` 调 `runCrsiModification` 时补 `blastRadius: [filePath]`——单文件修改的完整覆盖就是它自己，且为因果归因提供 `changeSet`。

**`crsiModifyCmd` 流程（改进轨版）**：

```
/crsi modify <desc> <filePath> <newContent>
  ├─【修复】blastRadius = [filePath]
  ├─ runCrsiModification({ ..., blastRadius })        // 现有，sync，零改动
  │     └─ 失败 → 返回错误（不跑 LLM，避免白费 6 次调用）
  ├─【新】成功后才测量：sample = measureSkillDeltaRepeated(llm, {filePath, originalContent, newContent})
  │     ├─ 非 skill / 无任务集 → null → 无 verdict（改进轨对非 skill 提案无意见）
  │     └─ 有 → report = buildImprovementReport(sample, blastRadius)
  │           → setPendingVerdict(report.verdict)
  │           → appendImprovement({ ...report, id, timestamp })
  ├─ 结果显示：📊 改进判定 improved/regressed/inconclusive (deltaMean ±X, 噪声 Y, 阈值 Z)
  │           + 一行改进率（total/improved/rate + Wilson CI）
  └─ 提示 /crsi modify --approve|--reject（regressed 时额外提示「禁止固化」）

/crsi modify --approve
  └─【新】if (shouldBlockApproval(getPendingVerdict() ?? 'inconclusive'))
          → 拒绝：「任务表现倒退，禁止固化」   // fail-closed
       否则 approvePending()（现有）
```

pending verdict 是模块级单例（同 `pendingSandbox` 生命周期）：`modify` 时 set，`approve`/`reject` 时 clear（防陈旧 verdict 误拦无关后续）。

---

## 四、A1 铁律边界

| 角色             | 定义                                     | A1 是否禁止           |
| ---------------- | ---------------------------------------- | --------------------- |
| LLM 当裁判       | 用 LLM 判「这个改动好不好」              | ❌ 禁止               |
| LLM 作被测试对象 | LLM 生成代码，冻结测试确定性判定（K 次） | ✅ 允许               |
| 统计判定         | 均值/标准差/阈值比较 → verdict           | ✅ 允许（确定性算术） |

verdict、minEffect、改进率全部是**确定性算术**，无任何 LLM 打分。

---

## 五、数据流

```
/crsi modify <desc> <filePath> <newContent>   [改进轨完整链]
  ├─ blastRadius = [filePath]  （前提修复）
  ├─ runCrsiModification → 失败则止
  ├─ measureSkillDeltaRepeated（K=3 × before/after）
  │     ├─ 路径门 / 任务集 guard / 旧 skill 可读 → 否则 null
  │     └─ SkillDeltaSample { baselineScores[3], postScores[3] }
  ├─ buildImprovementReport → { deltaMean, noise, minEffect, verdict, causal }
  ├─ appendImprovement → ~/.mipham/crsi/improvements.jsonl
  ├─ setPendingVerdict(verdict)
  └─ 显示 verdict + 改进率
/crsi modify --approve
  └─ shouldBlockApproval(getPendingVerdict()) → regressed ? 拒 : approvePending()
```

---

## 六、里程碑

| 里程碑 | 内容                                                                                            | 交付物                                                             |
| ------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **I1** | 前提修复：`blastRadius: [filePath]` 补进两处                                                    | `/crsi modify`、`/crsi propose --prose` 不再被 blast-radius 闸拒绝 |
| **I2** | `measureSkillDeltaRepeated` + `improvement-track.ts`（verdict + Wilson + 台账 + pending 闸）    | 纯函数 + 台账，可单测                                              |
| **I3** | `crsiModifyCmd` 接线：测量在 `runCrsiModification` 成功后、`--approve` 拦 regressed、显示改进率 | 端到端「倒退才拦」                                                 |

I1/I2/I3 是一个 plan 的三阶段（依赖顺序）。改进轨是完整范围。

---

## 七、测试

- **computeMinEffect**：noise=0 → 返回 `MIN_EFFECT_FLOOR`；noise 大 → `NOISE_K × noise`。
- **classifyDelta 三分支**：`delta <= -minEffect` → regressed；`>= +minEffect` → improved；中间 → inconclusive（边界值含等号）。
- **buildImprovementReport**：给定 sample，deltaMean/noise/minEffect/verdict 计算正确；`causal = changeSet.length===1`。
- **measureSkillDeltaRepeated**（mock llm）：路径门 → null；无绑定任务 → null；强/弱 skill 各 K 次采样分数数组正确。
- **wilsonInterval**：已知 p/n 的区间正确；n=0 → 不除零。
- **improvementRate / improvementSignalStrong**：台账汇总正确；全 inconclusive → signal 弱；高 improved → signal 强。
- **台账**：append → read 往返一致；append-only（append 后旧记录不变）。
- **pending 闸**：set → get 往返；shouldBlockApproval('regressed')===true，其余 false；approve/reject 后 clear。
- **前提修复**：`runCrsiModification` 传 `blastRadius:[filePath]` 后不再返回「blast radius 未声明」。

---

## 八、风险与开放问题

1. **【任务相关性，仍在】**：只有 safe-coding 有任务集，改进轨只对 safe-coding 有意义。任务集扩容是独立前置（M2 风险延续）。
2. **【噪声估计粗糙】**：K=3 时标准差估计方差大，可能高估/低估噪声 → verdict 边界不稳。缓解：K 可调、阈值含固定下限。长期可增 K 或换成自助法。
3. **【成本】**：每次 skill proposal = 2K = 6 次 LLM 调用（K=3），仅在 `runCrsiModification` 成功后触发。任务集扩容时重估。
4. **【pending verdict 生命周期】**：verdict 存模块级单例，CLI 重启丢失（与 `pendingSandbox` 同现状限制）。重启后 `--approve` 本也会因无 pending 失败，故不新增风险。
5. **【误提升预算的首版是「诚实呈现」而非「主动收紧」】**：NOISE_K 固定 2，未随 N 增大收紧。长期可在台账累计 N 超过阈值时上调 NOISE_K（Bonferroni 风格），标为后续。
6. **【开放】frontmatter 名变更**：proposal 改 skill 的 `name:`（重命名）会匹配不到旧任务集（M2b 风险 #4 延续），首版不处理。

---

## 九、决策记录（岔路口）

| #   | 岔路口         | 选项                                                     | 选了 | 为何（否决项理由）                                                                                                           | 推迟的            | 回访触发               |
| --- | -------------- | -------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---------------------- |
| 1   | 噪声处理       | A 固定阈值单样本 / B 多次采样噪声自适应 / C 自适应重采样 | B    | A 阈值拍脑袋、无法自适应噪声且当前 1 任务 delta 粒度粗（-100/0/+100）；C 实现复杂、首版不做。B 真因果归因 + 自适应 minEffect | 自适应重采样      | 任务集扩容后成本敏感时 |
| 2   | 判定语义       | A 纯记录 / B 倒退才拦 / C 全闸                           | B    | A 不闭环「证明更好」；C 会挡中性/美容性改动、与 /crsi modify 通用性冲突。B 只拦 runEval 抓不到的真倒退                       | 全闸              | 若需「只收真改进」时   |
| 3   | 误提升预算     | A 主动 alpha-spending / B 诚实呈现（Wilson CI + 基线）   | B    | A 需复杂 campaign 状态机，首版过度；B 用 Wilson CI 下界 > 假阳性基线判「循环有效」，诚实且可测                               | NOISE_K 随 N 收紧 | 台账 N 大且误判浮现时  |
| 4   | 测量时机       | A runCrsiModification 前 / B 成功后                      | B    | A 对 failed proposal 白跑 6 次 LLM；B 先过测试/ eval 闸再测，省成本                                                          | —                 | —                      |
| 5   | changeSet 来源 | A 复用 blastRadius / B 新增字段                          | A    | blastRadius 已存在（完整覆盖闸），单文件 modify = [filePath]、多文件 producer 天然多组件；不造新概念                         | —                 | —                      |
| 6   | 前提修复归属   | A 独立 bugfix / B 并入改进轨 I1                          | B    | 改进轨接线恰好落在同几行；blastRadius 又是因果归因 changeSet 的来源，一起修不重复碰                                          | —                 | —                      |

---

## Self-Review 记录

- **A1 边界**：verdict/阈值/改进率全确定性算术，LLM 只作被测试对象（§四）。
- **隔离**：`runCrsiModification` 零改动，测量/判定在 async 命令层（§3.1/§3.5），与 M2b 同构。
- **诚实边界**：verdict 是「信号 + 阈值」，不是「绝对真理」——K=3 噪声估计粗糙，标为风险（§八.2）；改进率带 Wilson CI 不裸报点估计（§八.5）。
- **前提修复诚实标注**：`/crsi modify` 当前被 blast-radius 闸拒绝（commands.ts 未传 blastRadius），作为 I1 写入 spec，不假装已可用（§3.5）。
- **无占位符**：常量、签名、阈值公式、verdict 边界均给具体值。
