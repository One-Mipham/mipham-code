# CRSI 任务表现评估 M2b（before/after 接线）设计

> **日期**: 2026-08-28
> **作者**: Guohua Zhang · One Mipham Corporation
> **术语**: A1 铁律 = 绝不拿 LLM 当裁判；delta = before/after 任务表现分数差；skill 注入 = skill body 作为 `systemPrompt` 喂给 LLM
> **前情**: 承接 [[2026-08-28-crsi-task-performance-m2-design]]（M2 已落地 + delta 验证通过 = 100）

---

## 一、背景与动机

M2 已证明「改 skill → 分数变」的 delta 真实存在（强 100 / 弱 0）。但 M2 是**独立基准器**（手动跑 `delta-check.ts` 或 `/crsi bench --skill`），还没有接进自改进闭环。

M2b 的目标：当自改进 proposal 修改一个 skill 时，**自动测出 before/after 的任务表现 delta**，作为「改进信号」喂给改进轨（因果归因 / 最小效应量 / 改进率）。这是改进轨的**前置地基**——改进轨的四项都依赖「随 proposal 变化」的信号。

---

## 二、目标与非目标

**目标**：

1. 造一个 `measureSkillDelta`：给定一个改 skill 的 proposal，自动跑 before/after 任务表现，返回 delta。
2. 把 delta 接进 `/crsi modify` 命令，让每次 skill 自改进都附带改进信号。

**非目标**：

- ❌ 改 `runCrsiModification`（保持同步、无 LLM 依赖、纯）——delta 测量在它**外面**做。
- ❌ 实现因果归因 / 最小效应量 / 改进率——那是改进轨，消费本 spec 的 delta。
- ❌ 持久化 delta（logging）——先 return + 显示，改进轨落地时再定持久化。
- ❌ 覆盖外部 skill（`~/.mipham/skills/`）——当前只认内置 `apps/cli/skills/`。

---

## 三、核心设计

### 3.1 `measureSkillDelta`（加到 `core/task-performance.ts`）

```typescript
export interface SkillDelta {
  skillName: string
  baseline: TaskPerformanceReport
  post: TaskPerformanceReport
  delta: number // post.score - baseline.score
}

export async function measureSkillDelta(
  llm: Llm,
  proposal: { filePath: string; originalContent?: string; newContent: string },
): Promise<SkillDelta | null>
```

返回 `null` 当：不是 skill 文件 / 该 skill 无绑定任务集（无可量）。

### 3.2 skill 识别（路径门 + frontmatter 嗅）

- **门**：`filePath` 以 `apps/cli/skills/` 开头，且以 `.SKILL.md` 或 `.mipham-skill.md` 结尾。不满足 → `null`。
- **名**：从 `newContent` frontmatter 嗅 `name:`（canonical 名，对齐任务集的 `skill` 字段）。
- **体**：剥 frontmatter → 取 body（对齐 `SkillDefinition.body`）。
- frontmatter 解析**复用** `loader.ts` 的 `parseFrontmatter`（现为私有，导出它）——它已处理 BOM + YAML，不重写。

### 3.3 before/after 测量

```
baseline text = body(originalContent || readFileSync(filePath))   # 旧 skill
post text     = body(newContent)                                  # 新 skill

guard：无 task.skill === name 的任务 → return null

baseline = runTaskPerformance(llm, { skill: { name, text: baselineText } })
post     = runTaskPerformance(llm, { skill: { name, text: postText } })
delta    = post.score - baseline.score
```

A1 不破：`runTaskPerformance` 仍是「LLM 生成 → 冻结测试判定」，skill 注入只加 `systemPrompt`。

### 3.4 接线 `/crsi modify` 命令（`ui/commands.ts`）

`crsiModifyCmd` 已经是 async，且已经读了 `originalContent`（`readFileSync`）+ 有 `filePath` / `newContent`。新增：

```typescript
const llm = ctx.engine.getLlm() ?? ctx.engine.getRegistry()
const delta = await measureSkillDelta(llm, { filePath, originalContent, newContent })
```

把 `delta`（若非 null）显示在结果里（如「改进信号 delta: +X」）。`runCrsiModification` 调用**零改动**。

### 3.5 成本

每次 before/after = 2 × N 次 LLM 调用（N = 该 skill 的任务数）。当前只有 safe-coding（N=1），即 2 次调用，仅在 proposal 改 skill 且有任务集时触发。

