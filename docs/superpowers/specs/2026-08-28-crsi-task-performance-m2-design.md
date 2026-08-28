# CRSI 任务表现评估 M2（skill 注入 + safe-coding 试点）设计

> **日期**: 2026-08-28
> **作者**: Guohua Zhang · One Mipham Corporation
> **术语**: A1 铁律 = 绝不拿 LLM 当裁判；任务表现 = AI 在冻结任务上的编码质量（测试过没过）；skill 注入 = 把 skill 正文作为 systemPrompt 喂给 LLM；改进信号 = before/after 的分数 delta
> **前情**: 承接 [[2026-08-27-crsi-task-performance-design]]（M1 已落地，6 commits 推 main）

---

## 一、背景与动机

M1 交付了独立基准器（`task-performance.ts` + 5 个冻结任务 + `/crsi bench`），但它测的是**通用算法**（quicksort/fibonacci/…），改一份 skill 散文几乎不可能改变 LLM「能不能写对 quicksort」——`delta 恒为 0` 正是 M1 spec 风险 #1 亲口警告会「以新面孔回来」的问题。

M2 的目标是造出**随 skill 改动而变的信号**。关键前提：任务必须对 skill 内容敏感。本 spec 落地「skill 注入 + 一个能冻结成确定性测试的 skill 试点」，先独立验证「改 skill → 分数变」的 delta 真实存在，**暂不接进 `runCrsiModification`**（standalone-first）。

---

## 二、目标与非目标

**目标**：

1. 给评估器加 skill 注入能力：`runTaskPerformance` 支持把 skill 正文作为 `systemPrompt` 喂给 LLM。
2. 造一个「规则能冻结成确定性测试」的 skill（`safe-coding`）+ 一个绑定该 skill 的任务。
3. 提供 `bench --skill` 入口，手动验证「弱 skill → fail、强 skill → pass」的 delta 真实非零。

**非目标**：

- ❌ 接进 `runCrsiModification`（before/after 自动接线）——**M2b**，等 delta 被证明真实后另立计划。
- ❌ 用 LLM 当裁判（A1 不破）——判定仍是冻结测试的确定性 pass/fail。
- ❌ 实现「因果归因 / 最小效应量」——仍是 promotion-gate 的后续。
- ❌ 给**所有** skill 都造任务——本 spec 只做一个试点 skill，验证机制。

---

## 三、核心设计

### 3.1 skill 注入（改 `task-performance.ts`）

`runTaskPerformance` 签名扩展：

```typescript
runTaskPerformance(
  llm: Llm,
  opts?: { timeoutMs?: number; skill?: { name: string; text: string } },
): Promise<TaskPerformanceReport>
```

- `skill.text` 注入为 `ChatRequest.systemPrompt`（skill 是指令，不是用户输入；`ChatRequest` 已有 `systemPrompt` 字段）。
- 无 `skill` 时行为不变（M1 通用基准）。

### 3.2 任务与 skill 的绑定（改 schema）

`PerformanceTask` 加可选字段 `skill?: string`：

```jsonc
{
  "id": "perf-safe-parse-positive",
  "category": "test-driven",
  "skill": "safe-coding", // 绑定被测 skill 的名字（= skill frontmatter name）
  "prompt": "…",
  "testCode": "…",
}
```

`runTaskPerformance` 按 skill 过滤任务：

```typescript
const wanted = opts?.skill?.name
const tasks = loadPerformanceTasks().filter((t) => (t.skill ?? undefined) === wanted)
```

- 无 `skill` → 只跑无 `skill` 字段的通用任务（M1 行为不变，5 个算法任务）。
- `skill: { name: 'safe-coding', text }` → 只跑 `skill: 'safe-coding'` 的任务，注入该 skill 正文。

### 3.3 safe-coding skill（新文件，真实进产品）

`apps/cli/skills/standard/safe-coding.SKILL.md`，含一条**能冻结成确定性测试**的具体规则：

> 处理外部/用户输入前必须校验：`null`、`undefined`、空字符串、格式非法时，抛出 `RangeError`，消息为 `'invalid input'`。

选这条规则的依据（见 §八风险 1）：它是**行为规则**（不是流程清单），能映射成 `bun test` 的确定性断言；且「抛 `RangeError` 这一**具体类型** + 拒空字符串」是 LLM 不读规则时几乎不会自然匹配的行为，保证弱/强两版分数差真实。

### 3.4 safe-coding 任务（改 `task-performance-tasks.json`）

新增 1 个任务：

```jsonc
{
  "id": "perf-safe-parse-positive",
  "category": "test-driven",
  "skill": "safe-coding",
  "prompt": "实现并导出 parsePositiveNumber 函数：export function parsePositiveNumber(input: string): number。只输出 TypeScript 代码，不要解释、不要 markdown 代码块。",
  "testCode": "import { test, expect } from 'bun:test'\nimport { parsePositiveNumber } from './solution'\n\ntest('rejects invalid input', () => {\n  expect(() => parsePositiveNumber(null as any)).toThrow(RangeError)\n  expect(() => parsePositiveNumber('')).toThrow(RangeError)\n  expect(() => parsePositiveNumber('abc')).toThrow(RangeError)\n})\ntest('parses valid', () => {\n  expect(parsePositiveNumber('42')).toBe(42)\n})\n",
}
```

判定沿用 M1 的 `judgeGeneratedCode`（子进程 `bun test`，exit 0 = pass），A1 铁律不变。

### 3.5 bench 入口（改 `ui/commands.ts`）

`/crsi bench [--skill <name>]`：

