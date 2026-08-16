# Alignment Vocabulary (mipham-code) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 mipham-code 的 `constitution-loader` 从共享对齐词汇表（vendored `alignment-vocabulary.json`）读取 8 条宪法原则，消除「散落字符串」，并给原则加 `facet` 归属。

**Architecture:** vendor ontology 的 `alignment-vocabulary.json` 到 `apps/cli/src/core/`，用 JSON import（复用 `index.tsx` 的 i18n JSON import 模式）派生 `DEFAULT_CONSTITUTION`，加一致性测试防漂移。

**Tech Stack:** TypeScript 5.5+ (strict), Bun/Vitest 3, `resolveJsonModule: true`（已开）。

**Spec:** `megasystem/ontology/docs/superpowers/specs/2026-08-16-alignment-ontology-design.md` §6（Phase 2）

## Global Constraints

- JSON 是唯一真源；8 条原则的 `id/text/enforce/audit_pattern/scope/hook/tools/rationale` 必须与 ontology 的 `alignment-vocabulary.json` **逐字一致**（该 JSON 已与原始 DEFAULT_CONSTITUTION 逐字一致）。
- facet 映射固定：`prajna` = never-fabricate、think-before-coding、persist-crsi-learning；`vajra` = no-credential-leak、minimal-change、simplicity-first、respect-permissions、no-destructive-without-confirmation；`karuna` = 空（0 条）。
- 三价值面 id：`karuna` / `prajna` / `vajra`。
- ⚠️ 已知差异：JSON 的 `never-fabricate.audit_pattern` 用 `\\s`（正确），原始内联是单个 `\s`（JS 里塌缩成 `s`，是潜在 bug）。JSON 为准——这是 vendor 时的一次 bugfix。
- 测试命令：`cd apps/cli && pnpm vitest run test/core/alignment-vocabulary.test.ts -v`；全量 `pnpm test`。
- 只改 `constitution-loader.ts` + 新增 JSON + 新增测试 + CLAUDE.md；不碰 engine/red-team（它们用 `ConstitutionLoader` 类，不受影响）。

---

## File Structure

- Create: `apps/cli/src/core/alignment-vocabulary.json`（从 ontology vendor 拷贝）
- Modify: `apps/cli/src/core/constitution-loader.ts`（facet 字段 + 从 JSON 派生 DEFAULT_CONSTITUTION + serialize/parse facet + export DEFAULT_CONSTITUTION）
- Test: `apps/cli/test/core/alignment-vocabulary.test.ts`
- Modify: `CLAUDE.md`（文档）

---

### Task 1: vendor JSON + 重构 constitution-loader + 一致性测试

**Files:**
- Create: `apps/cli/src/core/alignment-vocabulary.json`
- Modify: `apps/cli/src/core/constitution-loader.ts`
- Test: `apps/cli/test/core/alignment-vocabulary.test.ts`

**Interfaces:**
- Consumes: ontology 的 `megasystem/ontology/ontology_poc/domains/alignment/alignment-vocabulary.json`（拷贝源）。
- Produces: `constitution-loader.ts` 导出 `DEFAULT_CONSTITUTION`（8 原则 + `facet`）；`ConstitutionalPrinciple` 加 `facet?: string`；`load()`/`serializeToYaml`/`parseYaml` 支持 `facet` 往返。

- [ ] **Step 1: vendor JSON**

```bash
cd /Users/sarvadaya/Rismed_Ronxin_Capital/One_Mipham_Corporation/mipham-code
cp /Users/sarvadaya/Rismed_Ronxin_Capital/One_Mipham_Corporation/megasystem/ontology/ontology_poc/domains/alignment/alignment-vocabulary.json apps/cli/src/core/alignment-vocabulary.json
```

- [ ] **Step 2: Write the failing test**

Create `apps/cli/test/core/alignment-vocabulary.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import alignmentVocabulary from '../../src/core/alignment-vocabulary.json'
import { DEFAULT_CONSTITUTION } from '../../src/core/constitution-loader'

const FACETS = ['karuna', 'prajna', 'vajra'] as const

describe('alignment-vocabulary (vendored)', () => {
  it('has 3 values with the fixed facet ids', () => {
    const values = alignmentVocabulary.values
    expect(values).toHaveLength(3)
    expect(values.map((v) => v.id).sort()).toEqual(['karuna', 'prajna', 'vajra'])
  })

  it('has 8 principles, each facet pointing at a known value', () => {
    expect(alignmentVocabulary.principles).toHaveLength(8)
    for (const p of alignmentVocabulary.principles) {
      expect(FACETS).toContain(p.facet)
    }
  })

  it('exposes the karuna (悲) gap — zero principles operationalize 悲', () => {
    const karunaPrinciples = alignmentVocabulary.principles.filter((p) => p.facet === 'karuna')
    expect(karunaPrinciples).toHaveLength(0)
  })

  it('facet mapping matches the spec (prajna=3, vajra=5)', () => {
    const byFacet = (facet: string) =>
      alignmentVocabulary.principles.filter((p) => p.facet === facet).map((p) => p.id).sort()
    expect(byFacet('prajna')).toEqual(
      ['never-fabricate', 'persist-crsi-learning', 'think-before-coding'].sort(),
    )
    expect(byFacet('vajra')).toEqual(
      [
        'minimal-change',
        'no-credential-leak',
        'no-destructive-without-confirmation',
        'respect-permissions',
        'simplicity-first',
      ].sort(),
    )
  })
})

describe('constitution-loader derives from the vocabulary', () => {
  it('DEFAULT_CONSTITUTION has the same 8 principle ids as the JSON', () => {
    const jsonIds = alignmentVocabulary.principles.map((p) => p.id).sort()
    const constIds = DEFAULT_CONSTITUTION.principles.map((p) => p.id).sort()
    expect(constIds).toEqual(jsonIds)
  })

  it('DEFAULT_CONSTITUTION principles carry a facet', () => {
    for (const p of DEFAULT_CONSTITUTION.principles) {
      expect(FACETS).toContain(p.facet)
    }
  })

  it('never-fabricate audit_pattern uses escaped whitespace (\\\\s)', () => {
    const neverFabricate = DEFAULT_CONSTITUTION.principles.find((p) => p.id === 'never-fabricate')
    expect(neverFabricate?.audit_pattern).toContain('\\s')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/cli && pnpm vitest run test/core/alignment-vocabulary.test.ts -v`
