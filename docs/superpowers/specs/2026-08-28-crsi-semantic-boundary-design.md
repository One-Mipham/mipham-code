# CRSI 语义边界（Semantic Boundary）设计

> **日期**: 2026-08-28
> **作者**: Guohua Zhang · One Mipham Corporation
> **术语**: immutable base = 自改进的「不可变基础」（宪法/评估器/机制自身）；可编辑补充 = 自改进的产物（教训/managed-rules/skills）；Goodhart 元劫持 = 自改进改掉自己的评分标准；fail-closed = 宁可多拦，不可漏拦
> **前情**: 承接 [[2026-08-28-crsi-improvement-track-design]]（改进轨新增 3 个评估器文件未进 `PROTECTED_PATHS`，暴露「路径黑名单易漏」）；教训 `crsi-lessons.md` `boundary`（语义边界优于路径黑名单）

---

## 一、背景与动机

改进轨落地后读码审计发现：`PROTECTED_PATHS`（`crsi-sandbox.ts:101-124`）是**手列路径黑名单**，改进轨新增的 3 个评估器文件（`task-performance.ts` / `task-performance-tasks.json` / `improvement-track.ts`）一个都没补进保护域——它们正是「改掉评估器 / Goodhart 元劫持」面，却可被自改进 proposal 修改。

`crsi-lessons.md` `boundary` 教训（line 151）明示：自改进边界用**语义**划分（「不可变基础」vs「可编辑补充」）比路径黑名单「更清晰、更不易漏」，映射 CRSI = `PROTECTED_PATHS` 改为显式「immutable base」语义清单。

本 spec 把路径黑名单升级为**语义保护清单**，并加**完整性自检契约**让漂移 fail-closed。

---

## 二、目标与非目标

**目标**：

1. `PROTECTED_PATHS`（平面路径黑名单）→ `PROTECTED_ROLES`（按语义角色三类：`constitution` / `evaluator` / `selfImprovement`）。
2. 补齐 9 个缺失机制文件（3 评估器 + 6 机制/基础设施）。
3. eval harness 加 `protection-completeness` 契约：断言一组冻结的「关键机制文件」全在保护域——漂移时 eval 分数掉、fail-closed。

**非目标**：

- ❌ 改 `isProtectedPath` 的前缀匹配逻辑（数据源重构，判定行为不变）。
- ❌ 目录级自动保护（搬迁 10+ 文件）——大重构，另立计划。
- ❌ 保护 `crsi-managed-rules.ts` / `crsi-lessons.md` / skills——它们是「可编辑补充」（producer 产物），必须可被自改进修改。
- ❌ 改 `runEval` 的其他 21 条契约——只加 1 条新契约。

---

## 三、核心设计

### 3.1 语义清单 `PROTECTED_ROLES`

`crsi-sandbox.ts` 的 `PROTECTED_PATHS` 改为：

```typescript
/**
 * 自改进的「不可变基础」（immutable base）——按语义角色三类。
 * 自改进循环可以改 skill/workflow/prompt/memory/教训/managed-rules，
 * 但绝不能改以下三者，否则会削弱 grader 或安全边界：
 *   constitution     —— 宪法/对齐：改掉 = 价值漂移优化掉安全边界
 *   evaluator        —— 评估器/grader：改掉 = 改掉自己的评分标准（Goodhart 元劫持）
 *   selfImprovement  —— 改进机制自身：改掉 = 递归改掉评估器/安全
 *
 * 注意：fail-closed——宁可多拦，不可漏拦。新增机制文件必须加进对应类别，
 * 否则 eval harness 的 protection-completeness 契约会 fail。
 */
export const PROTECTED_ROLES = {
  constitution: [
    'apps/cli/src/core/alignment-vocabulary.json',
    'apps/cli/src/core/constitution-loader.ts',
    'apps/cli/src/core/constitution-seam.ts',
    'apps/cli/src/vajra/constitution.ts',
  ],
  evaluator: [
    'apps/cli/test/',
    'apps/cli/src/core/eval-harness.ts',
    'apps/cli/src/core/behavior-tasks.ts',
    'apps/cli/src/core/behavior-tasks.json',
    'apps/cli/src/core/task-performance.ts',
    'apps/cli/src/core/task-performance-tasks.json',
    'apps/cli/src/core/improvement-track.ts',
  ],
  selfImprovement: [
    'apps/cli/src/agent/effectiveness-tracker.ts',
    'apps/cli/src/agent/recoverable-failure.ts',
    'apps/cli/src/agent/crsi-provenance-bridge.ts',
    'apps/cli/src/agent/experience-rules.ts',
    'apps/cli/src/agent/agent-experience.ts',
    'apps/cli/src/core/meta-rule-engine.ts',
    'apps/cli/src/core/crsi-sandbox.ts',
    'apps/cli/src/core/crsi-producer.ts',
    'apps/cli/src/core/proposal-guard.ts',
    'apps/cli/src/core/crsi-modify.ts',
    'apps/cli/src/core/rule-engine.ts',
    'apps/cli/src/core/red-team.ts',
    'apps/cli/src/core/error-signature-db.ts',
    'apps/cli/src/core/preflight-checker.ts',
    'apps/cli/src/core/permission-rules.ts',
    'apps/cli/src/core/rules-loader.ts',
  ],
} as const

/** 扁平化（向后兼容：isProtectedPath 仍用前缀匹配，行为不变）。 */
export const PROTECTED_PATHS: string[] = Object.values(PROTECTED_ROLES).flat()

/** 是否命中只读边界。前缀匹配，目录条目以 `/` 结尾。 */
export function isProtectedPath(filePath: string): boolean {
  return PROTECTED_PATHS.some((p) => filePath === p || filePath.startsWith(p))
}
```

