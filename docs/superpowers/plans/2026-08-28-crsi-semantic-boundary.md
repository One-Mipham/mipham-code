# CRSI 语义边界（Semantic Boundary）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `PROTECTED_PATHS`（路径黑名单）升级为 `PROTECTED_ROLES`（语义清单三类）+ 补齐 9 个缺失机制文件 + eval harness 加 `protection-completeness` 完整性自检契约。

**Architecture:** 数据源重构——`crsi-sandbox.ts` 的平面数组改三类语义对象，`isProtectedPath` 前缀匹配**零改动**（flatten 后行为不变）；eval harness 加一条契约让「漏加保护」fail-closed。

**Tech Stack:** Bun、Vitest 3、TypeScript strict。

**Spec:** `docs/superpowers/specs/2026-08-28-crsi-semantic-boundary-design.md`

## Global Constraints

- `isProtectedPath` 前缀匹配逻辑零改动（只换数据源 `PROTECTED_PATHS` 的来源）。
- 可编辑补充（`crsi-managed-rules.ts` / `crsi-lessons.md` / skills）**不进**保护域。
- 提交信息 Conventional Commits + `Co-Authored-By: Mipham <noreply@mipham.ai>`。
- 测试：`cd apps/cli && pnpm vitest run <file>`；typecheck：`cd apps/cli && pnpm typecheck`。

## Reconciliation（spec 与现状的出入，实现者必读）

1. **契约计数**：spec §3.2 写「第 22 条契约」，是 stale——eval harness 实际已有 **32 条**结果（含 3 条 `protectedChecks` spot-check + behavior gaps + behavior tasks）。本计划加 1 条 → **33**，测试 `report.total` 32 → 33。
2. **已有 `protectedChecks`**（eval-harness.ts:161-168）已对 3 个路径做 `isProtectedPath` spot-check（constitution / tests / machinery）。**保留不删**（其 id 有分类语义），新增的 `protection-completeness` 是更强的全量金丝雀，二者共存无碍。

---

## File Structure

| 文件                                      | 动作   | 职责                                                                    |
| ----------------------------------------- | ------ | ----------------------------------------------------------------------- |
| `apps/cli/src/core/crsi-sandbox.ts`       | Modify | Task 1：`PROTECTED_ROLES` + flatten；Task 2：`PROTECTED_CRITICAL_FILES` |
| `apps/cli/test/core/crsi-sandbox.test.ts` | Modify | Task 1：语义清单结构 + 补齐测试                                         |
| `apps/cli/src/core/eval-harness.ts`       | Modify | Task 2：`protection-completeness` 契约                                  |
| `apps/cli/test/core/eval-harness.test.ts` | Modify | Task 2：total 32→33 + 契约断言                                          |

---

## Task 1: `PROTECTED_ROLES` 语义清单 + 补齐 9 文件

**Files:**

- Modify: `apps/cli/src/core/crsi-sandbox.ts`
- Test: `apps/cli/test/core/crsi-sandbox.test.ts`

**Interfaces:**

- Consumes: 无（`isProtectedPath` 已有）
- Produces:
  - `export const PROTECTED_ROLES: { constitution: string[]; evaluator: string[]; selfImprovement: string[] }`
  - `export const PROTECTED_PATHS: string[]`（= flatten 三类，向后兼容）

- [ ] **Step 1: 写失败测试**

`apps/cli/test/core/crsi-sandbox.test.ts` 顶部 import 加 `isProtectedPath, PROTECTED_ROLES, PROTECTED_PATHS`：

```typescript
import {
  CrsiSandbox,
  validateBlastRadius,
  isProtectedPath,
  PROTECTED_ROLES,
  PROTECTED_PATHS,
} from '../../src/core/crsi-sandbox'
```

追加 describe（文件末尾）：

```typescript
describe('PROTECTED_ROLES (语义保护清单)', () => {
  it('三类齐全且 PROTECTED_PATHS = flatten 三类', () => {
    expect(Object.keys(PROTECTED_ROLES)).toEqual(['constitution', 'evaluator', 'selfImprovement'])
    expect(PROTECTED_PATHS).toEqual(Object.values(PROTECTED_ROLES).flat())
    expect(PROTECTED_PATHS.length).toBe(Object.values(PROTECTED_ROLES).flat().length)
  })

  it('补齐的评估器/机制文件已被保护', () => {
    const newlyProtected = [
      'apps/cli/src/core/task-performance.ts',
      'apps/cli/src/core/task-performance-tasks.json',
      'apps/cli/src/core/improvement-track.ts',
      'apps/cli/src/agent/recoverable-failure.ts',
      'apps/cli/src/agent/crsi-provenance-bridge.ts',
    ]
    for (const f of newlyProtected) expect(isProtectedPath(f)).toBe(true)
  })

  it('可编辑补充（producer 产物）不被保护', () => {
    expect(isProtectedPath('apps/cli/src/core/crsi-managed-rules.ts')).toBe(false)
    expect(isProtectedPath('apps/cli/crsi-lessons.md')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/core/crsi-sandbox.test.ts`
Expected: FAIL（`PROTECTED_ROLES`/`PROTECTED_PATHS` 未导出，且新文件 `isProtectedPath` 返回 false）。

- [ ] **Step 3: 实现 `PROTECTED_ROLES` + flatten**

