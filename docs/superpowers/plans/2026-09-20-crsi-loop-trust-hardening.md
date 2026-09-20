# CRSI 闭环可信度加固 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 CRSI 自改进环补上三个可证伪的约束 —— 事前预登记的 ε（prose 路径）、合并型提案的脚手架收敛闸 B_H、以及把 anchor 契约的真源移到契约定义处的两向守卫。

**Architecture:** 三处都是「让一处手写镜像重新可被检验」。ε 靠 prompt 前置一行 JSON 记下预期、再由纯函数判定命中；B_H 靠 `measureScaffold` 按 filePath 分派语义计数、只对 `merge === true` 的提案要求各项不增（零写死常数）；anchor 守卫把真源内联到 17 处 `results.push`，`ANCHOR_CONTRACT_IDS` 退为独立声明，由新增的 integrity 守卫两向比对。

**Tech Stack:** TypeScript 5.5 (strict) / Bun / Vitest 5 / pnpm 9.15。全部改动落在 `apps/cli`。

**Spec:** `docs/superpowers/specs/2026-09-20-crsi-loop-trust-hardening-design.md`

## Global Constraints

- **一条铁律**：三个提交，各自独立可回退，顺序为 ① ε ② B_H ③ anchor 守卫。
- **每道新闸必须配负控**，且各负控的「红集」**两两不同**（红集是集合，判据是互不相等）。仅声明「测试通过」不算验证 —— 记忆 `checks-that-cannot-fail` 里已八次栽在这上面。
- **不新增写死常数**：ε 不含阈值常数；B_H 不含上界常数。
- **不动现有闸门语义**：`shouldBlockApproval`、anchor 回归闸（`regressedAnchors`）、`getLastEvalScore` rewards 闸一律不改。
- **跑测试必须 `cd apps/cli` 再跑**。从仓库根跑会因 MCP 测试 spawn 子进程继承 `process.cwd()` 而产生 **31 个假红**（`mcp/*` 28 + `crsi-sandbox` 3），全是路径问题，别去查 MCP 代码。
- **负控回滚用 `cp` 存档还原并核 `sha256`**，**不要**用 `git checkout --`（它回滚到 HEAD，会抹掉本批未提交的被测工作 —— 2.70.0 与 2.56.0 批已各栽过一次）。
- **文档数字同提交回填**：改被测数量的提交必须在**同一提交内**把活文档里的数字改成真值，且真值必须**由命令产出**，不是估的。
- **本批全部人工编写、人工审阅**：目标文件 `crsi-producer.ts` / `crsi-modify.ts` / `crsi-sandbox.ts` 在 `PROTECTED_ROLES.selfImprovement`，`improvement-track.ts` / `eval-harness.ts` / `apps/cli/test/` 在 `PROTECTED_ROLES.evaluator` ⇒ 不可由 `/crsi modify` 产出或批准。
- 提交信息遵循 Conventional Commits，并以 `Co-Authored-By: Claude Code <noreply@anthropic.com>` 结尾。
- **契约计数账**（每个任务后都必须对得上）：起始 **38 条 / 15 anchor** → 提交① 后 **39 / 16** → 提交② 后 **40 / 17** → 提交③ 后 **40 / 17**。
  - 起始值是**实测**的，不是从文档抄的（2026-09-20 跑 `runEval()` 得 `TOTAL=38 PASSED=38 SCORE=100 ANCHOR_SET_SIZE=15 ANCHOR_ROLE_IN_RESULTS=15`）。任何时刻想复核，把这段当成临时探针跑一次、跑完删掉：
    ```bash
    cd apps/cli && cat > test/_tmp_evalcount.test.ts <<'EOF'
    import { it, expect } from 'vitest'
    import { runEval, ANCHOR_CONTRACT_IDS } from '../src/core/eval-harness'
    it('counts', () => {
      const r = runEval()
      const a = r.results.filter((x) => x.role === 'anchor')
      expect(`TOTAL=${r.total} SET=${ANCHOR_CONTRACT_IDS.size} ROLE=${a.length}`).toBe('PROBE')
    })
    EOF
    pnpm vitest run test/_tmp_evalcount.test.ts 2>&1 | grep -E "Received:"
    rm -f test/_tmp_evalcount.test.ts
    ```
    刻意用「断言一个错的值」而非 `console.log` —— 后者会被 vitest 的 reporter 吞掉（本计划实测：同一探针用 `console.log` 跑出**零输出**，误判成「测试没跑」）。

### 与 spec 的三处偏差（已记录，实施时按本计划执行）

1. **ε 解析顺序改为「先归一化、后嗅探」**。spec 初稿写「若首行是围栏则跳过它再取下一行」，这条路走不通：`stripMarkdownFence` 的正则锚在串首，手工跳过后正文尾部会留一个孤立的 ` ``` ` 而没有东西去剥它。已就地修正 spec §3.3；本计划按修正后的顺序实施。
2. **§3.7 的「该结论同时落台账」改为「只打印」**。`/crsi stats` 是只读命令，让它写台账需要为「一条结论」发明新的记录形状（`appendImprovement` 只收完整 `ImprovementReport`）。而该结论**可由台账随时重算**（每次运行都从同一个 `improvements.jsonl` 派生），无需单独持久化。故只打印，不写盘。
3. **spec §6.3 说 `apps/cli/README.md` 也载有测试数 —— 该断言为假，已实测。** `grep -nE "[0-9]{4}|2891|1134|测试|test" apps/cli/README.md` 只有 1 处命中（`:76` 的一个 `v1.0.0` 版本文案链接），**不含任何计数**。故回填面只有 `CLAUDE.md`。
   而且**即便它载有数字也不该改**：`apps/cli/README.md` 是 `test/core/crsi-modify.test.ts:24` 与 `test/core/crsi-sandbox.test.ts` 的**工作树夹具**（`WORKTREE_FILE = 'apps/cli/README.md'`）。工作区一旦有未提交改动落到它身上，`crsi-sandbox` 会**恒 3 红**（记忆 `mipham-code-crsi-sandbox-fixture-fragility`：拿真仓库文件当 fixture，工作区脏即恒红、commit 后自愈）。⇒ **本批一个字都不要动它。**

---

## 文件结构

| 文件                                                     | 责任                                       | 本批动作                                                                                                                                                              |
| -------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/cli/src/core/improvement-track.ts`                 | 改进判定纯函数 + 台账 + pending 闸         | 加 `predictionHit`、`predictionHitRate`；`ImprovementReport` 加 2 字段；`buildImprovementReport` 加第 3 参                                                            |
| `apps/cli/src/core/crsi-producer.ts`                     | 把失败信号转成改动候选                     | prose prompt 升 1.1.0；加 `parseProsePrediction`；`generateProseContent` 返回值改形；`ProseProposalResult` 加 2 字段；`produceCrossoverProposal` 返回加 `merge: true` |
| `apps/cli/src/core/crsi-sandbox.ts`                      | worktree 沙箱 + 只读边界 + pre-worktree 闸 | 加 `measureScaffold`、`validateMergeConvergence`                                                                                                                      |
| `apps/cli/src/core/crsi-modify.ts`                       | 五阶段编排 + 两阶段人工闸                  | `CrsiProposal` 加 3 可选字段；`runCrsiModification` 插收敛闸                                                                                                          |
| `apps/cli/src/ui/commands.ts`                            | slash 命令                                 | prose 路径接测量；`/crsi stats` 加 ε 段                                                                                                                               |
| `apps/cli/src/core/eval-harness.ts`                      | 冻结的 ground-truth 契约                   | 加 2 条契约并标 anchor；`EvalResult` 加 `anchor`；17 处内联；回填改派生                                                                                               |
| `apps/cli/test/core/improvement-track.test.ts`           | 判定纯函数单测                             | 加 2 个 describe                                                                                                                                                      |
| `apps/cli/test/core/crsi-producer-prose.test.ts`         | prose 两阶段单测                           | 改 2 处断言；加 `parseProsePrediction` 用例                                                                                                                           |
| `apps/cli/test/core/crsi-sandbox.test.ts`                | 沙箱 + 闸单测                              | 加 2 个 describe                                                                                                                                                      |
| `apps/cli/test/core/crsi-modify.test.ts`                 | 编排 + 闸集成                              | 加收敛闸用例                                                                                                                                                          |
| `apps/cli/test/core/eval-harness.test.ts`                | 契约计数断言                               | 38 → 39 → 40                                                                                                                                                          |
| `apps/cli/test/integrity/anchor-contract-wiring.test.ts` | **新建** anchor 两向守卫                   | 4 条断言                                                                                                                                                              |
| `CLAUDE.md` + `docs/claude-md-history.md`                | 活文档数字 + 窗口行                        | 三提交各回填一次                                                                                                                                                      |

---

# 提交 ① — ε 预登记与预测命中

## Task 1: `predictionHit` 纯函数

**Files:**

- Modify: `apps/cli/src/core/improvement-track.ts`（在 `improvementSignalStrong` 之后、`// ── 台账 ──` 之前插入）
- Test: `apps/cli/test/core/improvement-track.test.ts`

**Interfaces:**

- Consumes: 无（纯函数，零依赖）
- Produces: `predictionHit(predicted: number | undefined, deltaMean: number): boolean`

- [ ] **Step 1: 写失败的测试**

在 `apps/cli/test/core/improvement-track.test.ts` 的 import 块（第 11-25 行）里加 `predictionHit,`，然后在 `describe('wilsonInterval')` 之前插入：