分类增量（相对旧 18 条）：

| 类别            | 新增文件                                                                                  | 角色                                       |
| --------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------ |
| evaluator       | `task-performance.ts` / `task-performance-tasks.json` / `improvement-track.ts`            | 评估器 / 冻结任务集 / 改进判定             |
| selfImprovement | `recoverable-failure.ts` / `crsi-provenance-bridge.ts`                                    | 失败分类 / 溯源桥                          |
| selfImprovement | `experience-rules.ts` / `agent-experience.ts` / `permission-rules.ts` / `rules-loader.ts` | 学习/权限/规则基础设施（fail-closed 纳入） |

### 3.2 完整性自检契约

`crsi-sandbox.ts` 额外导出冻结的「关键机制文件」金丝雀清单（与 `PROTECTED_ROLES` 同文件，单一文件维护）：

```typescript
/** 完整性金丝雀：这些「评估器 + 核心机制」文件必须全在保护域。 */
export const PROTECTED_CRITICAL_FILES: string[] = [
  'apps/cli/src/core/eval-harness.ts',
  'apps/cli/src/core/behavior-tasks.ts',
  'apps/cli/src/core/behavior-tasks.json',
  'apps/cli/src/core/task-performance.ts',
  'apps/cli/src/core/task-performance-tasks.json',
  'apps/cli/src/core/improvement-track.ts',
  'apps/cli/src/core/crsi-sandbox.ts',
  'apps/cli/src/core/crsi-producer.ts',
  'apps/cli/src/core/rule-engine.ts',
  'apps/cli/src/core/red-team.ts',
  'apps/cli/src/core/error-signature-db.ts',
  'apps/cli/src/core/preflight-checker.ts',
  'apps/cli/src/agent/recoverable-failure.ts',
  'apps/cli/src/agent/crsi-provenance-bridge.ts',
]
```

`eval-harness.ts` 的 `runEval` 加一条契约（第 22 条）：

```typescript
import { isProtectedPath, PROTECTED_CRITICAL_FILES } from './crsi-sandbox'
// ...
const protectedCritical = PROTECTED_CRITICAL_FILES.every((f) => isProtectedPath(f))
results.push({
  id: 'protection-completeness',
  description: '语义保护边界覆盖全部关键机制文件（评估器 + 核心机制）',
  passed: protectedCritical,
})
```

**闭环**：`runEval` 在每次 `/crsi modify` 都跑 → 谁加了未保护的新机制文件，`protection-completeness` fail → 分数掉 → 「分数不退化」闸兜底拒绝。金丝雀清单与 `PROTECTED_ROLES` 同文件（`crsi-sandbox.ts`），新增机制文件时两处一起维护，漏了哪处都能被自检暴露。

### 3.3 数据流

```
/crsi modify proposal → runCrsiModification
  └─ validateBlastRadius（现有）
  └─ applyModification → isProtectedPath(filePath)  ← 查 PROTECTED_ROLES（flatten，前缀匹配不变）
  └─ runEval → protection-completeness 契约 ← 查 PROTECTED_CRITICAL_FILES 全命中 isProtectedPath
```

---

## 四、A1 铁律边界

本 spec 不涉及 LLM 判定——纯路径前缀匹配 + 纯列表断言，零 LLM。`protection-completeness` 是确定性算术（`every` + 字符串比较）。

---

## 五、里程碑

| 里程碑 | 内容                                                               | 交付物                  |
| ------ | ------------------------------------------------------------------ | ----------------------- |
| **S1** | `PROTECTED_ROLES` 语义清单 + 补齐 9 文件                           | 三类清单 + flatten 不变 |
| **S2** | `PROTECTED_CRITICAL_FILES` 金丝雀 + `protection-completeness` 契约 | eval 第 22 契约         |

