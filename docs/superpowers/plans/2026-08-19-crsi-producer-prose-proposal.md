# CRSI Producer 散文提议（块 1 可控 MVP）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** producer 首次引入 LLM **生成**（非裁判）——从失败信号生成「改 skill 散文」的提议，两阶段：① LLM 选目标 skill → ② 读原文后 LLM 增量生成 newContent。这是 A1 边界决策的首次实演。

**Architecture:** `crsi-producer.ts` 新增 `selectTargetSkill`（阶段 1）、`generateProseContent`（阶段 2）、`produceProseProposal`（编排）。skill 列表 + 原文读取均**依赖注入**（可测），LLM 作参数注入（CI 用 mock Llm）。prompt 模板版本化为常量。

**Tech Stack:** TypeScript strict ESM、Bun、Vitest、现有 `crsi-producer.ts`（`CrsiSignal`）、`providers/llm.ts`（`Llm`）。

**Spec:** `docs/superpowers/specs/2026-08-19-crsi-producer-prose-proposal-design.md`（§二 A1 边界、§六 三约束、§八.1 已决策可控 MVP）

## Global Constraints

- LLM 只作**生成**，判定一律确定性（guard 预筛 / 行为效果 / 人审），A1 铁律一分不破。
- 真实 LLM 只作参数注入，CI 测试用 mock Llm，不触发 provider 调用。
- prompt 模板版本化为常量（对齐 CLAUDE.md §十「所有 prompt 模板必须版本化管理」）。
- producer 不 import `proposal-guard`（避免与 `proposal-guard → crsi-producer` 形成循环依赖）；guard 预筛由调用方（`/crsi propose`）负责。
- 提交信息遵循 Conventional Commits；每个 task 结束 commit 一次。

---

### Task 1: 阶段 1 — selectTargetSkill（LLM 选目标 skill）

**Files:**

- Modify: `apps/cli/src/core/crsi-producer.ts`
- Test: `apps/cli/test/core/crsi-producer-prose.test.ts`（新建）

**Interfaces:**

- Consumes: `CrsiSignal`（现有）、`Llm`（现有）
- Produces: `selectTargetSkill(signal, llm, skillFiles): Promise<string | null>`、`collectLlmText(llm, prompt)`、`extractFilePath(response, skillFiles)`、`buildSelectSkillPrompt(signal, skillFiles)`

- [ ] **Step 1: 写失败的测试**

`apps/cli/test/core/crsi-producer-prose.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import type { Llm } from '../../src/providers/llm'
import { selectTargetSkill, type CrsiSignal } from '../../src/core/crsi-producer'

const SIGNAL: CrsiSignal = {
  category: 'timeout',
  title: 'npm install 超时过低',
  severity: 'warning',
  suggestion: '增加 timeout',
  evidence: ['npm install 超时'],
}

const SKILL_FILES = [
  'apps/cli/skills/standard/memory.SKILL.md',
  'apps/cli/skills/standard/implement.SKILL.md',
]

function textLlm(text: string): Llm {
  return {
    chat: async function* () {
      yield { type: 'text', content: text }
      yield { type: 'stop' }
    },
  }
}

describe('selectTargetSkill', () => {
  it('LLM 返回的 filePath 在候选列表内 → 选中', async () => {
    const filePath = await selectTargetSkill(SIGNAL, textLlm(SKILL_FILES[0]!), SKILL_FILES)
    expect(filePath).toBe(SKILL_FILES[0])
  })

  it('LLM 返回带多余文字的响应 → 仍能提取', async () => {
    const llm = textLlm(`我选 ${SKILL_FILES[1]}\n因为相关`)
    expect(await selectTargetSkill(SIGNAL, llm, SKILL_FILES)).toBe(SKILL_FILES[1])
  })

  it('LLM 返回不在列表内的路径 → null', async () => {
    const llm = textLlm('apps/cli/skills/standard/nonexistent.SKILL.md')
    expect(await selectTargetSkill(SIGNAL, llm, SKILL_FILES)).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test crsi-producer-prose`
Expected: FAIL（selectTargetSkill 未导出）

- [ ] **Step 3: 写最小实现**

追加到 `apps/cli/src/core/crsi-producer.ts`：

