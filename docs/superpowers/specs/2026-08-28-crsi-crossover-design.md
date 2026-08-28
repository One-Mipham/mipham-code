# CRSI Crossover 算子设计

> **日期**: 2026-08-28
> **作者**: Guohua Zhang · One Mipham Corporation
> **术语**: 原子算子 = producer 的候选生成操作（Draft/Improve/Crossover）；Crossover = 组合两个已有候选产新候选（遗传重组思想）；教训 = `crsi-lessons.md` 里的 `## category: title` 段；召回块 = `buildCrsiLessonsBlock` 注入系统提示的教训精华；fail-closed = 宁可拒绝不误改
> **前情**: 承接 [[2026-08-28-crsi-reward-fn-design]]（RewardFn 已落地）；独立轨 5 项最后一项；教训 `crsi-lessons.md` `borrow-analysis`（line 108：四原子算子 Draft/Improve/Debug/Crossover → CRSI producer 补 **Crossover 算子**）

---

## 一、背景与动机

producer 现有三个原子算子，**缺 Crossover**（组合两个已有候选）：

| 算子          | 实现                                                                   | 输入 → 输出                       |
| ------------- | ---------------------------------------------------------------------- | --------------------------------- |
| Draft         | `produceCrsiProposal` / `produceRuleProposal` / `produceProseProposal` | 单信号 → 新候选（教训/规则/散文） |
| Improve       | `produceProseProposal`（改 skill 散文）                                | 单信号 → 改已有 skill             |
| Debug         | （无显式实现，test 失败回滚兜底）                                      | —                                 |
| **Crossover** | **缺**                                                                 | **两候选 → 合一候选**             |

producer 是**无状态单信号**——每次 `/crsi propose` 挑一个信号产一个候选，不维护「候选种群」。所以 Crossover 的「两个候选」只能来自**已累积产物**：`crsi-lessons.md`（~15 条，持续增长，已有重叠：`research`≈`borrow-analysis` 都讲「先读码再下结论」、`self-eval`≈`crsi-design` 都讲「隔离」）。

**价值**：教训文件是「运行时召回」唯一输入（`buildCrsiLessonsBlock` 把全部教训精华注入系统提示），只增不减会膨胀上下文 + 冗余建议互相干扰。Crossover 合并重叠教训 = 给召回块瘦身、保持教训可执行。

---

## 二、目标与非目标

**目标**：

1. 新增 producer 第 4 个原子算子 `produceCrossoverProposal`：LLM 选两条重叠教训 + 生成合并版 → 产出「删二增一」的教训文件变更候选。
2. 确定性 guard（fail-closed）：所选两条教训必须真实存在且不同，否则拒绝——防 LLM 幻觉误删。
3. `/crsi propose --crossover` 命令接线（与 `--prose` 同构）。

**非目标**：

- ❌ 统一 `Debug` 算子（test 失败自动回滚已有兜底，非本 spec 范围）。
- ❌ crossover 幂等 ledger——`hasPending()` 已拦 pending 期间重跑；合并通过后 `titleA/titleB` 自然消失、guard 返回 null。rejected 后重跑重选对 = 用户显式重调（可接受）。
- ❌ 合并受管理规则 / 失败信号——对象锁定教训（唯一持续增长的种群）。
- ❌ 改 `runEval`/`runCrsiModification`/RewardFn——crossover 产出仍走现有沙箱 gate（blastRadius + 测试 + RewardFn 闸 + 人审）。
- ❌ 让 Crossover 自动触发——显式 `/crsi propose --crossover`，不自动跑（LLM 昂贵 + 需人审）。

---

## 三、核心设计

### 3.1 算子签名与流程

`apps/cli/src/core/crsi-producer.ts` 新增（复用 `buildLessonContent` / `collectLlmText` / `stableHash` / `CrsiSignal` / `LESSONS_FILE`）：

```typescript
export interface CrossoverResult {
  titleA: string // 逐字复制的 ## 行完整文本（含 category 前缀）
  titleB: string
  merged: CrsiSignal // 合并后的综合教训（category/title/suggestion/evidence）
}

export async function produceCrossoverProposal(
  llm: Llm,
  currentLessons: string,
  timestamp: string,
): Promise<{
  description: string
  filePath: string
  newContent: string
  originalContent: string
  blastRadius: string[]
} | null>
```

流程：

```
currentLessons ──LLM──▶ {titleA, titleB, merged}
   ├─ parse（stripJsonFence + JSON.parse，非法 → null）
   ├─ guard：titleA !== titleB；`## titleA` / `## titleB` 都在文件里（否则 null，防幻觉）
   ├─ removeLessonSections(content, [headerA, headerB])  删两条
   ├─ buildLessonContent(merged, timestamp)              渲染合并版
   └─ newContent = 删后内容.trimEnd() + '\n\n' + 合并段 + '\n'
        → { description, filePath: LESSONS_FILE, newContent, originalContent, blastRadius: [LESSONS_FILE] }