---

## 四、数据流

```
/crsi modify <desc> <filePath> <newContent>
  ├─ 读 originalContent（现有）
  ├─【新】measureSkillDelta(llm, { filePath, originalContent, newContent })
  │     ├─ 路径门 → 不是 skill？ → null
  │     ├─ frontmatter 嗅 name → 无匹配任务集？ → null
  │     └─ baseline(text=旧 body) + post(text=新 body) → delta
  ├─ runCrsiModification(proposal)（现有，sync 不变）
  └─ 结果附带 delta（若非 null）
```

---

## 五、里程碑

| 里程碑  | 内容                                      | 交付物                  |
| ------- | ----------------------------------------- | ----------------------- |
| **M2b** | `measureSkillDelta` + `/crsi modify` 接线 | 改 skill 时自动出 delta |

M2b 是完整范围。改进轨（因果归因等）消费 delta，另立计划。

---

## 六、测试

- **路径门**：非 skill 文件 → `null`；skill 文件 → 非 null（mock llm）。
- **frontmatter 嗅**：`name:` 抽取正确；无 frontmatter 或无名 → `null`。
- **任务集 guard**：skill 无绑定任务 → `null`；有（safe-coding）→ 非 null。
- **delta 计算**：mock llm 返回 pass/fail，`delta = post - baseline` 正确。
- **A1 断言**：判定仍走 `judgeGeneratedCode`（子进程），`measureSkillDelta` 不引入 LLM 裁判。

---

## 七、风险与开放问题

1. **【残余噪声】**：温度 0 仍有余噪；改进轨消费 delta 时须设最小效应阈值（M2 风险 #1 延续）。本 spec 只产出 delta，不判定「改好了」。
2. **【任务相关性，仍在】**：只有 safe-coding 有任务集。多数 skill（流程/清单类）无法冻结测试（A1 禁止 LLM 裁判）。M2b 只对 safe-coding 有意义。
3. **【成本】**：每次改 skill = 2 × N 次 LLM 调用。当前 N=1 可忽略；任务集扩容时重估。
4. **【开放】frontmatter 名变更**：proposal 若改了 skill 的 `name:`（重命名），嗅新名会匹配不到旧任务集——首个版本不处理重命名，标为已知边界。

---

## 八、决策记录（岔路口）

| #   | 岔路口           | 选项                                            | 选了 | 为何（否决项理由）                                                                                                     | 推迟的（先跑通） | 回访触发               |
| --- | ---------------- | ----------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------- |
| 1   | 测量位置         | A 独立 async 步骤 / B 塞进 runCrsiModification  | A    | B 会把 sandbox seam 变成 async + 依赖 LLM，同步→异步波及所有调用方；且 delta 只需 proposal 两段字符串，不必进 worktree | —                | —                      |
| 2   | skill 识别       | A 路径门+frontmatter 嗅 / B 显式 skillName 字段 | A    | B 多一个字段 + producer 要补；路径+嗅零 API 改动、现有 proposal 直接用                                                 | 外部 skill 路径  | 接外部 skill 时        |
| 3   | frontmatter 解析 | A 复用 loader.parseFrontmatter / B 自写 regex   | A    | B 重造轮子且漏 BOM/YAML 边界；loader 已解决                                                                            | —                | —                      |
| 4   | delta 持久化     | A 现在 logging / B 先 return+显示               | B    | 改进轨未落地，持久化格式要等因果归因的 ledger 设计一起定                                                               | delta 持久化格式 | 改进轨启动时           |
| 5   | skill 重命名     | A 处理 / B 标已知边界                           | B    | 重命名非当前用例，首版不做                                                                                             | 重命名支持       | 出现重命名 proposal 时 |

---

## Self-Review 记录

- **A1 边界**：`measureSkillDelta` 只调用 `runTaskPerformance`（LLM 生成 + 冻结测试判定），不引入 LLM 裁判（§3.3）。
- **隔离**：`runCrsiModification` 零改动（§3.4），sync seam 不被 LLM 污染；delta 测量在命令层独立完成。
- **诚实边界**：delta 是「信号」不是「判定」——「改好了没」要改进轨的最小效应量+因果归因才答得（§七风险 1）。
- **无占位符**：签名、门、嗅、接线均给具体值。