```typescript
import type { Llm } from '../providers/llm'

const PROSE_SELECT_PROMPT_VERSION = '1.0.0'

function buildSelectSkillPrompt(signal: CrsiSignal, skillFiles: string[]): string {
  return [
    '你是 CRSI producer。给定失败信号，从候选 skill 文件列表中选出最相关的一个，返回其文件路径（只返回路径，一行，不要其他文字）。',
    '',
    '失败信号：',
    `- category: ${signal.category}`,
    `- title: ${signal.title}`,
    signal.severity ? `- severity: ${signal.severity}` : '',
    `- suggestion: ${signal.suggestion}`,
    `- evidence: ${signal.evidence.join(' | ')}`,
    '',
    '候选 skill 文件：',
    ...skillFiles.map((f) => `- ${f}`),
  ]
    .filter(Boolean)
    .join('\n')
}

async function collectLlmText(llm: Llm, prompt: string): Promise<string> {
  let text = ''
  const req = {
    model: 'prose',
    messages: [{ role: 'user' as const, content: prompt }],
    systemPrompt: '',
  }
  for await (const chunk of llm.chat(req)) {
    if (chunk.type === 'text' && chunk.content) text += chunk.content
  }
  return text.trim()
}

function extractFilePath(response: string, skillFiles: string[]): string | null {
  for (const f of skillFiles) {
    if (response.includes(f)) return f
  }
  return null
}

export async function selectTargetSkill(
  signal: CrsiSignal,
  llm: Llm,
  skillFiles: string[],
): Promise<string | null> {
  if (skillFiles.length === 0) return null
  const prompt = buildSelectSkillPrompt(signal, skillFiles)
  const response = await collectLlmText(llm, prompt)
  if (!response) return null
  return extractFilePath(response, skillFiles)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test crsi-producer-prose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/crsi-producer.ts apps/cli/test/core/crsi-producer-prose.test.ts
git commit -m "feat(crsi): producer prose proposal stage 1 — select target skill (LLM)"
```

---

### Task 2: 阶段 2 — generateProseContent（LLM 增量生成 newContent）

**Files:**

- Modify: `apps/cli/src/core/crsi-producer.ts`
- Test: `apps/cli/test/core/crsi-producer-prose.test.ts`

**Interfaces:**

- Consumes: `CrsiSignal`、`Llm`、`collectLlmText`（Task 1）
- Produces: `generateProseContent(signal, llm, filePath, originalContent): Promise<string | null>`、`buildGenerateProsePrompt(...)`、`stripMarkdownFence(text)`

- [ ] **Step 1: 写失败的测试**

追加到 `apps/cli/test/core/crsi-producer-prose.test.ts`：

````typescript
import { generateProseContent } from '../../src/core/crsi-producer'

describe('generateProseContent', () => {
  it('LLM 返回新内容 → 返回（去 markdown 包裹）', async () => {
    const llm = textLlm(
      '```markdown\n---\nname: memory\ndescription: improved\n---\n\n# Improved\n```',
    )
    const result = await generateProseContent(
      SIGNAL,
      llm,
      'apps/cli/skills/standard/memory.SKILL.md',
      'old',
    )
    expect(result).toContain('name: memory')
    expect(result).not.toContain('```')
  })

  it('LLM 返回空响应 → null', async () => {
    const llm = textLlm('')
    expect(await generateProseContent(SIGNAL, llm, 'f.md', 'old')).toBeNull()
  })
})
````

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test crsi-producer-prose`
Expected: FAIL（generateProseContent 未导出）

- [ ] **Step 3: 写最小实现**

追加到 `apps/cli/src/core/crsi-producer.ts`：

````typescript
const PROSE_GENERATE_PROMPT_VERSION = '1.0.0'

function buildGenerateProsePrompt(
  signal: CrsiSignal,
  filePath: string,
  originalContent: string,
): string {
  return [
    '你是 CRSI producer。基于失败信号，改进目标 skill 的内容。',
    '',
    '失败信号：',
    `- category: ${signal.category}`,
    `- title: ${signal.title}`,
    `- suggestion: ${signal.suggestion}`,
    `- evidence: ${signal.evidence.join(' | ')}`,
    '',
    `目标文件：${filePath}`,
    '',
    '当前内容：',
    originalContent,
    '',
    '请返回改进后的完整 markdown（保持 YAML frontmatter 的 name/description 字段，正文针对失败信号做针对性改进）。只返回 markdown，不要额外说明。',
  ].join('\n')
}

function stripMarkdownFence(text: string): string {
  const match = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/)
  return match ? match[1]! : text
}

export async function generateProseContent(
  signal: CrsiSignal,
  llm: Llm,
  filePath: string,
  originalContent: string,
): Promise<string | null> {
  const prompt = buildGenerateProsePrompt(signal, filePath, originalContent)
  const response = await collectLlmText(llm, prompt)
  if (!response) return null
  return stripMarkdownFence(response)
}
````

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test crsi-producer-prose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/crsi-producer.ts apps/cli/test/core/crsi-producer-prose.test.ts
git commit -m "feat(crsi): producer prose proposal stage 2 — generate prose content (LLM)"
```