```

### 3.2 Prompt（生成，A1 安全）

```typescript
const CROSSOVER_PROMPT_VERSION = '1.0.0'

function buildCrossoverPrompt(currentLessons: string): string {
  return [
    `你是 CRSI producer（producer-crossover v${CROSSOVER_PROMPT_VERSION}）。给定当前教训文件，找出两条主题重叠、可合并的教训，生成一条综合教训。`,
    '',
    '当前教训文件：',
    currentLessons,
    '',
    '要求：',
    '1. 找两条「主题重叠」的教训（例如都讲「读码优先」、都讲「隔离」），不要选主题无关的两条。',
    '2. titleA / titleB 必须是文件中 `## ` 行的**完整文本**（含 category 前缀，逐字复制，不要改写）。',
    '3. merged 是合并后的综合教训：category 沿用其中一个、title 概括两者、suggestion 综合两条的核心建议、evidence 综合两条的证据要点。',
    '4. 只返回裸 JSON（不要 markdown 围栏、不要其他文字），格式：',
    '{"titleA":"<完整 ## 行1>","titleB":"<完整 ## 行2>","merged":{"category":"...","title":"...","suggestion":"...","evidence":["...","..."]}}',
  ].join('\n')
}
```

`collectLlmText`（复用）取裸文本。`stripJsonFence` 剥 ` ```json ` 围栏（防 LLM 加围栏）。

### 3.3 确定性纯函数

````typescript
/** 剥 ```json 围栏（LLM 可能加）。 */
function stripJsonFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/)
  return match ? match[1]! : text
}

/** 解析 crossover 结果；非法 / 字段缺失 → null。 */
export function parseCrossoverResult(text: string): CrossoverResult | null {
  try {
    const obj = JSON.parse(stripJsonFence(text))
    if (typeof obj.titleA !== 'string' || typeof obj.titleB !== 'string') return null
    if (
      !obj.merged ||
      typeof obj.merged.category !== 'string' ||
      typeof obj.merged.title !== 'string' ||
      typeof obj.merged.suggestion !== 'string'
    )
      return null
    const evidence = Array.isArray(obj.merged.evidence)
      ? obj.merged.evidence.filter((e: unknown) => typeof e === 'string')
      : []
    return {
      titleA: obj.titleA,
      titleB: obj.titleB,
      merged: {
        category: obj.merged.category,
        title: obj.merged.title,
        suggestion: obj.merged.suggestion,
        evidence,
      },
    }
  } catch {
    return null
  }
}

/** 从教训文件移除若干 `## ` 段（header 须是 `## ` 行完整文本）。preamble 与其余教训不动。 */
export function removeLessonSections(content: string, headers: string[]): string {
  const lines = content.split('\n')
  const out: string[] = []
  let skipping = false
  for (const line of lines) {
    if (line.startsWith('## ')) {
      skipping = headers.includes(line.trim())
      if (skipping) continue
    }
    if (skipping) continue
    out.push(line)
  }
  return out.join('\n')
}
````

### 3.4 命令接线 `/crsi propose --crossover`

`crsiProposeCmd`（commands.ts）加分支（在 `--rule` 之后、默认教训路径之前）：

```typescript
if (args[0] === '--crossover') {
  const llm = ctx.engine.getLlm() ?? ctx.engine.getRegistry()
  let current = ''
  try {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    current = readFileSync(join(root, LESSONS_FILE), 'utf-8')
  } catch {
    current = ''
  }
  if (!current) return { content: '教训文件为空，无可合并。' }

  const proposal = await produceCrossoverProposal(llm, current, new Date().toISOString())
  if (!proposal) return { content: '没有找到可合并的重叠教训对。' }

  const result = await runCrsiModification(proposal)
  if (!result.applied || result.phase === 'failed') {
    return { content: `❌ 合并失败（phase: ${result.phase}）。\n${result.error ?? ''}` }
  }
  return {
    content:
      `✅ 已生成合并教训并跑过测试。审阅 diff：\n\n${result.diff}\n\n` +
      '/crsi modify --approve 合并 | /crsi modify --reject 丢弃',
  }
}
```

---

## 四、A1 铁律边界

LLM 只做**生成**（选两条 + 生成合并版），**判定**全走确定性：

- guard：`titleA !== titleB` + 两 `## ` 行真实存在（字符串 `includes`）——防幻觉。
- `runCrsiModification` 沙箱 gate：blastRadius 闸 + 全量测试 + RewardFn 闸 + 人审。
- 无 LLM 自评（不采纳「这次合并更好」——那是人类审阅 + 沙箱的职责）。

与 `produceProseProposal` 先例一致：LLM 产出候选，`guard`/沙箱/人审判定。

---

## 五、里程碑

