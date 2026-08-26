# AGENTS.md 兼容 + 递归指令加载 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Mipham Code 读取 `AGENTS.md`（+ `AGENTS.override.md`），并把固定 3 层指令加载升级为「git 根 → cwd 递归加载、就近优先」，实现「CLAUDE.md / AGENTS.md / MIPHAM.md 三格式并存、全兼容」的开放姿态。

**Architecture:** 扩展 `InstructionsLoader`（`apps/cli/src/core/instructions.ts`）——提取 `gitRoot` 与新增 `discoverDirectories` 两个纯函数，用 `INSTRUCTION_FILENAMES` 常量驱动「逐目录 × 多格式」加载。集团/公司/用户三层保持现状不变，仅把「项目层」从固定 1 层改写为「git 根 → cwd」递归。加载顺序即优先级（后加载覆盖先加载）。

**Tech Stack:** TypeScript 5.5+（strict）/ Bun / Vitest 3 / `node:fs` + `node:path` + `node:child_process`

**Spec:** 内联（本计划的 Architecture + 设计决策即规格；无独立 spec 文件）。设计依据：AGENTS.md 由 Agentic AI Foundation（Linux 基金会）托管，Codex 用「根→cwd 递归 + 就近优先」加载。

---

## Global Constraints

- **回归安全**：不破坏现有 CLAUDE.md / MIPHAM.md 加载行为；现有 174 文件测试必须全绿。
- **层级不动**：集团（group）/公司（company）/用户（user）三层保持现状顺序与内容，**不读 AGENTS.md**（那些目录是 Mipham 自有策略，非通用项目）。
- **项目层相对顺序不变**：MIPHAM.md → CLAUDE.md 的现有先后顺序保持，仅把 `AGENTS.md` / `AGENTS.override.md` 前置为基线。
- **就近优先**：`loadAll` 的加载顺序即系统提示中的优先级，后加载的指令覆盖先加载的。
- **读全部、不丢弃**：同一目录内 CLAUDE.md 与 AGENTS.md 同时存在时**都读**（合并），不做「只取一个」——这是与 Codex「override 替换」语义的区别，也是 Mipham「不排斥、全接纳」的工程表达。
- **复用现有机制**：`parseFrontmatter` / `stripSections` / `prompt-exclude` / `privacy` 对 AGENTS.md 自动生效，不新造解析器。
- **TDD**：每个行为先写失败测试再实现。
- **提交规范**：Conventional Commits，正文末尾加 `Co-Authored-By: Mipham <noreply@mipham.ai>`。

---

## 现状（executor 需要知道）

`apps/cli/src/core/instructions.ts` 当前：

- `loadAll(cwd)`（L66-88）：固定读 5 处——
  1. `join(cwd,'..','..','CLAUDE.md')` → `'group'`（Rismed_Ronxin_Capital）
  2. `join(cwd,'..','CLAUDE.md')` → `'company'`（One_Mipham_Corporation）
  3. `join(cwd,'..','MIPHAM.md')` → `'group'`
  4. `join(cwd,'MIPHAM.md')` → `'project'`
  5. `join(cwd,'CLAUDE.md')` → `'project'`
  6. `~/.mipham/USER.md` → `'user'`
- `loadCrsiLessons(cwd)`（L238-255）：内部 `execSync('git rev-parse --show-toplevel')` 定位根，读 `apps/cli/crsi-lessons.md`。
- `tryLoad(path, level)`（L282-299）：读文件 + `parseFrontmatter`，静默跳过不存在/不可读。
- `InstructionFile.level` 类型已含 `'directory'`（`apps/cli/src/shared/types.ts` L275），`buildSystemPrompt` 的 `levelLabel` 已映射 `directory → 'Directory Rules'`。

调用点：`index.tsx:305-306`（`loadAll(process.cwd())`）、`commands.ts:2928-2929`（`/doctor` 只 `filter(...endsWith('CLAUDE.md'))`，不受影响）。**无需改调用点**（`loadAll` 签名不变）。

## 设计决策