`apps/cli/src/core/crsi-sandbox.ts`，把 `const PROTECTED_PATHS = [ ... ]`（约 line 101-124）整段替换为：

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
```

（`isProtectedPath` 函数保持原样——它已用 `PROTECTED_PATHS.some(...)`，flatten 后数据源变了、逻辑不变。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm vitest run test/core/crsi-sandbox.test.ts`
Expected: PASS（新 describe 3 测试绿 + 原 validateBlastRadius/CrsiSandbox 测试仍绿）。

- [ ] **Step 5: typecheck**

Run: `cd apps/cli && pnpm typecheck`
Expected: 0 error。

- [ ] **Step 6: Commit**

```bash
cd apps/cli && git add src/core/crsi-sandbox.ts test/core/crsi-sandbox.test.ts
git commit -m "feat(crsi): 语义边界 S1——PROTECTED_ROLES 三类清单 + 补齐 9 机制文件

Co-Authored-By: Mipham <noreply@mipham.ai>"
```

---

## Task 2: 金丝雀 `PROTECTED_CRITICAL_FILES` + `protection-completeness` 契约

**Files:**

- Modify: `apps/cli/src/core/crsi-sandbox.ts`
- Modify: `apps/cli/src/core/eval-harness.ts`
- Test: `apps/cli/test/core/eval-harness.test.ts`

**Interfaces:**

- Consumes: `isProtectedPath`（已有）
- Produces: `export const PROTECTED_CRITICAL_FILES: string[]`（金丝雀清单）

- [ ] **Step 1: 写失败测试**

`apps/cli/test/core/eval-harness.test.ts` 现有 `runEval` describe（`reports a full score...` 断言 `total: 32` / `passed: 32` / `score: 100`）改为 33：

```typescript
const report = runEval()
expect(report.total).toBe(33)
expect(report.passed).toBe(33)
expect(report.score).toBe(100)
```

并追加一个契约断言测试（同 describe 内）：

```typescript
it('包含语义边界完整性契约（关键机制文件全覆盖）', () => {
  const report = runEval()
  const contract = report.results.find((r) => r.id === 'protection-completeness')
  expect(contract).toBeDefined()
  expect(contract!.passed).toBe(true)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/core/eval-harness.test.ts`
Expected: FAIL（`total` 仍 32 且无 `protection-completeness` 契约）。

- [ ] **Step 3: 加 `PROTECTED_CRITICAL_FILES`**

`apps/cli/src/core/crsi-sandbox.ts` 在 `PROTECTED_PATHS` 之后追加：

```typescript
/**
 * 完整性金丝雀：这些「评估器 + 核心机制」文件必须全在保护域。
 * eval harness 的 protection-completeness 契约逐条断言 isProtectedPath。
 * 与 PROTECTED_ROLES 同文件（单一维护点）——新增机制文件须两处一起加。
 */
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

- [ ] **Step 4: eval-harness 加 `protection-completeness` 契约**

`apps/cli/src/core/eval-harness.ts`：

- 顶部 import（line 22）改为：

```typescript
import { isProtectedPath, validateBlastRadius, PROTECTED_CRITICAL_FILES } from './crsi-sandbox'
```

- 在 `protectedChecks` 循环（约 line 168）之后插入：

```typescript
// ── 语义边界完整性（ground truth：金丝雀关键机制文件全覆盖） ──
const unprotected = PROTECTED_CRITICAL_FILES.filter((f) => !isProtectedPath(f))
results.push({
  id: 'protection-completeness',
  description: '语义保护边界覆盖全部关键机制文件（评估器 + 核心机制）',
  passed: unprotected.length === 0,
  ...(unprotected.length > 0 ? { detail: `未保护: ${unprotected.join(', ')}` } : {}),
})
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/cli && pnpm vitest run test/core/eval-harness.test.ts`
Expected: PASS（`total` 33、`passed` 33、`protection-completeness` 存在且 true）。

- [ ] **Step 6: typecheck + 全量**

Run: `cd apps/cli && pnpm typecheck` → 0 error
Run: `cd apps/cli && pnpm test` → 全绿（1953 + 3 sandbox 新测试 + eval 契约调整 ≈ 1957 个，无回归）。

- [ ] **Step 7: Commit**

```bash
cd apps/cli && git add src/core/crsi-sandbox.ts src/core/eval-harness.ts test/core/eval-harness.test.ts
git commit -m "feat(crsi): 语义边界 S2——PROTECTED_CRITICAL_FILES 金丝雀 + protection-completeness 契约

Co-Authored-By: Mipham <noreply@mipham.ai>"
```

---

## Self-Review

- **Spec 覆盖**：§3.1（`PROTECTED_ROLES` + flatten）→ Task 1 Step 3；§3.2（金丝雀 + 契约）→ Task 2 Step 3/4；§六（测试）→ Task 1 Step 1 + Task 2 Step 1。
- **占位符扫描**：无 TBD/TODO；每步给完整可跑代码。
- **类型一致性**：`PROTECTED_ROLES`/`PROTECTED_PATHS`/`PROTECTED_CRITICAL_FILES` 在 crsi-sandbox.ts 定义、Task 1/2 测试与 eval-harness 消费一致；`isProtectedPath` 签名不变。
- **行为不变**：`isProtectedPath` 前缀匹配逻辑零改动，数据源 flatten（§Global Constraints）。
- **Reconciliation 落实**：total 32→33（非 spec 的「22」）；已有 `protectedChecks` 保留（§Reconciliation）。