Expected: FAIL — `DEFAULT_CONSTITUTION` 未导出（或 JSON import 未找到，若 Step 1 未做）。

- [ ] **Step 4: Refactor constitution-loader.ts**

在 `constitution-loader.ts`：

1. `ConstitutionalPrinciple` 接口加 `facet?: string`（放在 `rationale?` 之后）：

```ts
  /** Optional: which alignment value (karuna/prajna/vajra) this principle operationalizes. */
  facet?: string
```

2. 文件顶部（node 导入之后）加 JSON import：

```ts
import alignmentVocabulary from './alignment-vocabulary.json' with { type: 'json' }
```

3. 删除内联的 `DEFAULT_CONSTITUTION`（原 8 条原则字面量），替换为从 JSON 派生，并导出：

```ts
export const DEFAULT_CONSTITUTION: MiphamConstitution = {
  version: alignmentVocabulary.version,
  last_modified: '2026-08-16',
  principles: alignmentVocabulary.principles as unknown as ConstitutionalPrinciple[],
}
```

> 若 TS 对 `alignmentVocabulary.principles` 结构报错，用 `as unknown as ConstitutionalPrinciple[]`（已写）；若仍报 `enforce` 类型，用同样的双重断言。`typecheck` 通过为准。

4. `serializeToYaml` 的每条原则序列化里，`enforce` 行之后加 facet：

```ts
      lines.push(`    enforce: ${p.enforce}`)
      if (p.facet) lines.push(`    facet: ${p.facet}`)
```

5. `parseYaml` 的 `setPrincipleField` switch 加 case：

```ts
      case 'facet':
        p.facet = val
        break
```

- [ ] **Step 5: Run test + typecheck**

Run: `cd apps/cli && pnpm vitest run test/core/alignment-vocabulary.test.ts -v && pnpm typecheck`
Expected: 7 passed；typecheck 无输出（通过）。

- [ ] **Step 6: Commit**

```bash
cd /Users/sarvadaya/Rismed_Ronxin_Capital/One_Mipham_Corporation/mipham-code
git add apps/cli/src/core/alignment-vocabulary.json apps/cli/src/core/constitution-loader.ts apps/cli/test/core/alignment-vocabulary.test.ts
git commit -m "feat(core): constitution 从对齐词汇表派生（facet + 单一真源）"
```

---

### Task 2: CLAUDE.md 文档 + 全量回归

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: 无。Produces: 文档反映「宪法对齐本体」闭环。

- [ ] **Step 1: 更新 CLAUDE.md**

在 `CLAUDE.md` 的对齐缝条目（`四缝` 列表的 `对齐缝` 行）之后，补一句说明宪法已从共享词汇表派生：

```markdown
- **对齐缝** `ctx.constitution` — `Constitution` 接口 + `CONSTITUTION_KEY` + `createConstitution(loader)` 桥接 `ConstitutionLoader`；`Service.align?` 声明原则 id，`mount()` 在 apply 前过对齐门（声明未知 id 拒绝挂载）。宪法原则本体见 `apps/cli/src/core/alignment-vocabulary.json`（与 megasystem/ontology 对齐本体共享单一真源，8 原则含 `facet` 归属悲/智/金刚）
```

并把测试表 `合计 1454` 更新为新值（全量回归后确认，预期 +7）。

- [ ] **Step 2: 全量回归**

Run: `cd apps/cli && pnpm test`
Expected: 全绿（1452 + 7 新增 = 1459 passed + 2 skipped，0 失败）。若出现无关失败，逐一列出 test 名 + 是否与本次改动相关。

- [ ] **Step 3: Commit**

```bash
cd /Users/sarvadaya/Rismed_Ronxin_Capital/One_Mipham_Corporation/mipham-code
git add CLAUDE.md
git commit -m "docs: CLAUDE.md 宪法对齐本体闭环（alignment-vocabulary 单一真源）"
```