| 里程碑 | 内容                                                                                                                     | 交付物             |
| ------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| **C1** | `produceCrossoverProposal` + `parseCrossoverResult` + `removeLessonSections` + `buildCrossoverPrompt` + `stripJsonFence` | 算子（纯函数可测） |
| **C2** | `/crsi propose --crossover` 命令接线                                                                                     | 入口可跑           |

C1/C2 一个 plan 两阶段（C2 依赖 C1 的导出）。

---

## 六、测试

- **parseCrossoverResult 四态**：合法 JSON → 解析成功；带 ` ```json ` 围栏 → 解析成功；字段缺失（无 titleA / merged.title 非 string / evidence 非数组）→ null；非 JSON → null。
- **removeLessonSections**：移除两条后，其余教训、preamble（`# CRSI Lessons` + `<!-- -->`）完好；移除不存在的 header 无副作用；只删 `## ` 段、不误删 `### 证据` 之外的正文。
- **produceCrossoverProposal（textLlm mock）**：固定 JSON（两真实标题 + merged）→ 产出正确（filePath=LESSONS_FILE、newContent 删二增一、blastRadius=[LESSONS_FILE]、originalContent 原样）；guard 各分支 → null（titleA 不在文件 / titleA===titleB / merged 缺字段 / LLM 返回空 / LLM 返回非 JSON）。
- **无回归**：现有 1965 测试全绿（crossover 是纯新增，不动现有 producer 路径）。

---

## 七、风险与开放问题

1. **【LLM 幻觉标题】** LLM 可能返回改写的标题 → guard 精确行匹配拦截（`lines.some(l => l.trim() === header)`，与 `removeLessonSections` 同语义，fail-closed 返回 null）。代价：偶发「找不到可合并对」，用户重跑即可。
2. **【无重叠对】** 教训文件当前无重叠时，LLM 可能强凑两条或返回无效 → parse/guard 返回 null，命令报「没有可合并的重叠教训对」。诚实结果，非 bug。
3. **【合并质量不可自动判定】** 合并版是否更好，人类审阅定夺（A1：不采纳 LLM 自评）。若合并质量差，用户 `--reject`。
4. **【幂等从简】** 不加 ledger，靠 `hasPending()` + 合并后标题消失的自然 guard。rejected 后重跑会重选对（用户显式重调）。如需跨会话去重再加 crossover ledger（对标 prose ledger）。
5. **【教训文件增长】** Crossover 只「删二增一」（净 −1 条），是防膨胀的收敛算子；若将来教训继续膨胀，可再加「合并阈值」（如 >N 条才触发）。

---

## 八、决策记录（岔路口）

| # | 岔路口 | 选项 | 选了 | 为何（否决项理由） | 推迟的 | 回访触发 |
| --- | --- | --- | --- | --- | --- |
| 1 | 交叉对象 | A 教训 / B 规则 / C 信号 | A | 教训是唯一持续增长的种群，重叠真实存在；规则每信号一条语义具体难合并；信号需同 category 两信号同现稀有 | B/C | 规则/信号也积累出种群时 |
| 2 | 合并机制 | A LLM / B 确定性模板 | A | 重叠检测需语义理解，确定性（category 前缀全唯一）检测不到；LLM 生成与 prose 先例一致，A1 不破 | — | — |
| 3 | 幂等 ledger | A 加 / B 从简 | B | `hasPending()` 已拦 pending 重跑；合并后标题消失自然 guard；rejected 重跑=显式重调 | crossover ledger | 出现跨会话重复合并时 |
| 4 | 输出格式 | A JSON / B 自然语言 | A | 需结构化（两标题 + merged 三字段）才能确定性 guard + 模板渲染；JSON 可 parse 可验证 | — | — |
| 5 | 新文件 vs 同文件 | A 新模块 / B crsi-producer.ts | B | producer 算子都在同一文件（lessons/rules/prose 先例），复用 buildLessonContent/collectLlmText/stableHash；新模块增加 import 面 | — | crsi-producer.ts 过大时 |

---

## Self-Review 记录

- **接口一致性**：`produceCrossoverProposal(llm, currentLessons, timestamp)` 返回与 `produceCrsiProposal`/`produceRuleProposal` 同形（description/filePath/newContent/originalContent/blastRadius）——`runCrsiModification` 直接消费（§3.1）。
- **A1 不破**：LLM 只生成（选对 + 合并），guard/沙箱/RewardFn 闸/人审判定（§四）。
- **fail-closed**：guard 逐条 `includes` 校验标题真实存在，幻觉 → null（§3.1/§七.1）。
- **幂等从简**：不加 ledger，靠 hasPending + 自然 guard，诚实标注（§七.4/§决策 #3）。
- **诚实边界**：无重叠对时返回 null 报「没有可合并对」；合并质量人审定（§七.2/§七.3）。
- **无占位符**：接口、prompt、三个纯函数、命令分支、四态测试均给具体实现。