S1/S2 是一个 plan 的两阶段（S2 依赖 S1 的导出）。

---

## 六、测试

- **分类结构**：`PROTECTED_ROLES` 三类均为非空数组；`PROTECTED_PATHS` = flatten 三类，长度 = 三类之和。
- **补齐正确**：新增 9 文件的 `isProtectedPath` 返回 true；`crsi-managed-rules.ts` / `crsi-lessons.md` / 某 skill 文件返回 false（可编辑补充不被保护）。
- **行为不变**：既有受保护文件（如 `eval-harness.ts`）仍返回 true；既有未保护文件（如 `engine.ts`）仍返回 false——重构未改判定。
- **金丝雀契约**：`PROTECTED_CRITICAL_FILES.every(isProtectedPath)` 为 true；若从 `PROTECTED_ROLES` 移除某关键文件，契约变 false（fail-closed 自检生效）。
- **无重复**：三类之间无路径重复；`PROTECTED_CRITICAL_FILES` 无重复且都是 `PROTECTED_PATHS` 的子集（金丝雀 ⊆ 保护域）。

---

## 七、风险与开放问题

1. **【双清单维护】**：`PROTECTED_ROLES`（保护域）与 `PROTECTED_CRITICAL_FILES`（金丝雀）同文件，但仍是两份清单。新增机制文件须两处都加。缓解：两者同文件、金丝雀是保护域子集，漏加保护域 → 契约 fail；漏加金丝雀 → 文件仍受保护（无安全洞，只是金丝雀没盯住它）。可接受。
2. **【基础设施归类可争议】**：`experience-rules.ts` / `agent-experience.ts` / `permission-rules.ts` / `rules-loader.ts` 是「规则/权限基础设施」，是否属「不可变基础」是语义判断。按 fail-closed 纳入（宁可多拦）；若未来有合法自改进需求（如 producer 想改权限规则），需重新审视。
3. **【目录级自动保护的否决】**：`core/` 目录混有机制与非机制代码（engine/context 等不可保护），单目录前缀无法自动覆盖——故本 spec 仍是指定清单（语义分类版），非真「自动」。彻底自动化（搬迁到 `core/crsi/`）另立计划。
4. **【金丝雀清单的完备性】**：`PROTECTED_CRITICAL_FILES` 是「关键」子集，非全部机制文件。漏加非关键机制文件到金丝雀不会 fail（但加进 `PROTECTED_ROLES` 即可受保护）。这是刻意取舍——金丝雀聚焦 Goodhart 面。

---

## 八、决策记录（岔路口）

| #   | 岔路口              | 选项                                        | 选了 | 为何（否决项理由）                                                                                  | 推迟的     | 回访触发                    |
| --- | ------------------- | ------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------- | ---------- | --------------------------- |
| 1   | 不易漏机制          | A 结构化清单 / B +完整性契约 / C 目录级自动 | B    | A 仍靠人维护、未来仍漏；C 需搬迁 10+ 文件 import 链大改；B 用 eval 自检让漂移 fail-closed，代价最低 | 目录级自动 | 机制文件再增多时            |
| 2   | 基础设施 4 文件归类 | A 纳入 / B 排除                             | A    | 规则/权限是安全边界，fail-closed 宁可多拦；排除会留「改权限规则」洞                                 | —          | producer 需合法改权限规则时 |
| 3   | 金丝雀清单范围      | A 全部机制文件 / B 关键子集                 | B    | A 双清单全等=金丝雀退化为第二份 PROTECTED_PATHS；B 聚焦 Goodhart 面（评估器+核心机制）更有意义      | —          | —                           |
| 4   | 双清单同文件        | A 同文件 / B 分文件                         | A    | 同文件 `crsi-sandbox.ts` 单一维护点，漏改更易被发现                                                 | —          | —                           |

---

## Self-Review 记录

- **行为不变**：`isProtectedPath` 前缀匹配逻辑零改动，只换数据源（§3.1）；既有受保护/未保护判定不漂移（§六）。
- **可编辑补充不误伤**：`crsi-managed-rules.ts` / `crsi-lessons.md` / skills 明确不进保护域（§二非目标）。
- **fail-closed 自检**：`protection-completeness` 让漂移在 eval 时暴露，闭环到「分数不退化」闸（§3.2）。
- **诚实边界**：仍是「语义分类的指定清单」，非真自动（§七.3）；金丝雀是子集非全量（§七.4）。
- **无占位符**：三类清单、9 个新增文件、金丝雀 14 文件、契约 id 均给具体值。