- 无 `--skill` → 现有行为（通用基准）。
- `--skill safe-coding` → 经 `SkillsLoader.get('safe-coding').body` 读 skill 正文 → `runTaskPerformance(llm, { skill: { name, text } })`。

---

## 四、数据流（standalone-first）

```
/crsi bench --skill safe-coding
  → SkillsLoader.get('safe-coding').body            # 读 skill 正文
  → runTaskPerformance(ctx.llm, { skill: {name, text} })
      ├─ 过滤出 skill === 'safe-coding' 的任务
      ├─ 逐任务：llm.chat(prompt, systemPrompt=text) → 生成代码 → 子进程跑冻结测试 → pass/fail
      └─ score = passed / total
```

**delta 验证（手动，需真实 LLM）**：

```
弱版 skill（无校验规则，一次性字符串）  → runTaskPerformance → 期望 fail（低分）
强版 skill（= safe-coding.SKILL.md）    → runTaskPerformance → 期望 pass（高分）
delta = 强 - 弱 > 0  → 机制验证通过
```

---

## 五、里程碑

| 里程碑  | 内容                                                  | 交付物                     |
| ------- | ----------------------------------------------------- | -------------------------- |
| **M2**  | skill 注入 + safe-coding skill + 任务 + bench --skill | delta 手动验证非零         |
| **M2b** | before/after 接进 `runCrsiModification`               | 自动 delta 信号 → 因果归因 |

M2 是本次 spec 的完整实现范围。M2b 依赖「如何识别 proposal 改的是 skill / 如何匹配任务集」的设计，另立计划。

---

## 六、测试

- **注入 plumbing**：mock `Llm` 捕获 `ChatRequest`，断言传入 `skill.text` 时 `systemPrompt` = skill 正文；无 skill 时无 `systemPrompt`。
- **任务过滤**：`runTaskPerformance` 无 skill 只跑通用任务；`skill: {name:'safe-coding'}` 只跑 safe-coding 任务。
- **冻结测试正确性**：`judgeGeneratedCode` 对「不校验输入的代码」判 fail（`toThrow(RangeError)` 不满足）、对「正确校验的代码」判 pass。
- **（手动，真实 LLM）delta**：弱 skill → fail、强 skill → pass。

---

## 七、风险与开放问题

1. **【残余噪声】温度 0 仍有余噪**：强模型不读 skill 时，也可能偶然写对校验。这是 M1 spec 风险 #2 的延续——「改进」判定需要最小效应阈值，属 M2b/后续（最小效应量前置），本 spec 只验证「存在非零 delta」。
2. **【关键，仍在】任务相关性对其它 skill 未解决**：本 spec 只解决 safe-coding 一个 skill。大多数 skill（tdd/code-review/…）是流程/清单类，规则无法冻结成确定性测试（需要 LLM 裁判 → A1 禁止）。这是「先跑通」清单的核心遗留项，回访触发 = safe-coding 试点跑通后。
3. **【成本】每次 delta = 2 次 LLM 调用**（弱+强）。试点单任务，成本可忽略；扩容任务集时重估。
4. **【开放】safe-coding 作为产品 skill 的定位**：本 spec 为验证机制把它做成真实 skill；但它与现有 `security-review`（审代码）的边界、是否值得独立成「生成规范」技能，跑通后需复审。

---

## 八、决策记录（岔路口）

| #   | 岔路口                       | 选项                                                  | 选了 | 为何（否决项理由）                                                      | 推迟的（先跑通）                          | 回访触发           |
| --- | ---------------------------- | ----------------------------------------------------- | ---- | ----------------------------------------------------------------------- | ----------------------------------------- | ------------------ |
| 1   | 任务相关性怎么破             | A 自造 safe-coding / B 复用 tdd 确定性 / C 盘点后暂缓 | A    | B 的「确定性」规则 delta 弱（现代模型默认就不写 Math.random）；C 无产出 | 任务池扩容 + 其它 skill 相关性            | safe-coding 跑通后 |
| 2   | skill 注入通道               | A systemPrompt / B 拼进 user prompt                   | A    | skill 是指令非用户输入；`ChatRequest.systemPrompt` 现成字段             | —                                         | —                  |
| 3   | M2 范围                      | A standalone-first / B 一步到位接线                   | A    | B 要动自修改 seam（安全敏感），先证明 delta 真实再接线，风险可控        | M2b before/after 接进 runCrsiModification | delta 验证非零后   |
| 4   | 试点 skill 性质              | A 真实进产品 / B test fixture                         | A    | 「安全编码」生成规范对产品真有用；不造 throwaway                        | skill 定位复审（与 security-review 边界） | 跑通后             |
| 5   | 任务过滤语义                 | A 按 skill 名过滤 / B 全量注入                        | A    | 全量注入会让通用任务吃到无关 skill 正文                                 | 多 skill 任务集                           | 加第二个 skill 时  |
| 6   | M2b 怎么识别「改的是 skill」 | 未定                                                  | —    | —                                                                       | 文件路径→skill 匹配、任务集选择           | M2b 启动时单独设计 |

---

## Self-Review 记录

- **A1 边界**：skill 注入只是给 LLM 更多上下文（LLM 仍是被测试对象），判定仍是冻结测试确定性 pass/fail（§3.4），一分不破。
- **standalone-first 的诚实边界**：M2 验证的是「skill 注入 + delta 计算」这条**管道**是否 work，不是「CRSI 真的自我改进了」——后者需要真实 skill 进化 + 因果归因（M2b/后续）。
- **任务相关性**：只解决 safe-coding 一个试点，不假装覆盖所有 skill（§七风险 2）。
- **无占位符**：schema、skill 内容、任务 JSON、签名均已给出具体值。