```ts
describe('predictionHit', () => {
  it('真值表：达到预测算命中、未达不算、缺席恒 false', () => {
    expect(predictionHit(10, 20)).toBe(true) // 实际 20 ≥ 预测 10
    expect(predictionHit(50, 20)).toBe(false) // 实际 20 < 预测 50
    expect(predictionHit(20, 20)).toBe(true) // 等号算命中（贴线达成）
    expect(predictionHit(undefined, 20)).toBe(false)
  })

  it('不叠加 minEffect：负 delta 对上负预测照样算命中', () => {
    // ε 是提交者自己写下的数，判据就是「达到没达到」。
    // 若这里叠一层 minEffect(20)，(−5, −10) 会被判 false —— 那是把两个数打架。
    expect(predictionHit(-10, -5)).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/cli && pnpm vitest run test/core/improvement-track.test.ts -t predictionHit
```

Expected: FAIL —— `predictionHit is not a function`（或 TS 报未导出）。

- [ ] **Step 3: 写最小实现**

在 `improvement-track.ts` 的 `improvementSignalStrong` 函数之后插入：

```ts
/**
 * 预测命中：事前写下的点数被实际达到。缺席预测（undefined）不计入。
 *
 * 刻意**不叠加 `minEffect`** —— ε 是提交者自己写下的数，判据就是「达到没达到」；
 * 再套一层统计阈值会让两个数打架，且使「命中」不可复算。
 */
export function predictionHit(predicted: number | undefined, deltaMean: number): boolean {
  return predicted !== undefined && deltaMean >= predicted
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/cli && pnpm vitest run test/core/improvement-track.test.ts -t predictionHit
```

Expected: PASS（2 条）。

- [ ] **Step 5: 负控 N3 —— 证明判据能失败**

```bash
cd apps/cli && cp src/core/improvement-track.ts /tmp/n3-backup.ts && shasum -a 256 src/core/improvement-track.ts
```

把 `return predicted !== undefined && deltaMean >= predicted` 改成 `return predicted !== undefined`（只查存在、不比较），然后：

```bash
cd apps/cli && pnpm vitest run test/core/improvement-track.test.ts -t predictionHit
```

Expected: **FAIL**（真值表第 2 行 `predictionHit(50, 20)` 现在返回 `true`）。

还原并核 sha：

```bash
cd apps/cli && cp /tmp/n3-backup.ts src/core/improvement-track.ts && shasum -a 256 src/core/improvement-track.ts
```

两次 `shasum` 输出必须逐字符相同。**红集记录**：仅 `predictionHit` 真值表这 1 条。

- [ ] **Step 6: 提交**

```bash
cd apps/cli && git add src/core/improvement-track.ts test/core/improvement-track.test.ts
git commit -m "feat(crsi): 加 predictionHit 纯函数（ε 预登记的判定侧）

不叠加 minEffect：ε 是提交者自己写下的数，判据就是达到没达到。
负控 N3（改成只查存在不比较）⇒ 真值表 1 条红。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 2: `buildImprovementReport` 收预测 + `predictionHitRate`

**Files:**

- Modify: `apps/cli/src/core/improvement-track.ts`（`ImprovementReport` 接口 :15-25；`buildImprovementReport` :55-74；`predictionHitRate` 新增于 `improvementRate` 之后）
- Test: `apps/cli/test/core/improvement-track.test.ts`

**Interfaces:**

- Consumes: `predictionHit`（Task 1）、`wilsonInterval`（既有）
- Produces:
  - `ImprovementReport.predictedDelta?: number`、`ImprovementReport.predictionHit?: boolean`
  - `buildImprovementReport(sample: SkillDeltaSample, changeSet: string[], predicted?: number): ImprovementReport`
  - `predictionHitRate(records: ImprovementRecord[]): { total: number; hits: number; rate: number; lo: number; hi: number }`

- [ ] **Step 1: 写失败的测试**

在 `improvement-track.test.ts` 的 import 块加 `predictionHitRate,`，并在 `describe('wilsonInterval')` 之前插入：

```ts
describe('predictionHitRate', () => {
  function rec(predictedDelta?: number, hit?: boolean): ImprovementRecord {
    return {
      skillName: 's',
      changeSet: ['f.md'],
      causal: true,
      baselineScores: [50],
      postScores: [70],
      deltaMean: 20,
      noise: 0,
      minEffect: 20,
      verdict: 'improved',
      id: 'x',
      timestamp: '2026-09-20T00:00:00.000Z',
      ...(predictedDelta !== undefined ? { predictedDelta, predictionHit: hit } : {}),
    }
  }

  it('分母只数有预测的记录，缺席既不入分子也不入分母', () => {
    const r = predictionHitRate([rec(10, true), rec(50, false), rec()])
    expect(r.total).toBe(2)
    expect(r.hits).toBe(1)
    expect(r.rate).toBe(0.5)
  })

  it('全部缺席 → total 0、rate 0，不除零', () => {
    const r = predictionHitRate([rec(), rec()])
    expect(r.total).toBe(0)
    expect(r.rate).toBe(0)
    expect(r.lo).toBe(0)
  })
})