1. **每目录格式顺序**（`INSTRUCTION_FILENAMES`，后加载 = 更高优先级）：
   `AGENTS.md` → `AGENTS.override.md` → `MIPHAM.md` → `CLAUDE.md`。
   理由：AGENTS.md 是行业标准基线（最低优先级）；AGENTS.override.md 是 Codex 覆盖层（紧跟在 AGENTS.md 后）；MIPHAM.md → CLAUDE.md 相对顺序保持现状不变（避免回归）。
2. **递归范围**：`git 根 → cwd`（含两端）。根目录文件标 `'project'`，更深层标 `'directory'`。非 git 目录时 `gitRoot` 回退 cwd，退化为单目录（`[cwd]`），行为等同现状 + 读 AGENTS.md。
3. **集团层锚定**：`../../` / `../` 从 `gitRoot(cwd)` 起算（而非 cwd），使从任意子目录启动时集团/公司层仍正确命中——修复既有「cwd 为子目录时相对路径漂移」隐患。
4. **`loadCrsiLessons` 收口**：改签名 `loadCrsiLessons(root)`，复用 `loadAll` 顶部算出的 `root`，避免二次 `git rev-parse`。

---

### Task 1: 提取 `gitRoot` + 新增 `discoverDirectories` 纯函数

**Files:**

- Modify: `apps/cli/src/core/instructions.ts`（新增两个导出函数；改 import 行）
- Test: `apps/cli/test/core/instructions.test.ts`

**Interfaces:**

- Produces: `export function gitRoot(cwd: string): string`、`export function discoverDirectories(root: string, cwd: string): string[]`

- [ ] **Step 1: 写失败测试**

在 `test/core/instructions.test.ts` 顶部补 import（从 `../../src/core/instructions` 加 `gitRoot, discoverDirectories`；从 `node:path` 加 `resolve, basename`；从 `node:os` 加 `tmpdir`；从 `node:fs` 加 `mkdtempSync, writeFileSync, mkdirSync, rmSync`；`join` 已可来自 `node:path`），新增两个 describe：

```ts
describe('gitRoot', () => {
  it('falls back to cwd outside a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mipham-instr-'))
    try {
      expect(gitRoot(dir)).toBe(resolve(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('discoverDirectories', () => {
  it('returns [root] when cwd equals root', () => {
    expect(discoverDirectories('/repo', '/repo')).toEqual([resolve('/repo')])
  })
  it('walks root → cwd, nearest last', () => {
    expect(discoverDirectories('/repo', '/repo/apps/cli')).toEqual([
      resolve('/repo'),
      resolve('/repo/apps'),
      resolve('/repo/apps/cli'),
    ])
  })
  it('degrades to [cwd] when cwd is outside root', () => {
    expect(discoverDirectories('/repo', '/other')).toEqual([resolve('/other')])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/core/instructions.test.ts -t "gitRoot|discoverDirectories"`
Expected: FAIL（`gitRoot` / `discoverDirectories` 未导出）

- [ ] **Step 3: 实现**

在 `instructions.ts` 改 import 行（第 2 行）：

```ts
import { join, resolve, relative, sep, isAbsolute } from 'node:path'
```

在 `InstructionsLoader` 类定义之前（例如 `parsePromptExclude` 之后、`export class` 之前）新增两个导出函数：

```ts
/** 定位仓库根（git rev-parse --show-toplevel），非 git 目录回退 cwd。 */
export function gitRoot(cwd: string): string {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd,
      timeout: 5000,
      encoding: 'utf-8',
    }).trim()
  } catch {
    return cwd
  }
}

/** 从仓库根到 cwd 的目录链（含两端），就近（cwd）在最后。cwd 不在 root 下时退化为 [cwd]。 */
export function discoverDirectories(root: string, cwd: string): string[] {
  const absRoot = resolve(root)
  const absCwd = resolve(cwd)
  if (absCwd === absRoot) return [absRoot]

  const rel = relative(absRoot, absCwd)
  if (rel.startsWith('..') || isAbsolute(rel)) return [absCwd]

  const dirs = [absRoot]
  let cur = absRoot
  for (const seg of rel.split(sep)) {
    cur = join(cur, seg)
    dirs.push(cur)
  }
  return dirs
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/core/instructions.test.ts -t "gitRoot|discoverDirectories"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/instructions.ts apps/cli/test/core/instructions.test.ts
git commit -m "refactor(instructions): extract gitRoot + discoverDirectories pure helpers

Co-Authored-By: Mipham <noreply@mipham.ai>"
```