---

### Task 3: produceProseProposal 完整编排

**Files:**

- Modify: `apps/cli/src/core/crsi-producer.ts`
- Test: `apps/cli/test/core/crsi-producer-prose.test.ts`

**Interfaces:**

- Consumes: `selectTargetSkill`（Task 1）、`generateProseContent`（Task 2）
- Produces: `ProseProposalResult`、`produceProseProposal(signal, llm, skillFiles, readSkill): Promise<ProseProposalResult | null>`

- [ ] **Step 1: 写失败的测试**

追加到 `apps/cli/test/core/crsi-producer-prose.test.ts`：

```typescript
import { produceProseProposal } from '../../src/core/crsi-producer'

function twoStageLlm(filePath: string, newContent: string): Llm {
  let calls = 0
  return {
    chat: async function* () {
      calls++
      if (calls === 1) yield { type: 'text', content: filePath }
      else yield { type: 'text', content: newContent }
      yield { type: 'stop' }
    },
  }
}

describe('produceProseProposal', () => {
  it('两阶段成功 → 返回提议', async () => {
    const llm = twoStageLlm(
      SKILL_FILES[0]!,
      '---\nname: memory\ndescription: improved\n---\n\n# New body\n',
    )
    const readSkill = (p: string) => (p === SKILL_FILES[0] ? 'OLD-CONTENT' : '')
    const result = await produceProseProposal(SIGNAL, llm, SKILL_FILES, readSkill)
    expect(result).not.toBeNull()
    expect(result!.filePath).toBe(SKILL_FILES[0])
    expect(result!.originalContent).toBe('OLD-CONTENT')
    expect(result!.newContent).toContain('name: memory')
  })

  it('阶段 1 选不到 skill → null', async () => {
    const llm = twoStageLlm('bad-path.md', 'x')
    expect(await produceProseProposal(SIGNAL, llm, SKILL_FILES, () => '')).toBeNull()
  })

  it('读原文失败 → null', async () => {
    const llm = twoStageLlm(SKILL_FILES[0]!, 'x')
    const readSkill = () => {
      throw new Error('no file')
    }
    expect(await produceProseProposal(SIGNAL, llm, SKILL_FILES, readSkill)).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test crsi-producer-prose`
Expected: FAIL（produceProseProposal 未导出）

- [ ] **Step 3: 写最小实现**

追加到 `apps/cli/src/core/crsi-producer.ts`：

```typescript
export interface ProseProposalResult {
  filePath: string
  newContent: string
  originalContent: string
  description: string
}

export async function produceProseProposal(
  signal: CrsiSignal,
  llm: Llm,
  skillFiles: string[],
  readSkill: (filePath: string) => string,
): Promise<ProseProposalResult | null> {
  const filePath = await selectTargetSkill(signal, llm, skillFiles)
  if (!filePath) return null

  let originalContent: string
  try {
    originalContent = readSkill(filePath)
  } catch {
    return null
  }

  const newContent = await generateProseContent(signal, llm, filePath, originalContent)
  if (!newContent) return null

  return { filePath, newContent, originalContent, description: signal.title }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test crsi-producer-prose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/crsi-producer.ts apps/cli/test/core/crsi-producer-prose.test.ts
git commit -m "feat(crsi): producer prose proposal orchestration (two-stage LLM)"
```

---

### 收尾

- [ ] 全量测试 + typecheck + lint + format 全绿
- [ ] 全量测试数对齐（新增 8 个测试）
- [ ] 更新 spec §八.1 标注「可控 MVP 已落地」