describe('buildImprovementReport 带预测', () => {
  const SAMPLE = { skillName: 's', baselineScores: [50, 50], postScores: [70, 70] }

  it('给了预测 → 两个字段都写上', () => {
    const r = buildImprovementReport(SAMPLE, ['f.md'], 10)
    expect(r.deltaMean).toBe(20)
    expect(r.predictedDelta).toBe(10)
    expect(r.predictionHit).toBe(true) // 20 ≥ 10
  })

  it('没给预测 → 两个字段都不出现（而非 false）', () => {
    const r = buildImprovementReport(SAMPLE, ['f.md'])
    // 关键：缺席必须缺席。写成 predictionHit: false 会让「无预测」被算进分母，
    // 命中率就被「我们没预测」稀释成 0。
    expect('predictedDelta' in r).toBe(false)
    expect('predictionHit' in r).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/cli && pnpm vitest run test/core/improvement-track.test.ts
```

Expected: FAIL —— `predictionHitRate is not a function`，且「带预测」两条断言失败（`predictedDelta` 为 `undefined`）。

- [ ] **Step 3: 写最小实现**

(a) `ImprovementReport` 接口末尾（`verdict: ImprovementVerdict` 之后）加两个可选字段：

```ts
  /** ε：提交者事前写下的预期提升点数。缺席 = 该记录没有预登记。 */
  predictedDelta?: number
  /** 预测是否命中。与 predictedDelta 同时出现、同时缺席（JSON 序列化会丢掉 undefined 键）。 */
  predictionHit?: boolean
```

(b) `buildImprovementReport` 增加第三参并写入字段：

```ts
export function buildImprovementReport(
  sample: SkillDeltaSample,
  changeSet: string[],
  predicted?: number,
): ImprovementReport {
  const deltaMean = mean(sample.postScores) - mean(sample.baselineScores)
  const noise = stdDev(sample.baselineScores)
  const minEffect = computeMinEffect(noise)
  const verdict = classifyDelta(deltaMean, minEffect)
  return {
    skillName: sample.skillName,
    changeSet,
    causal: changeSet.length === 1,
    baselineScores: sample.baselineScores,
    postScores: sample.postScores,
    deltaMean,
    noise,
    minEffect,
    verdict,
    // 两个字段同生同灭：缺席预测必须**键不存在**，而不是 predictionHit: false ——
    // 后者会让「我们没预测」被算进 predictionHitRate 的分母。
    ...(predicted !== undefined
      ? { predictedDelta: predicted, predictionHit: predictionHit(predicted, deltaMean) }
      : {}),
  }
}
```

(c) 在 `improvementRate` 之后加 `predictionHitRate`：

```ts
/**
 * ε 命中率。分母 = **有预测的记录数**（判据取 `predictedDelta !== undefined`），
 * 复用既有 wilsonInterval。无预测的记录既不入分子也不入分母。
 */
export function predictionHitRate(records: ImprovementRecord[]): {
  total: number
  hits: number
  rate: number
  lo: number
  hi: number
} {
  const judged = records.filter((r) => r.predictedDelta !== undefined)
  const total = judged.length
  const hits = judged.filter((r) => r.predictionHit === true).length
  const { lo, hi } = wilsonInterval(hits, total)
  return { total, hits, rate: total === 0 ? 0 : hits / total, lo, hi }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/cli && pnpm vitest run test/core/improvement-track.test.ts
```

Expected: PASS（含既有的 19 条 + 新增 4 条）。**既有 `buildImprovementReport` 两条用例（:54、:65）不受影响** —— 第三参可选，不传时行为不变。

- [ ] **Step 5: 提交**

```bash
cd apps/cli && git add src/core/improvement-track.ts test/core/improvement-track.test.ts
git commit -m "feat(crsi): ImprovementReport 收 ε，加 predictionHitRate

两字段同生同灭：缺席预测写成键不存在而非 false，否则「没预测」
会被算进命中率分母、把率稀释成 0。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 3: prose prompt 前置 ε + `parseProsePrediction`

**Files:**

- Modify: `apps/cli/src/core/crsi-producer.ts`（`:339` 版本常数、`:341-362` prompt、`:364-367` 后加解析函数、`:369-379` `generateProseContent`、`:381-386` `ProseProposalResult`、`:388-408` `produceProseProposal`）
- Test: `apps/cli/test/core/crsi-producer-prose.test.ts`

**Interfaces:**

- Consumes: `stripMarkdownFence`（既有私有函数）
- Produces:
  - `parseProsePrediction(raw: string): ProsePrediction`
  - `ProsePrediction { body: string; expectedEffect?: number; risk?: string }`
  - `generateProseContent(...): Promise<ProsePrediction | null>` ← **返回值由 `string` 改形**
  - `ProseProposalResult` 加 `expectedEffect?: number`、`risk?: string`

- [ ] **Step 1: 改既有断言（改形后它们必然失败）**

`apps/cli/test/core/crsi-producer-prose.test.ts:64-65` 两行改成：

````ts
expect(result!.body).toContain('name: memory')
expect(result!.body).not.toContain('```')
````

import 块（:6-12）加 `parseProsePrediction,`。

- [ ] **Step 2: 加 parseProsePrediction 的用例**

在 `describe('generateProseContent')` 之前插入：

````ts
describe('parseProsePrediction', () => {
  it('首行是带 expectedDelta 的 JSON → 剥除该行，产出 ε', () => {
    const r = parseProsePrediction('{"expectedDelta": 12, "risk": "可能变慢"}\n\n# Body\n')
    expect(r.body).toBe('# Body\n')
    expect(r.expectedEffect).toBe(12)
    expect(r.risk).toBe('可能变慢')
  })

  it('整份响应被围栏包住 → 先剥围栏，JSON 仍被认出', () => {
    // 这是「必须先归一化再嗅探」的那条路径：stripMarkdownFence 的正则锚在串首，
    // 若先手工剥首行围栏，正文尾部的 ``` 就再没有东西去剥它。
    const raw = '```markdown\n{"expectedDelta": 7}\n\n# Body\n```'
    const r = parseProsePrediction(raw)
    expect(r.expectedEffect).toBe(7)
    expect(r.body).toBe('# Body\n')
    expect(r.body).not.toContain('```')
  })

  it('expectedDelta 为 null → 剥行但不产生预测', () => {
    const r = parseProsePrediction('{"expectedDelta": null}\n\n# Body\n')
    expect(r.body).toBe('# Body\n')
    expect('expectedEffect' in r).toBe(false)
  })

  it('首行不是 JSON → 正文一字不改（N9 的判据）', () => {
    const raw = '# Body\n{"expectedDelta": 5}\n'
    const r = parseProsePrediction(raw)
    expect(r.body).toBe(raw)
    expect('expectedEffect' in r).toBe(false)
  })

  it('首行是 JSON 但无 expectedDelta 键 → 不吃掉它', () => {
    const raw = '{"note": "hi"}\n\n# Body\n'
    const r = parseProsePrediction(raw)
    expect(r.body).toBe(raw)
  })

  it('首行是裸标量 / 数组 → 不吃', () => {
    expect(parseProsePrediction('42\n\n# Body\n').body).toBe('42\n\n# Body\n')
    expect(parseProsePrediction('["a"]\n\n# Body\n').body).toBe('["a"]\n\n# Body\n')
  })

  it('expectedDelta 是字符串 → 剥行但不产生预测', () => {
    const r = parseProsePrediction('{"expectedDelta": "12"}\n\n# Body\n')
    expect(r.body).toBe('# Body\n')
    expect('expectedEffect' in r).toBe(false)
  })
})
````

- [ ] **Step 3: 跑测试确认失败**

```bash
cd apps/cli && pnpm vitest run test/core/crsi-producer-prose.test.ts
```

Expected: FAIL —— `parseProsePrediction is not a function`，且改形的两条断言因 `result` 是 string 而 `.body` 为 `undefined`。

- [ ] **Step 4: 写实现**

(a) `:339` 版本常数：

```ts
const PROSE_GENERATE_PROMPT_VERSION = '1.1.0'
```

(b) `buildGenerateProsePrompt` 的最后一行（`:360`）换成两段：

```ts
    '返回格式（严格遵守，两段）：',
    '第 1 行：一行 JSON，写下你对这次改动的**预期效果**与**风险**：',
    '{"expectedDelta": <number 或 null>, "risk": "<字符串>"}',
    '- expectedDelta 是预期该 skill 的任务表现提升**点数**（可正可负；无法预测写 null）。',
    '- risk 是这次改动可能在哪方面变差（一句话）。',
    '第 2 行起：改进后的完整 markdown（保持 YAML frontmatter 的 name/description 字段，正文针对失败信号做针对性改进）。不要用代码围栏包住。',
```

(c) 在 `stripMarkdownFence`（`:364-367`）之后插入：

````ts
/** prose 提议的解析产物：正文 + 可选的事前预登记（ε 与风险声明）。 */
export interface ProsePrediction {
  body: string
  /** ε：事前写下的预期提升点数。缺席 = 模型没预测（含显式写 null）。 */
  expectedEffect?: number
  /** R：风险声明。缺席 = 未声明。 */
  risk?: string
}

/**
 * 解析 prose 响应：可选的一行 JSON 前缀（ε）+ 正文。
 *
 * 顺序是**先归一化、后嗅探**（不可颠倒）：stripMarkdownFence 的正则锚在串首
 * （/^```(?:markdown|md)?\s*\n…\n```\s*$/）。若先剥「首行围栏」再嗅探，正文尾部的
 * 那个 ``` 就再没有东西去剥它 ⇒ 孤立的尾部围栏会进入写盘路径。
 *
 * 认领标记是**含 `expectedDelta` 键**（盖住 number 与显式 null 两种写法）；
 * 其余任何情况都走兜底 —— 正文 = 归一化后的原文，一字不改。
 */
export function parseProsePrediction(raw: string): ProsePrediction {
  const stripped = stripMarkdownFence(raw)
  const lines = stripped.split('\n')
  const firstIdx = lines.findIndex((l) => l.trim() !== '')
  if (firstIdx === -1) return { body: stripped }

  let parsed: unknown
  try {
    parsed = JSON.parse(lines[firstIdx]!.trim())
  } catch {
    return { body: stripped } // 首行不是 JSON → 兜底
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { body: stripped }
  }
  const rec = parsed as { expectedDelta?: unknown; risk?: unknown }
  if (!('expectedDelta' in rec)) return { body: stripped } // 不带 ε 的 JSON 不吃

  const expectedEffect = typeof rec.expectedDelta === 'number' ? rec.expectedDelta : undefined
  const risk = typeof rec.risk === 'string' ? rec.risk : undefined
  // 剥掉 JSON 行本身 + 紧随其后的空行
  const body = lines
    .slice(firstIdx + 1)
    .join('\n')
    .replace(/^[ \t]*\n/, '')

  return {
    body,
    ...(expectedEffect !== undefined ? { expectedEffect } : {}),
    ...(risk !== undefined ? { risk } : {}),
  }
}
````

(d) `generateProseContent`（`:369-379`）：

```ts
export async function generateProseContent(
  signal: CrsiSignal,
  llm: Llm,
  filePath: string,
  originalContent: string,
): Promise<ProsePrediction | null> {
  const prompt = buildGenerateProsePrompt(signal, filePath, originalContent)
  const response = await collectLlmText(llm, prompt)
  if (!response) return null
  return parseProsePrediction(response)
}
```

(e) `ProseProposalResult`（`:381-386`）加两个可选字段：

```ts
export interface ProseProposalResult {
  filePath: string
  newContent: string
  originalContent: string
  description: string
  /** ε：由模型在正文之前写下（见 parseProsePrediction）。 */
  expectedEffect?: number
  /** R：风险声明。 */
  risk?: string
}
```

(f) `produceProseProposal`（`:404-407`）改为透传：

```ts
const generated = await generateProseContent(signal, llm, filePath, originalContent)
if (!generated || !generated.body) return null

return {
  filePath,
  newContent: generated.body,
  originalContent,
  description: signal.title,
  ...(generated.expectedEffect !== undefined ? { expectedEffect: generated.expectedEffect } : {}),
  ...(generated.risk !== undefined ? { risk: generated.risk } : {}),
}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd apps/cli && pnpm vitest run test/core/crsi-producer-prose.test.ts
```

Expected: PASS。**重点复核**：既有的 `twoStageLlm` 用例（`:87-98`）喂的正文首行是 `---`（frontmatter），不是 JSON ⇒ ε 缺席、正文不变，`newContent` 仍含 `name: memory` —— 这条恰好是「ε 缺席时行为与今天完全一致」的活证据。

- [ ] **Step 6: 负控 N4 与 N9 —— 一对反向，各自只红一条**

```bash
cd apps/cli && cp src/core/crsi-producer.ts /tmp/n49-backup.ts && shasum -a 256 src/core/crsi-producer.ts
```

**N4（该剥的没剥）**：让 `parseProsePrediction` 认出 JSON 行但**不剥除**它 —— 把 `const body = lines.slice(firstIdx + 1).join('\n').replace(...)` 改成 `const body = lines.join('\n')`。

```bash
cd apps/cli && pnpm vitest run test/core/crsi-producer-prose.test.ts -t parseProsePrediction
```

Expected: **FAIL**，红集 = `首行是带 expectedDelta 的 JSON → 剥除该行，产出 ε` 与 `整份响应被围栏包住 → …` 这 **2 条**（两条都断言了正文内容）。`cp` 还原。

**N9（不该剥的剥了）**：把 `if (!('expectedDelta' in rec)) return { body: stripped }` 改成无条件继续（即「凡首行是 JSON 就吃」）。

```bash
cd apps/cli && pnpm vitest run test/core/crsi-producer-prose.test.ts -t parseProsePrediction
```

Expected: **FAIL**，红集 = `首行是 JSON 但无 expectedDelta 键 → 不吃掉它` 这 **1 条**。

两条**反向**：N4 证明**该剥的剥了**，N9 证明**不该剥的没剥**。只做 N4 会漏掉「凡首行皆吃」这种实现；只做 N9 会漏掉「认出但不剥」。红集不同（2 条 vs 1 条，且条目不相交）。

`cp` 还原后核 sha256 与改前相同。

- [ ] **Step 7: 提交**

```bash
cd apps/cli && git add src/core/crsi-producer.ts test/core/crsi-producer-prose.test.ts
git commit -m "feat(crsi): prose prompt 前置 ε 预登记（prompt 1.0.0 → 1.1.0）

首行一行 JSON 写下预期效果与风险，其后为 skill 正文。
解析顺序先归一化后嗅探：stripMarkdownFence 锚在串首，颠倒会
让尾部围栏进入写盘路径。负控 N9（凡首行 JSON 都吃）⇒ 兜底侧 1 条红。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 4: 把测量接进 prose 路径（本项唯一的行为变更）

**Files:**

- Modify: `apps/cli/src/core/crsi-modify.ts`（`CrsiProposal` :21-39）
- Modify: `apps/cli/src/ui/commands.ts`（`/crsi propose --prose` 分支，`:962-979`）
- Test: `apps/cli/test/core/crsi-modify.test.ts`（类型面）

**Interfaces:**

- Consumes: `ProseProposalResult.expectedEffect`（Task 3）、`buildImprovementReport`（Task 2）、`measureSkillDeltaRepeated`（既有，`commands.ts:44` 已 import）
- Produces: `CrsiProposal.expectedEffect?: number`、`CrsiProposal.risk?: string`

**为什么这一步非做不可**：今天 `measureSkillDeltaRepeated` 全仓库**只有一个调用点** —— `commands.ts:871`，在**手工路径**（参数由人敲 `\n` 转义）。四条 producer 路径（`962` prose / `1005` rule / `1037` crossover / `1065` lessons）调完 `runCrsiModification` 就返回，**全都不测量**。只在 producer 侧加 `expectedEffect` 字段的话，ε 登记在 A 流程、判定在 B 流程，**两端永不相遇**。

- [ ] **Step 1: 写失败的测试**

在 `apps/cli/test/core/crsi-modify.test.ts` 末尾加：

```ts
describe('CrsiProposal ε 字段（类型面）', () => {
  it('expectedEffect / risk / merge 均为可选，缺席时对象仍合法', () => {
    const bare: CrsiProposal = {
      description: 'd',
      filePath: 'apps/cli/src/foo.ts',
      newContent: 'x',
      blastRadius: ['apps/cli/src/foo.ts'],
    }
    expect(bare.expectedEffect).toBeUndefined()
    const full: CrsiProposal = { ...bare, expectedEffect: 12, risk: '可能变慢' }
    expect(full.expectedEffect).toBe(12)
    expect(full.risk).toBe('可能变慢')
  })
})
```

（`merge` 字段在 Task 9 才加，此处只断言前两个。）

import 块若无 `CrsiProposal` 则加 `import type { CrsiProposal } from '../../src/core/crsi-modify'`。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/cli && pnpm typecheck
```

Expected: FAIL —— `expectedEffect` 不存在于 `CrsiProposal`。

- [ ] **Step 3: 加字段**

`apps/cli/src/core/crsi-modify.ts` 的 `CrsiProposal` 里，`blastRadius` 之后加：

```ts
  /**
   * ε：提交者**事前**写下的预期效果（任务表现提升点数）。
   * 缺席 = 不预测。判定见 improvement-track 的 predictionHit。
   */
  expectedEffect?: number
  /** R：风险声明（这次改动可能在哪方面变差）。缺席 = 未声明。 */
  risk?: string
```

- [ ] **Step 4: 把测量接进 prose 路径**

`apps/cli/src/ui/commands.ts`，在 `:969-971` 那段失败闸之后、`:973` 的 `appendProseProposal` 之前插入：

```ts
// ε 预登记落地：prose 路径此前**不测量**（measureSkillDeltaRepeated 全仓库只有手工路径一个
// 调用点）⇒ ε 曾在 A 流程登记、判定侧在 B 流程，两端永不相遇。这里补上测量。
// 成本：每次提案多 6 次 LLM 调用（同手工路径 :867 的注释）。
let predictionLine = ''
try {
  const sample = await measureSkillDeltaRepeated(llm, {
    filePath: proposal.filePath,
    originalContent: proposal.originalContent,
    newContent: proposal.newContent,
  })
  if (sample) {
    const report = buildImprovementReport(sample, [proposal.filePath], proposal.expectedEffect)
    setPendingVerdict(report.verdict)
    appendImprovement({ ...report, id: randomUUID(), timestamp: new Date().toISOString() })
    if (report.predictionHit !== undefined) {
      predictionLine =
        `\n🎯 ε 预测命中: ${report.predictionHit ? '命中 ✅' : '未命中 ⚠️'}` +
        `（预测 ${report.predictedDelta}，实际 delta ${report.deltaMean.toFixed(1)}）`
    }
  }
} catch {
  // 测量失败（LLM 不可用等）不阻断提案流程 —— 与手工路径 :889 的处置一致。
}
```

并把该分支的 `return`（`:975-979`）改成带上 `predictionLine`。**注意原有格式**：`result.diff` 之后是 `\n\n`（不是 `\n`），而 `/crsi modify` 那行前**没有**前导换行 —— 逐字保留，只插新行：

```ts
return {
  content:
    `✅ 已生成散文提议并跑过测试。审阅 diff：\n\n${result.diff}\n\n` +
    predictionLine +
    '/crsi modify --approve 合并 | /crsi modify --reject 丢弃',
}
```

**无需新增 import**：`measureSkillDeltaRepeated`(:44)、`buildImprovementReport`(:50)、`appendImprovement`、`readImprovements`、`setPendingVerdict`、`randomUUID` 均已在位；`llm` 在 `:942` 已在作用域内。

- [ ] **Step 5: 验证**

```bash
cd apps/cli && pnpm typecheck && pnpm vitest run test/core/crsi-modify.test.ts
```

Expected: PASS。

```bash
cd apps/cli && pnpm lint
```

Expected: 无错（`no-floating-promises` 钉在 error —— 上面已 `await`，且整体包在 `try` 里）。

- [ ] **Step 6: 提交**

```bash
cd apps/cli && git add src/core/crsi-modify.ts src/ui/commands.ts test/core/crsi-modify.test.ts
git commit -m "feat(crsi): prose 路径接上测量，ε 两端相遇

此前 measureSkillDeltaRepeated 全仓库只有手工路径一个调用点，
四条 producer 路径都不测量 ⇒ 只加字段会让 ε 登记在 A 流程、
判定在 B 流程，永不相遇。本提交把测量接进 prose 路径。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 5: `/crsi stats` 的 ε 段 + 作废条款

**Files:**

- Modify: `apps/cli/src/ui/commands.ts`（`crsiStatsCmd` :754-808）
- Test: 无独立测试文件（`/crsi stats` 输出无既有断言 —— 已核实 `grep -rn "CRSI Statistics" test/` 零命中，可安全加行）

**Interfaces:**

- Consumes: `predictionHitRate`（Task 2）、`readImprovements`（既有）
- Produces: 无导出符号（命令输出）

- [ ] **Step 1: 加 import**

`commands.ts:50-57` 的 improvement-track import 块里加 `predictionHitRate,`。

- [ ] **Step 2: 写实现**

在 `crsiStatsCmd` 的 `if (effs.length > 0) { ... }` 块之后、`return { content: lines.join('\n') }` 之前插入：

```ts
// ── ε 预测命中（prose 路径） ──
// 作废条款：样本不足就不下结论；台账攒够 20 条而判定样本仍 < 5 ⇒ 明写机制失效。
// 只打印、不写台账：本命令是只读的，而该结论每次都能从同一份 improvements.jsonl 重算出来。
const records = readImprovements()
const pred = predictionHitRate(records)
lines.push('')
lines.push('### ε 预测命中（prose 路径）')
if (pred.total < 5) {
  lines.push(`样本不足（判定记录 ${pred.total} 条，需 ≥ 5）—— 不下结论。`)
  if (records.length >= 20) {
    lines.push('⚠️ ε 机制失效：prose 路径使用率过低（记录总数已达 20 而判定样本仍 < 5）。')
  }
} else {
  lines.push(
    `命中率: ${pred.hits}/${pred.total} (${(pred.rate * 100).toFixed(0)}%, ` +
      `Wilson 95% [${(pred.lo * 100).toFixed(0)}%, ${(pred.hi * 100).toFixed(0)}%])`,
  )
}
```

- [ ] **Step 3: 验证**

```bash
cd apps/cli && pnpm typecheck && pnpm lint && pnpm vitest run test/ui/
```

Expected: PASS。

- [ ] **Step 4: 提交**

```bash
cd apps/cli && git add src/ui/commands.ts
git commit -m "feat(crsi): /crsi stats 加 ε 命中率与作废条款

样本 < 5 只报「样本不足」；台账满 20 条而判定样本仍 < 5 ⇒ 明写
机制失效。只打印不写台账：结论可由台账重算，无需单独持久化。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 6: eval 契约 `prediction-hit-truth-table` + 计数回填

**Files:**

- Modify: `apps/cli/src/core/eval-harness.ts`（import :14-32；契约插在 `working-memory-evidence-gated` :302-307 之后；`ANCHOR_CONTRACT_IDS` :58-74）
- Modify: `apps/cli/test/core/eval-harness.test.ts`（:29-31）
- Modify: `CLAUDE.md` + `docs/claude-md-history.md`

**Interfaces:**

- Consumes: `predictionHit`（Task 1）
- Produces: 契约 id `prediction-hit-truth-table`（anchor）

- [ ] **Step 1: 写失败的测试**

`apps/cli/test/core/eval-harness.test.ts:29-31` 的 `38` 改成 `39`：

```ts
expect(report.total).toBe(39)
expect(report.passed).toBe(39)
expect(report.score).toBe(100)
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/cli && pnpm vitest run test/core/eval-harness.test.ts
```

Expected: FAIL —— `expected 38 to be 39`。**这一条同时是「新契约确实进了产出」的判据**：若不改这个数，测试反而会抓住「总数没变」。

- [ ] **Step 3: 加契约**

`eval-harness.ts` 加一行 `import { predictionHit } from './improvement-track'`（放在 `:25-30` 那段 crsi-producer import 之后。无环：`improvement-track` 的运行时 import 只有 `../shared/atomic-write`，对 `task-performance` 是 `import type`，运行时边为零）。

**插入锚点**：紧接在 `self-report-diagnostic` 那次 `results.push({`（`:346`）**之前**。该位置在行为任务循环之后、自检契约之前，不依赖任何会被后续改动挪动的行号。

````ts

```ts
  // ── ε 预测命中真值表（ground truth：命中判据不叠加统计阈值） ──
  results.push({
    id: 'prediction-hit-truth-table',
    description: 'predictionHit 真值表：达到预测算命中、未达不算、缺席恒 false（不入命中率分母）',
    passed:
      predictionHit(50, 20) === false &&
      predictionHit(10, 20) === true &&
      predictionHit(undefined, 20) === false,
  })
````

并在 `ANCHOR_CONTRACT_IDS` 里加 `'prediction-hit-truth-table',`（保持既有次序风格，加在 `'self-report-diagnostic',` 之前）。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/cli && pnpm vitest run test/core/eval-harness.test.ts
```

Expected: PASS（39/39，score 100，`failures` 空，`regressedAnchors` 空）。

- [ ] **Step 5: 用命令产出真值，回填文档**

```bash
cd apps/cli && pnpm test 2>&1 | tail -25
```

从输出读出**真实**的 `Tests  N passed` 与 `Test Files  M passed`（**不要估**）。本提交新增约 15 条测试，落在 `test/core/`。

按真值改 `CLAUDE.md` 四处：

- `:319` 合计行 —— `**249**` / `**2891**` → 新文件数 / 新测试数；`（2889 passed + 2 skipped）` 同步。
- `:299` core 行 —— 文件数不变（不加新文件），测试数 `1134` → 新值。
- `:85` `test/  # 249 个测试文件，2891 个测试`
- `:111` `pnpm test  # vitest run（2891 个测试）`

**位宽提示**：改动前后都是 4 位数 ⇒ 表格列宽不变、prettier 不会重排整表（该表有 23 行，重排一次会让 `CLAUDE.md` 涨 2,662 字符）。若数字跨到 5 位或 3 位，改完后必须复核总字符数：

```bash
cd /Users/sarvadaya/Rismed_Ronxin_Capital/One_Mipham_Corporation/mipham-code && wc -m CLAUDE.md
```

必须 ≤ **40,000**（当前 32,053）。

- [ ] **Step 6: 回填 `最后更新` 行 + 修订历史窗口**

改 `CLAUDE.md:8` 的 `最后更新` 行（写**本提交**做了什么，散文、1:1 成本），并在修订历史表顶部加一行。**严格遵守 5 行窗口**：新增必须挤掉第 6 行，被挤出的那一行**逐字**移入 `docs/claude-md-history.md`。

- [ ] **Step 7: 跑完整性守卫**

```bash
cd apps/cli && pnpm vitest run test/integrity/tool-reference-integrity.test.ts
```

Expected: PASS（两段零数据行 + 指针在位 + 存档在位 + `CLAUDE.md` ≤ 40,000 字符）。

- [ ] **Step 8: 提交**

```bash
cd apps/cli && git add src/core/eval-harness.ts test/core/eval-harness.test.ts
cd /Users/sarvadaya/Rismed_Ronxin_Capital/One_Mipham_Corporation/mipham-code && git add CLAUDE.md docs/claude-md-history.md
git commit -m "test(crsi): 加 prediction-hit-truth-table 契约（38 → 39，anchor 15 → 16）

ε 的判定侧自己也被锚住：改坏 predictionHit 的真值表会让 anchor
闸拒绝固化。同提交回填活文档的测试计数（真值由 pnpm test 产出）。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

# 提交 ② — 合并型收敛闸 B_H

## Task 7: `measureScaffold`

**Files:**

- Modify: `apps/cli/src/core/crsi-sandbox.ts`（import 块 :17-21 后加；函数加在 `validateBlastRadius` :196 之后）
- Test: `apps/cli/test/core/crsi-sandbox.test.ts`

**Interfaces:**

- Consumes: `LESSONS_FILE`、`MANAGED_RULES_FILE`（从 `./crsi-producer` 导入；无环 —— `crsi-producer` 的本地 import 全是 `import type`）
- Produces: `measureScaffold(filePath: string, content: string): { lessons: number; rules: number; bytes: number }`

- [ ] **Step 1: 写失败的测试**

`apps/cli/test/core/crsi-sandbox.test.ts` 的 import（:2-8）加 `measureScaffold,`，并在 `describe('CrsiSandbox')` 之前插入：

```ts
describe('measureScaffold (脚手架计数)', () => {
  it('教训文件 → 数 `## ` 段数，不计字节', () => {
    const c = '## a: 1\n\n### 证据\n\n- x\n\n## b: 2\n'
    const m = measureScaffold(LESSONS_FILE, c)
    expect(m.lessons).toBe(2)
    expect(m.rules).toBe(0)
    // 字节刻意不计：合并会重写散文，字节随措辞涨落 —— 计入会让「删二增一」
    // 因新段更长而被误拦，即闸挡掉它本该允许的那件事。
    expect(m.bytes).toBe(0)
  })

  it('`### ` 不算一段（与 removeLessonSections 的口径一致）', () => {
    expect(measureScaffold(LESSONS_FILE, '### 证据\n\n## a: 1\n').lessons).toBe(1)
  })

  it("受管理规则文件 → 数 `id: '` 条数", () => {
    const c = "{\n  id: 'a',\n}, {\n  id: 'b',\n}\n"
    const m = measureScaffold(MANAGED_RULES_FILE, c)
    expect(m.rules).toBe(2)
    expect(m.lessons).toBe(0)
    expect(m.bytes).toBe(0)
  })

  it('其余文件（skill 等）→ 退到 UTF-8 字节数', () => {
    const m = measureScaffold('apps/cli/skills/standard/memory.SKILL.md', 'abc')
    expect(m.bytes).toBe(3)
    expect(m.lessons).toBe(0)
    expect(m.rules).toBe(0)
  })

  it('多字节按字节数不按字符数', () => {
    // '悲' 是 3 字节。写成 content.length 会得 1 —— 那是另一个对象的读数。
    expect(measureScaffold('x.md', '悲').bytes).toBe(3)
  })
})
```

同时在 import 里加 `LESSONS_FILE, MANAGED_RULES_FILE`（从 `../../src/core/crsi-producer`）。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/cli && pnpm vitest run test/core/crsi-sandbox.test.ts -t measureScaffold
```

Expected: FAIL —— `measureScaffold is not a function`。

- [ ] **Step 3: 写实现**

`crsi-sandbox.ts` 的 import 块后加：

```ts
import { LESSONS_FILE, MANAGED_RULES_FILE } from './crsi-producer'
```

在 `validateBlastRadius` 之后插入：

```ts
/**
 * 脚手架三项计数（B_H 的度量）。按 filePath 分派语义单位：
 * 教训段数 / 受管理规则条数 / 其余按 UTF-8 字节数。
 *
 * **为什么教训/规则文件不计字节**：合并会重写散文，字节数随措辞涨落。把字节计入，
 * 会让「删二增一」因新写的合并段比原来两段更长而被误拦 —— 即闸会挡掉它本该允许的那件事。
 * skill 文件没有可用的语义单位（它的「条数」就是文件本身），才退到字节数。
 *
 * `^## ` 的口径与 `removeLessonSections` / `extractCrsiLessonSummaries` 逐字一致 ——
 * 闸数的必须是 crossover 真正删得掉的那些单位，否则两把尺子会各说各话。
 */
export function measureScaffold(
  filePath: string,
  content: string,
): { lessons: number; rules: number; bytes: number } {
  if (filePath === LESSONS_FILE) {
    const lessons = content.split('\n').filter((l) => l.startsWith('## ')).length
    return { lessons, rules: 0, bytes: 0 }
  }
  if (filePath === MANAGED_RULES_FILE) {
    const rules = (content.match(/id: '/g) ?? []).length
    return { lessons: 0, rules, bytes: 0 }
  }
  return { lessons: 0, rules: 0, bytes: Buffer.byteLength(content, 'utf-8') }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/cli && pnpm vitest run test/core/crsi-sandbox.test.ts
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd apps/cli && git add src/core/crsi-sandbox.ts test/core/crsi-sandbox.test.ts
git commit -m "feat(crsi): 加 measureScaffold 脚手架计数（B_H 的度量侧）

按 filePath 分派：教训段数 / 规则条数 / 字节数。教训与规则文件
刻意不计字节 —— 合并会重写散文，计入会把「删二增一」误拦。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 8: `validateMergeConvergence`

**Files:**

- Modify: `apps/cli/src/core/crsi-sandbox.ts`（加在 `measureScaffold` 之后）
- Test: `apps/cli/test/core/crsi-sandbox.test.ts`

**Interfaces:**

- Consumes: `measureScaffold`（Task 7）
- Produces: `validateMergeConvergence(proposal: { filePath?: string; originalContent?: string; newContent?: string; merge?: boolean }): string | null`

- [ ] **Step 1: 写失败的测试**

在 `describe('measureScaffold')` 之后插入：

```ts
describe('validateMergeConvergence (合并型收敛闸)', () => {
  const TWO = '## a: 1\n\n## b: 2\n'

  it('合并型净增 → 拒绝，且理由点名是哪一项上升', () => {
    const r = validateMergeConvergence({
      filePath: LESSONS_FILE,
      originalContent: TWO,
      newContent: `${TWO}\n## c: 3\n`,
      merge: true,
    })
    expect(r).not.toBeNull()
    expect(r!).toContain('教训段数')
    expect(r!).toContain('2 → 3')
  })

  it('合并型「删二增一」→ 通过', () => {
    expect(
      validateMergeConvergence({
        filePath: LESSONS_FILE,
        originalContent: TWO,
        newContent: '## ab: merged\n',
        merge: true,
      }),
    ).toBeNull()
  })

  it('存量为零 → 通过（不涨就是收敛）', () => {
    expect(
      validateMergeConvergence({
        filePath: LESSONS_FILE,
        originalContent: TWO,
        newContent: TWO,
        merge: true,
      }),
    ).toBeNull()
  })

  it('`merge !== true` → 不拦（新增型提案不受此闸，幂等仍生效）', () => {
    // 学习这件事本身就是增长：produceCrsiProposal 只能追加，每条新信号净 +1 段。
    // 对新增型开火 === 永久禁掉 /crsi propose。
    expect(
      validateMergeConvergence({
        filePath: LESSONS_FILE,
        originalContent: TWO,
        newContent: `${TWO}\n## c: 3\n`,
        merge: false,
      }),
    ).toBeNull()
    expect(
      validateMergeConvergence({
        filePath: LESSONS_FILE,
        originalContent: TWO,
        newContent: `${TWO}\n## c: 3\n`,
      }),
    ).toBeNull()
  })

  it('无基线（空串 / undefined）→ 不拦：无基线不是有增长', () => {
    expect(
      validateMergeConvergence({
        filePath: LESSONS_FILE,
        originalContent: '',
        newContent: '## a: 1\n\n## b: 2\n\n## c: 3\n',
        merge: true,
      }),
    ).toBeNull()
    expect(
      validateMergeConvergence({
        filePath: LESSONS_FILE,
        newContent: '## a: 1\n',
        merge: true,
      }),
    ).toBeNull()
  })

  it('skill 文件走字节数：合并后变长 → 拒绝', () => {
    const r = validateMergeConvergence({
      filePath: 'apps/cli/skills/standard/x.SKILL.md',
      originalContent: 'abc',
      newContent: 'abcd',
      merge: true,
    })
    expect(r).not.toBeNull()
    expect(r!).toContain('字节数')
  })
})
```

import 加 `validateMergeConvergence,`。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/cli && pnpm vitest run test/core/crsi-sandbox.test.ts -t validateMergeConvergence
```

Expected: FAIL —— `validateMergeConvergence is not a function`。

- [ ] **Step 3: 写实现**

```ts
/**
 * 合并型提案的收敛闸（B_H）。**零写死常数** —— 它不设上界，只要求「合并这件事本身别把
 * 脚手架抬高」。RSIH 的 ‖H‖≤B_H 需要一个数，是因为它必须允许学到上界、到顶再强制合并；
 * 本仓已有 dedup 那一半（教训按 `## category: title` 幂等、规则按 id 幂等），
 * 缺的只是另一半，而那一半不需要数：**闸只在「试图整合」那一刻开火**。
 *
 * 返回拒绝理由，合法时返回 null（同 validateBlastRadius 的签名）。
 */
export function validateMergeConvergence(proposal: {
  filePath?: string
  originalContent?: string
  newContent?: string
  merge?: boolean
}): string | null {
  if (proposal.merge !== true) return null
  // 无基线不是有增长：手工路径在文件不存在时正是这个形态（commands.ts 的宽松模式）。
  if (!proposal.originalContent || !proposal.newContent) return null

  const filePath = proposal.filePath ?? ''
  const before = measureScaffold(filePath, proposal.originalContent)
  const after = measureScaffold(filePath, proposal.newContent)

  const rose: string[] = []
  if (after.lessons > before.lessons) rose.push(`教训段数 ${before.lessons} → ${after.lessons}`)
  if (after.rules > before.rules) rose.push(`规则条数 ${before.rules} → ${after.rules}`)
  if (after.bytes > before.bytes) rose.push(`字节数 ${before.bytes} → ${after.bytes}`)
  if (rose.length === 0) return null

  return `合并型提案必须收敛，但脚手架增长了：${rose.join('；')}。`
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/cli && pnpm vitest run test/core/crsi-sandbox.test.ts
```

Expected: PASS。

- [ ] **Step 5: 负控 N7 —— 证明「无基线不拦」这条判据不是装饰**

```bash
cd apps/cli && cp src/core/crsi-sandbox.ts /tmp/n7-backup.ts && shasum -a 256 src/core/crsi-sandbox.ts
```

把 `if (!proposal.originalContent || !proposal.newContent) return null` 删掉，跑：

```bash
cd apps/cli && pnpm vitest run test/core/crsi-sandbox.test.ts -t validateMergeConvergence
```

Expected: **FAIL** —— `无基线（空串 / undefined）→ 不拦` 这 1 条红（`measureScaffold('', ...)` 把空基线读成 0 段 ⇒ 任何合并都被判「增长」）。

`cp` 还原、核 sha 相同。

- [ ] **Step 6: 提交**

```bash
cd apps/cli && git add src/core/crsi-sandbox.ts test/core/crsi-sandbox.test.ts
git commit -m "feat(crsi): 加 validateMergeConvergence 合并型收敛闸

零写死常数：不设上界，只要求合并本身别把脚手架抬高。只对
merge===true 生效（学习本身就是增长，对新增型开火 = 禁掉
/crsi propose）。无基线不拦。负控 N7 ⇒ 1 条红。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 9: 把闸接进 `runCrsiModification`，crossover 声明 `merge: true`

**Files:**

- Modify: `apps/cli/src/core/crsi-modify.ts`（`CrsiProposal` :21-39；`runCrsiModification` :54-73）
- Modify: `apps/cli/src/core/crsi-producer.ts`（`produceCrossoverProposal` 返回类型 :579-586、返回对象 :604-610）
- Test: `apps/cli/test/core/crsi-modify.test.ts`、`apps/cli/test/core/crsi-producer-crossover.test.ts`

**Interfaces:**

- Consumes: `validateMergeConvergence`（Task 8）
- Produces: `CrsiProposal.merge?: boolean`；`produceCrossoverProposal` 的返回类型加 `merge: boolean`

- [ ] **Step 1: 写失败的测试（三处，各落在它真正该在的地方）**

**(a) 编排层 fail-closed** —— 加进 `apps/cli/test/core/crsi-modify.test.ts` 的 `describe('runCrsiModification')`（`:36`）末尾：

```ts
it('合并型净增被 fail-closed 拒绝，且不创建 worktree（收敛闸）', async () => {
  const sandbox = new CrsiSandbox(process.cwd())
  const result = await runCrsiModification(
    {
      description: 'grow',
      filePath: LESSONS_FILE,
      originalContent: '## a: 1\n',
      newContent: '## a: 1\n\n## b: 2\n',
      blastRadius: [LESSONS_FILE],
      merge: true,
    },
    sandbox,
  )
  expect(result.applied).toBe(false)
  expect(result.phase).toBe('failed')
  expect(result.error).toContain('必须收敛')
  // 闸在 createWorktree 之前 —— 零副作用，故根本没有 worktree 可 diff。
  //（getDiff 在 worktreePath 为空时返回 ''，不是抛错。）
  expect(sandbox.getDiff()).toBe('')
})
```

import 行 `:5` 改为 `import { CrsiSandbox } from '../../src/core/crsi-sandbox'` 不变；另加 `import { LESSONS_FILE } from '../../src/core/crsi-producer'`。

**刻意不写「merge 未声明的净增照常放行」这条编排层用例** —— 它要真去建 worktree、跑全量测试（该文件 `:53` 那条就是这个代价）。该行为已由两处更便宜的判据覆盖：Task 8 的 `merge !== true → 不拦` 纯函数用例，与 Task 10 的 `merge-convergence-gate` 契约第三支。三条判据里只有编排层这一条必须真跑，因为只有它证明「闸接上了」。

**(b) producer 侧声明** —— 加进 `apps/cli/test/core/crsi-producer-crossover.test.ts` 既有的 `产出删二增一的教训变更候选`（`:117-129`）用例，**不另起新用例、不另造 LLM mock** —— 该文件已有 `HEADER_A`/`HEADER_B`/`LESSONS`/`JSON_RESULT` 夹具，用它们才是在测真路径：

```ts
expect(p!.merge).toBe(true)
```

**(c) 类型面** —— 加进 `apps/cli/test/core/crsi-modify.test.ts`（Task 4 已建的那个 describe 里补一行）：

```ts
const merged: CrsiProposal = { ...bare, merge: true }
expect(merged.merge).toBe(true)
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/cli && pnpm vitest run test/core/crsi-modify.test.ts -t 收敛闸
```

Expected: FAIL —— `result.error` 不含「必须收敛」（闸还没接，`result.phase` 会是别的值）。

```bash
cd apps/cli && pnpm vitest run test/core/crsi-producer-crossover.test.ts
```

Expected: FAIL —— `p!.merge` 为 `undefined`。**顺带确认**：该文件既有的 5 条 `produceCrossoverProposal` 用例此刻**全绿**（闸未接），这是「负控前的基线」。`titleA === titleB` 那条 (`:148`) 在 `return null` 处早退、根本不进闸，故不受影响。

- [ ] **Step 3: 加 `merge` 字段**

`crsi-modify.ts` 的 `CrsiProposal` 里，`risk` 之后加：

```ts
  /**
   * 声明这是一次**合并型**提案（整合已有内容，而非新增）。
   * 只有它为 true 时 `validateMergeConvergence` 才开火 —— 学习本身就是增长，
   * 对新增型设非增长约束等于永久禁掉 `/crsi propose`。
   */
  merge?: boolean
```

- [ ] **Step 4: 在 `runCrsiModification` 里插闸**

在 blast-radius 拒绝块（`:56-71`）之后、`sandbox.createWorktree()`（`:73`）之前插入：

```ts
// B_H 收敛闸：合并型提案不得抬高脚手架成本。
// 位置与 blast radius 闸同序 —— 都在 worktree 之前，纯字符串比较、零磁盘 I/O、零副作用。
const convergenceError = validateMergeConvergence(proposal)
if (convergenceError) {
  return {
    modification: {
      id: 'crsi-mod-rejected-merge-convergence',
      description: proposal.description,
      filePath: proposal.filePath,
      newContent: proposal.newContent,
      originalContent: proposal.originalContent ?? '',
      crsiInsightId: proposal.crsiInsightId,
      timestamp: new Date().toISOString(),
    },
    applied: false,
    phase: 'failed',
    error: convergenceError,
  }
}
```

import 加 `validateMergeConvergence`（`:16` 那行改为 `import { CrsiSandbox, validateBlastRadius, validateMergeConvergence } from './crsi-sandbox'`）。

- [ ] **Step 5: crossover 声明 `merge: true`**

`crsi-producer.ts` 的 `produceCrossoverProposal`：返回类型里加 `merge: boolean`（`blastRadius: string[]` 之后），并在 `:604-610` 的返回对象里加 `merge: true,`。

- [ ] **Step 6: 跑测试确认通过**

```bash
cd apps/cli && pnpm typecheck && pnpm vitest run test/core/crsi-modify.test.ts test/core/crsi-producer-crossover.test.ts
```

Expected: PASS。**重点复核 crossover 的既有用例**：`产出删二增一的教训变更候选` 现在的产物会经过收敛闸 —— 原文件 2 条教训、新内容 1 条合并段 ⇒ `1 ≤ 2` 通过。这条是**正控**：闸没有把该放行的合并拦掉。若它变红，说明 `measureScaffold` 数错了单位（去查 `^## ` 口径是否与 `removeLessonSections` 一致）。

- [ ] **Step 7: 负控 N5 / N6 / N8 —— 三条，红集两两不同**

```bash
cd apps/cli && cp src/core/crsi-sandbox.ts /tmp/n568-sandbox.ts && cp src/core/crsi-modify.ts /tmp/n568-modify.ts && shasum -a 256 src/core/crsi-sandbox.ts src/core/crsi-modify.ts
```

**N5（编排层 · 恒放行）**：在 `validateMergeConvergence` 函数体第一行插 `return null`。

```bash
cd apps/cli && pnpm vitest run test/core/crsi-modify.test.ts -t 收敛闸
```

Expected: **FAIL**，红集 = `合并型净增被 fail-closed 拒绝` 这 **1 条**。`cp` 还原 `/tmp/n568-sandbox.ts`。

**N6（度量层 · 计数口径）**：把 `measureScaffold` 教训分支的 `l.startsWith('## ')` 改成 `l.startsWith('#')`。

```bash
cd apps/cli && pnpm vitest run test/core/crsi-sandbox.test.ts -t measureScaffold
```

Expected: **FAIL**，红集 = `### 不算一段` 这 **1 条**。`cp` 还原。

**N8（判据分支 · 撤掉 merge 判断）**：把 `if (proposal.merge !== true) return null` 整行删掉。

```bash
cd apps/cli && pnpm vitest run test/core/crsi-sandbox.test.ts -t validateMergeConvergence
```

Expected: **FAIL**，红集 = `merge !== true → 不拦` 这 **1 条**。

三条红集**互不相同**（N5 编排层 / N6 度量层 / N8 判据分支）。逐个 `cp` 还原后核 sha256 与改前逐一相同。

- [ ] **Step 8: 提交**

```bash
cd apps/cli && git add src/core/crsi-sandbox.ts src/core/crsi-modify.ts src/core/crsi-producer.ts test/core/crsi-modify.test.ts test/core/crsi-producer-crossover.test.ts
git commit -m "feat(crsi): 收敛闸接进编排，crossover 声明 merge

闸与 blast radius 闸同序，都在 createWorktree 之前（零副作用）。
produceCrossoverProposal 置 merge:true —— 它本就有 titleA/titleB，
无需从字符串推断。既有「删二增一」用例是正控。
负控 N5/N6/N8 红集两两不同（编排层 / 度量层 / 判据分支）。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 10: eval 契约 `merge-convergence-gate` + 计数回填

**Files:**

- Modify: `apps/cli/src/core/eval-harness.ts`（import；契约；`ANCHOR_CONTRACT_IDS`）
- Modify: `apps/cli/test/core/eval-harness.test.ts`（`39` → `40`）
- Modify: `CLAUDE.md` + `docs/claude-md-history.md`

**Interfaces:**

- Consumes: `validateMergeConvergence`（Task 8）、`LESSONS_FILE`（既有 import 需补）
- Produces: 契约 id `merge-convergence-gate`（anchor）

- [ ] **Step 1: 改计数断言**

`eval-harness.test.ts` 的 `39` → `40`（三处）。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/cli && pnpm vitest run test/core/eval-harness.test.ts
```

Expected: FAIL —— `expected 39 to be 40`。

- [ ] **Step 3: 加契约**

`eval-harness.ts`：

- `:24` 那行的 crsi-sandbox import 加 `validateMergeConvergence`
- `:25-30` 那段的 crsi-producer import 加 `LESSONS_FILE`

在 `prediction-hit-truth-table` 契约之后插入：

```ts
// ── B_H 合并型收敛闸（ground truth：净增被拒、删二增一通过、非合并型不受此闸） ──
results.push({
  id: 'merge-convergence-gate',
  description: '合并型净增被拒、删二增一通过、merge 未声明的净增放行',
  passed:
    validateMergeConvergence({
      filePath: LESSONS_FILE,
      originalContent: '## a: 1\n\n## b: 2\n',
      newContent: '## a: 1\n\n## b: 2\n\n## c: 3\n',
      merge: true,
    }) !== null &&
    validateMergeConvergence({
      filePath: LESSONS_FILE,
      originalContent: '## a: 1\n\n## b: 2\n',
      newContent: '## ab: merged\n',
      merge: true,
    }) === null &&
    validateMergeConvergence({
      filePath: LESSONS_FILE,
      originalContent: '## a: 1\n',
      newContent: '## a: 1\n\n## b: 2\n',
      merge: false,
    }) === null,
})
```

并在 `ANCHOR_CONTRACT_IDS` 里加 `'merge-convergence-gate',`。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/cli && pnpm vitest run test/core/eval-harness.test.ts
```

Expected: PASS（40/40，score 100）。

- [ ] **Step 5: 用命令产出真值，回填文档**

与 Task 6 Step 5 同一套：`cd apps/cli && pnpm test 2>&1 | tail -25`，读真值，改 `CLAUDE.md` 的 `:319` / `:299` / `:85` / `:111`，然后：

```bash
cd /Users/sarvadaya/Rismed_Ronxin_Capital/One_Mipham_Corporation/mipham-code && wc -m CLAUDE.md
```

必须 ≤ 40,000。

- [ ] **Step 6: 回填 `最后更新` + 修订历史窗口**

同 Task 6 Step 6（挤掉第 6 行、逐字移入 `docs/claude-md-history.md`）。

- [ ] **Step 7: 提交**

```bash
cd apps/cli && git add src/core/eval-harness.ts test/core/eval-harness.test.ts
cd /Users/sarvadaya/Rismed_Ronxin_Capital/One_Mipham_Corporation/mipham-code && git add CLAUDE.md docs/claude-md-history.md
git commit -m "test(crsi): 加 merge-convergence-gate 契约（39 → 40，anchor 16 → 17）

新的闸自己也被闸保护。同提交回填活文档计数。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

# 提交 ③ — anchor 契约守卫（重版：真两向）

## Task 11: 把真源移到契约定义处

**Files:**

- Modify: `apps/cli/src/core/eval-harness.ts`（`EvalResult` :39-46；**17 处契约内联**；回填 :352-355）

**Interfaces:**

- Consumes: 既有 `ANCHOR_CONTRACT_IDS`（15 → 17 条）
- Produces: `EvalResult.anchor?: true`

**为什么值得改 17 处**：`ANCHOR_CONTRACT_IDS` 全仓库只有两处引用 —— 定义（`:58`）与回填（`:354`）。把 `'blast-radius-gate'` 敲成 `'blast-radius-gates'`，那张契约仍会跑、仍会 FAIL，但**不再是 anchor**，`regressedAnchors` 对它视而不见 ⇒ 一处安全不变量被静默降级为普通契约，全套测试与 CI 依旧全绿。

- [ ] **Step 1: 加字段**

`EvalResult` 里 `role?: ContractRole` 之后加：

```ts
  /**
   * anchor 契约的**定义处真源**。`role` 由此派生（见 runEval 末尾的回填）。
   * `ANCHOR_CONTRACT_IDS` 退为**独立声明**，两者由 test/integrity/anchor-contract-wiring
   * 守卫两向比对 —— 两处独立陈述同一件事，它们才可能不一致，守卫才有内容。
   */
  anchor?: true
```

- [ ] **Step 2: 在 15 处 push 点内联 `anchor: true`（覆盖 17 个 id）**

逐处加（**每处都在同一对象字面量内**，缩进与邻键一致）：

> ⚠️ **下表行号是本批改动前的读数。** Tasks 6 与 10 已在 `:346`（`self-report-diagnostic`）之前插入两条契约 ⇒ 该点之后的原有行号整体下移约 20 行。**定位请以 `id: '<契约 id>'` 字符串为准，不要以行号为准** —— 按行号改会写到邻键上去，而那种改动往往仍能 typecheck 通过。

| #   | 契约 id                                                    | 位置（改动前）                             |
| --- | ---------------------------------------------------------- | ------------------------------------------ |
| 1   | `rule-timeout`                                             | `:146-150`                                 |
| 2   | `rule-git-force`                                           | `:156-160`                                 |
| 3   | `rule-disabled-skip`                                       | `:173-177`                                 |
| 4   | `constitution-8-principles`                                | `:181-185`                                 |
| 5   | `constitution-facets`                                      | `:190-194`                                 |
| 6   | `constitution-preamble`                                    | `:196-200`                                 |
| 7   | `sandbox-protected-constitution` / `-tests` / `-machinery` | `:208-210`（**循环体一处，覆盖 3 个 id**） |
| 8   | `protection-completeness`                                  | `:214-219`                                 |
| 9   | `blast-radius-gate`                                        | `:222-229`                                 |
| 10  | `red-team-zero-gaps`                                       | `:233-238`                                 |
| 11  | `producer-rule-shape`                                      | `:249-258`                                 |
| 12  | `producer-rule-idempotent`                                 | `:260-265`                                 |
| 13  | `self-report-diagnostic`                                   | `:346-350`                                 |
| 14  | `merge-convergence-gate`                                   | Task 10 加的                               |
| 15  | `prediction-hit-truth-table`                               | Task 10/6 加的                             |

共 **15 处内联**，覆盖 **17 个 id**。例（第 1 处）：

```ts
results.push({
  id: 'rule-timeout',
  description: '内置 timeout 规则命中低超时的 npm install',
  passed: timeout.modified.timeout === 300000,
  anchor: true,
})
```

循环体那处（第 7 项）：

```ts
for (const [id, path] of protectedChecks) {
  results.push({
    id,
    description: `受保护路径被拒: ${path}`,
    passed: isProtectedPath(path),
    anchor: true,
  })
}
```

**注意 `anchor-gate`（`:359`）本身不是 anchor** —— 它是自检契约，不进内联、不进声明表。

- [ ] **Step 3: 回填改为从内联标记派生**

把 `:352-355` 换成：

```ts
// 角色标注：anchor 由契约**定义处内联的标记**派生（真源），
// ANCHOR_CONTRACT_IDS 退为独立声明 —— 两者由 anchor-contract-wiring 守卫两向比对。
for (const r of results) {
  if (r.anchor) r.role = 'anchor'
}
```

- [ ] **Step 4: 验证既有断言全部仍绿**

```bash
cd apps/cli && pnpm vitest run test/core/eval-harness.test.ts test/core/crsi-modify.test.ts
```

Expected: PASS。**重点**：`eval-harness.test.ts:83-91` 断言 `self-report-diagnostic` 的 `role === 'anchor'` —— 派生路径换了但结论必须不变，这条正是「改真源没改语义」的活证据。`getDiff`/anchor 回归闸相关的用例同理。

- [ ] **Step 5: 提交**

```bash
cd apps/cli && git add src/core/eval-harness.ts
git commit -m "refactor(crsi): anchor 真源移进契约定义处（17 处内联）

ANCHOR_CONTRACT_IDS 退为独立声明。此前它既是声明又是唯一真源，
把 id 敲错一处 ⇒ 安全不变量被静默降级成普通契约，全套测试与 CI
依旧全绿。role 改由内联标记派生，role 的既有语义不变。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 12: anchor 两向守卫 + 判据负控

**Files:**

- Create: `apps/cli/test/integrity/anchor-contract-wiring.test.ts`
- Test: 本体

**Interfaces:**

- Consumes: `runEval`、`ANCHOR_CONTRACT_IDS`（`eval-harness.ts`）
- Produces: 无导出符号（守卫测试）

- [ ] **Step 1: 写守卫**

```ts
/**
 * anchor 契约守卫 —— 两向派生。
 *
 * 真源在 `eval-harness.ts` 每个契约的**定义处**（内联 `anchor: true`）；
 * `ANCHOR_CONTRACT_IDS` 是**独立声明**。两处独立陈述同一件事 ⇒ 它们可能不一致 ⇒
 * 本守卫才有内容。
 *
 * 只做一向（声明 → 产出）交付的是**一半**：抓得到拼错与删除，抓不到
 * 「新加的安全契约忘了进表」。第二向覆盖的正是这条路径 ——
 * `red-team-zero-gaps` 与 `blast-radius-gate` 当初都是这样加进来的。
 */
import { describe, it, expect } from 'vitest'
import { runEval, ANCHOR_CONTRACT_IDS } from '../../src/core/eval-harness'

/**
 * 判据本体。返回不一致的描述（排序后），一致时返回空数组。
 *
 * 抽成函数是为了让负控能**跑同一条判据** —— 否则「负控」会变成另写一个
 * 更容易失败的比较，证明不了本判据能失败。
 */
function anchorSetMismatch(declared: string[], inlined: string[]): string[] {
  const d = new Set(declared)
  const i = new Set(inlined)
  return [
    ...[...d].filter((x) => !i.has(x)).map((x) => `声明未内联: ${x}`),
    ...[...i].filter((x) => !d.has(x)).map((x) => `内联未声明: ${x}`),
  ].sort()
}

function inlinedAnchorIds(): string[] {
  return runEval()
    .results.filter((r) => r.anchor)
    .map((r) => r.id)
}

describe('anchor 契约接线', () => {
  it('声明集与内联集两向相等', () => {
    expect(anchorSetMismatch([...ANCHOR_CONTRACT_IDS], inlinedAnchorIds())).toEqual([])
  })

  it('每个声明的 id 都真的出现在 runEval 的产出里', () => {
    const produced = new Set(runEval().results.map((r) => r.id))
    expect([...ANCHOR_CONTRACT_IDS].filter((id) => !produced.has(id))).toEqual([])
  })

  it('空转守卫：集合被清空或抽取失效后不得静默全绿', () => {
    // 若抽取判据写错（如 r.anchor 恒 undefined），上面两条会「两边都空」而全绿。
    // 取 ≥15 而非 ==17：让后续新增 anchor 不必回来改这个数。
    expect(inlinedAnchorIds().length).toBeGreaterThanOrEqual(15)
  })

  it('判据能失败（负控）：把一个 id 拼错会被抓出两条', () => {
    const declared = [...ANCHOR_CONTRACT_IDS]
    const inlined = inlinedAnchorIds()
    // 正控：真实集合 → 一致
    expect(anchorSetMismatch(declared, inlined)).toEqual([])
    // 负控：把声明里的 'blast-radius-gate' 敲成 'blast-radius-gates'
    //（正是本守卫存在的理由 —— 这张契约仍会跑、仍会 FAIL，但已不再是 anchor）
    const typo = declared.map((x) => (x === 'blast-radius-gate' ? 'blast-radius-gates' : x))
    expect(anchorSetMismatch(typo, inlined)).toEqual([
      '内联未声明: blast-radius-gate',
      '声明未内联: blast-radius-gates',
    ])
  })
})
```

**无需 `vi.mock('node:os')`**：`runEval()` 只往 `tmpdir()` 下写隔离组件，不碰 `homedir()`（`appendEvalScore`/`getLastEvalScore` 才碰，而 `runEval` 不调用它们）。这一点是刻意的，不是漏了。

- [ ] **Step 2: 跑守卫**

```bash
cd apps/cli && pnpm vitest run test/integrity/anchor-contract-wiring.test.ts
```

Expected: PASS（4 条）。

- [ ] **Step 3: 负控 N1 —— 从声明里删一个 id**

```bash
cd apps/cli && cp src/core/eval-harness.ts /tmp/n1-backup.ts && shasum -a 256 src/core/eval-harness.ts
```

从 `ANCHOR_CONTRACT_IDS` 删掉 `'blast-radius-gate',`（内联仍在），跑：

```bash
cd apps/cli && pnpm vitest run test/integrity/anchor-contract-wiring.test.ts
```

Expected: **FAIL** —— 两条红（`两向相等` + `判据能失败` 的正控半边）。**红集**：与 N2 不同。

- [ ] **Step 4: 负控 N2 —— 去掉一处内联**

`cp` 还原、核 sha。再把 `blast-radius-gate` 那处 `anchor: true,` 删掉（声明仍在），跑同一守卫。

Expected: **FAIL**。**红集与 N1 相同吗？** 必须核：N1 是「声明多、内联少」，N2 是「内联少、声明多」—— 若两者红的是**同一组**测试，说明判据只在一向有效，需回头查 `anchorSetMismatch` 的两条 filter 是否真的都在跑。

`cp` 还原、核 sha 与改前相同。

- [ ] **Step 5: 全量回归**

```bash
cd apps/cli && pnpm test 2>&1 | tail -25
```

Expected: **0 失败**。用真值回填 `CLAUDE.md` 计数（同 Task 6 Step 5）与修订历史窗口行。

```bash
cd apps/cli && pnpm typecheck && pnpm lint
cd /Users/sarvadaya/Rismed_Ronxin_Capital/One_Mipham_Corporation/mipham-code && wc -m CLAUDE.md
```

Expected: 无错；`CLAUDE.md` ≤ 40,000。

- [ ] **Step 6: 提交**

```bash
cd apps/cli && git add test/integrity/anchor-contract-wiring.test.ts
cd /Users/sarvadaya/Rismed_Ronxin_Capital/One_Mipham_Corporation/mipham-code && git add CLAUDE.md docs/claude-md-history.md
git commit -m "test(integrity): anchor 契约两向守卫 + 判据负控

声明集与内联集两向相等；声明的 id 必须真在产出里；≥15 空转守卫。
负控把 'blast-radius-gate' 敲成 'blast-radius-gates' 跑同一条判据
⇒ 报出「一缺一多」两条，证明判据能失败。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## 收尾核对（全部提交之后）

- [ ] **契约账**：`runEval().total === 40`、`ANCHOR_CONTRACT_IDS.size === 17`、`regressedAnchors([]) === []`、`score === 100`。
  ```bash
  cd apps/cli && pnpm vitest run test/core/eval-harness.test.ts test/integrity/anchor-contract-wiring.test.ts
  ```
- [ ] **全量**：`cd apps/cli && pnpm test` → 0 失败（**必须在本目录跑**）。
- [ ] **门禁**：`pnpm typecheck && pnpm lint && pnpm format`（`format` 只在 `apps/cli` 内跑）。
- [ ] **文档数字**：`grep -n "2891" CLAUDE.md` 应**零命中**（旧值全部换成真值）。这是「同提交回填」的机械判据。
- [ ] **CLAUDE.md 预算**：`wc -m CLAUDE.md` ≤ 40,000。
- [ ] **父仓 gitlink**：三个提交都在 `mipham-code` 子仓内。父仓是否 bump 由用户裁定（默认裁定是**不单独 bump**），**本计划不做**。
- [ ] **负控台账**：N1/N2（anchor 两向）、N3（命中判据）、N5/N6（编排层 vs 度量层）、N7（无基线）、N9（兜底侧）—— 逐个记下红集，确认两两不同，连同 `cp` + `sha256` 的还原证据，写进提交说明或交接备忘。