---

### Task 2: `INSTRUCTION_FILENAMES` + 递归 `loadAll` + `loadCrsiLessons(root)`

**Files:**

- Modify: `apps/cli/src/core/instructions.ts`
- Test: `apps/cli/test/core/instructions.test.ts`

**Interfaces:**

- Consumes: `gitRoot` / `discoverDirectories`（Task 1）
- Produces: `export const INSTRUCTION_FILENAMES: readonly string[]`

- [ ] **Step 1: 写失败测试**

新增 describe（放 test 文件末尾）：

```ts
describe('InstructionsLoader.loadAll (AGENTS.md 多格式 + 递归)', () => {
  it('loads AGENTS.md alongside CLAUDE.md and MIPHAM.md, AGENTS first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mipham-instr-'))
    try {
      writeFileSync(join(dir, 'AGENTS.md'), '# AGENTS rules\n- agent rule')
      writeFileSync(join(dir, 'CLAUDE.md'), '# CLAUDE rules\n- claude rule')
      writeFileSync(join(dir, 'MIPHAM.md'), '# MIPHAM rules\n- mipham rule')
      const loader = new InstructionsLoader()
      loader.loadAll(dir)
      const files = loader.list().filter((f) => f.path.startsWith(dir))
      const names = files.map((f) => basename(f.path))
      expect(names).toContain('AGENTS.md')
      expect(names).toContain('CLAUDE.md')
      expect(names).toContain('MIPHAM.md')
      // 顺序：AGENTS.md → MIPHAM.md → CLAUDE.md（AGENTS 前置为基线，MIPHAM→CLAUDE 保持现状）
      expect(names.indexOf('AGENTS.md')).toBeLessThan(names.indexOf('MIPHAM.md'))
      expect(names.indexOf('MIPHAM.md')).toBeLessThan(names.indexOf('CLAUDE.md'))
      // 根目录级别 = project
      expect(files.find((f) => basename(f.path) === 'AGENTS.md')!.level).toBe('project')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('recursively loads subdirectory AGENTS.md as directory level', () => {
    const root = mkdtempSync(join(tmpdir(), 'mipham-instr-'))
    try {
      execSync('git init -q', { cwd: root }) // 让 gitRoot 能定位到 root，否则回退 cwd、测不到递归
      writeFileSync(join(root, 'AGENTS.md'), '# root agents')
      mkdirSync(join(root, 'apps'))
      writeFileSync(join(root, 'apps', 'AGENTS.md'), '# apps agents')
      const loader = new InstructionsLoader()
      loader.loadAll(join(root, 'apps'))
      const list = loader.list()
      const rootAgents = list.find((f) => f.path === join(root, 'AGENTS.md'))
      const appsAgents = list.find((f) => f.path === join(root, 'apps', 'AGENTS.md'))
      expect(rootAgents!.level).toBe('directory')
      expect(appsAgents!.level).toBe('project')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
```

> **Task 2 测试 import 追加**（在 Task 1 已有 import 基础上）：`node:path` 加 `basename` → `import { join, resolve, basename } from 'node:path'`；`node:fs` 加 `writeFileSync, mkdirSync` → `import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'`；新增 `import { execSync } from 'node:child_process'`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/core/instructions.test.ts -t "AGENTS.md"`
Expected: FAIL（当前不读 AGENTS.md，`names` 不含 `'AGENTS.md'`，递归 level 断言不成立）

- [ ] **Step 3: 实现**

(a) 在 `gitRoot` 附近新增常量：

```ts
/**
 * 每目录内指令文件的读取顺序（后加载 = 更高优先级）。
 * AGENTS.md（行业标准基线）→ AGENTS.override.md（Codex 覆盖层）→
 * MIPHAM.md（Mipham 品牌）→ CLAUDE.md（Claude Code 兼容）。
 * MIPHAM→CLAUDE 相对顺序保持现状不变，仅前置 AGENTS 两条，避免行为回归。
 */
export const INSTRUCTION_FILENAMES = [
  'AGENTS.md',
  'AGENTS.override.md',
  'MIPHAM.md',
  'CLAUDE.md',
] as const
```

(b) 重写 `loadAll`（替换现 L66-88）：

```ts
loadAll(cwd: string): void {
  this.instructions = []
  const root = gitRoot(cwd)

  // Tier 1: 集团/公司策略（锚定仓库根，从任意子目录启动都正确；不读 AGENTS.md）
  this.tryLoad(join(root, '..', '..', 'CLAUDE.md'), 'group') // Rismed_Ronxin_Capital
  this.tryLoad(join(root, '..', 'CLAUDE.md'), 'company')     // One_Mipham_Corporation
  this.tryLoad(join(root, '..', 'MIPHAM.md'), 'group')

  // Tier 2: 递归项目层 — git 根 → cwd，逐目录读，就近（cwd）最后 = 优先级最高
  const dirs = discoverDirectories(root, cwd)
  dirs.forEach((dir, i) => {
    const level: InstructionFile['level'] = i === dirs.length - 1 ? 'project' : 'directory'
    for (const name of INSTRUCTION_FILENAMES) {
      this.tryLoad(join(dir, name), level)
    }
  })

  // Tier 3: 用户层 ~/.mipham/USER.md
  const home = process.env.HOME || '~'
  this.tryLoad(join(home, '.mipham', 'USER.md'), 'user')

  // CRSI 教训召回：读 crsi-lessons.md 提取精华，注入系统提示（只写不读 → 写后召回）
  this.crsiLessonSummaries = this.loadCrsiLessons(root)
}
```

(c) 改 `loadCrsiLessons`（替换现 L238-255），去掉内部 `git rev-parse`，改收 `root`：

```ts
/** 读 crsi-lessons.md（按仓库根定位）提取教训精华。读不到则返回空。 */
private loadCrsiLessons(root: string): CrsiLessonSummary[] {
  try {
    const content = readFileSync(join(root, LESSONS_FILE), 'utf-8')
    return extractCrsiLessonSummaries(content)
  } catch {
    return []
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/core/instructions.test.ts`
Expected: 全部 PASS（含原 buildSystemPrompt / stripSections / parsePromptExclude 测试）

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/instructions.ts apps/cli/test/core/instructions.test.ts
git commit -m "feat(instructions): read AGENTS.md + recursive git-root→cwd loading

三格式并存（AGENTS.md / CLAUDE.md / MIPHAM.md），递归就近优先。

Co-Authored-By: Mipham <noreply@mipham.ai>"
```

---

### Task 3: 全量回归 + typecheck + lint

**Files:** 无新改动（验证收口）

- [ ] **Step 1: typecheck**

Run: `cd apps/cli && pnpm typecheck`
Expected: 无输出（0 错误）

- [ ] **Step 2: 全量测试**

Run: `pnpm test`
Expected: 174 文件全绿（1859 passed + 2 skipped，或 +2 新测试 = 1861；以实际为准）

- [ ] **Step 3: lint**

Run: `cd /Users/sarvadaya/Rismed_Ronxin_Capital/One_Mipham_Corporation/mipham-code && pnpm lint`
Expected: 0 errors（`loop-e2e.test.ts` 的历史 `describe` 未用 warning 可忽略，非本次引入）

- [ ] **Step 4: 确认 `/doctor` 未回归**

`commands.ts` 的 `/doctor` 只 `filter(f => f.path.endsWith('CLAUDE.md'))`，AGENTS.md 不影响其 CLAUDE.md 审计；如列表出现递归加载的新 CLAUDE.md 属预期增强。

---

## Self-Review

- **Spec 覆盖**：Phase 1（多格式 AGENTS.md + override）→ Task 2；Phase 2（递归 + 就近优先）→ Task 1+2；集团层锚定修复 → Task 2(b)。
- **Placeholder 扫描**：无 TBD/TODO；每步含实际代码。
- **类型一致**：`gitRoot`/`discoverDirectories`/`INSTRUCTION_FILENAMES` 签名在 Task 1/2 间一致；`loadCrsiLessons(root)` 唯一调用点在 `loadAll` 内已同步改。
- **边界**：非 git 目录（`gitRoot` 回退）→ `discoverDirectories` 退化为 `[cwd]`，单目录 + 读 AGENTS.md，行为等价现状增强。
