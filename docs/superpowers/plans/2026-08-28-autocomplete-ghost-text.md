# LLM Ghost Text 自动补全 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增自由文本的 LLM 预测式续写（ghost text）——打字停顿 400ms 后 LLM 生成续写建议，淡色显示在光标后，Tab 接受、其他输入忽略。默认开，`MIPHAM_DISABLE_AUTOCOMPLETE` 关。

**Architecture:** 抽 `core/autocomplete.ts` 纯函数模块（拼 prompt / 剥前缀 / 触发 guard / 异步取建议），组件 `input.tsx` 只做接线（防抖 + 竞态 ref + 渲染 + Tab）。LLM 只生成续写，用户 Tab 接受/忽略 = 判定在人（A1 铁律）。

**Tech Stack:** Bun、Vitest 3、TypeScript strict、Ink 5、ink-text-input。

**Spec:** `docs/superpowers/specs/2026-08-28-autocomplete-ghost-text-design.md`

## Global Constraints

- A1 铁律：LLM 只生成续写候选，判定在人（Tab 接受/忽略），零 LLM 自评。
- 补全**跳过** `/`、`@` 开头输入（不与斜杠选择器/mention 提示打架）。
- 补全用 active model（`model: ''` 回退），`maxTokens: 64` 限长。
- 默认 `enabled: true`、`debounceMs: 400`；`MIPHAM_DISABLE_AUTOCOMPLETE` 环境变量强制关。
- 提交信息 Conventional Commits + `Co-Authored-By: Mipham <noreply@mipham.ai>`。
- 测试：`cd apps/cli && pnpm vitest run <file>`；typecheck：`cd apps/cli && pnpm typecheck`；全量：`cd apps/cli && pnpm test`。

## Reconciliation（spec 与现状的出入，实现者必读）

1. **spec §3.3 内联异步逻辑 → 抽 `requestSuggestion`**：spec 把「llm.chat + 竞态丢弃 + 剥前缀」内联在 onChange 的 setTimeout 里，无法单测。本 plan 抽成 `requestSuggestion(llm, recent, input, isStale)` 纯异步函数（归 `core/autocomplete.ts`），组件只做防抖计时 + `isStale` 闭包（`reqId` 比对）+ `setSuggestion`。这让「异步取建议 + 竞态 + 剥前缀」可测（A1 覆盖），组件 A2 只剩薄接线。
2. **A2 组件级测试延后**：spec §六 列「A2 组件级 mock llm 测试」，但本仓库无 Ink 组件测试先例（`input.tsx` 等 UI 组件从未单测）。核心逻辑（拼 prompt/剥前缀/guard/异步取建议/竞态）已全部抽进 A1 的纯函数 + `requestSuggestion`，A2 验证 = typecheck + 现有测试全绿。组件测试留待「Ink 组件测试框架」单独引入（非本 plan 范围）。
3. **`ChatMessage.content` 是 `string`**（app.tsx:79-83，UI 层已展平），派生 `recentMessages` 无需处理 `ContentBlock[]`。

---

## File Structure

| 文件                                      | 动作   | 职责                                                                                                                            |
| ----------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/types.ts`            | Modify | Task A1：`AutocompleteConfig` + `MiphamConfig.autocomplete?`                                                                    |
| `apps/cli/src/config/defaults.ts`         | Modify | Task A1：`autocomplete: { enabled: true, debounceMs: 400 }`                                                                     |
| `apps/cli/src/core/autocomplete.ts`       | Create | Task A1：常量 + `RecentMessage` + `buildAutocompleteRequest` + `extractCompletion` + `shouldAutocomplete` + `requestSuggestion` |
| `apps/cli/test/core/autocomplete.test.ts` | Create | Task A1：四函数全量测试                                                                                                         |
| `apps/cli/src/ui/input.tsx`               | Modify | Task A2：props + 防抖/竞态/渲染/Tab 接受                                                                                        |
| `apps/cli/src/ui/app.tsx`                 | Modify | Task A2：传 llm + recentMessages + config 开关                                                                                  |

---

## Task A1: `core/autocomplete.ts` 纯函数 + 配置

**Files:**

- Modify: `packages/shared/src/types.ts`
- Modify: `apps/cli/src/config/defaults.ts`
- Create: `apps/cli/src/core/autocomplete.ts`
- Test: `apps/cli/test/core/autocomplete.test.ts`（新建）

**Interfaces:**

- Consumes: `ChatRequest`（providers/registry.ts）、`Llm`（providers/llm.ts）
- Produces:
  - `export const AUTOCOMPLETE_SYSTEM_PROMPT: string`
  - `export const AUTOCOMPLETE_MAX_CONTEXT: number`（= 6）
  - `export interface RecentMessage { role: 'user' | 'assistant'; content: string }`
  - `export function buildAutocompleteRequest(recent: RecentMessage[], input: string): ChatRequest`
  - `export function extractCompletion(response: string, input: string): string | null`
  - `export function shouldAutocomplete(value: string, isLoading: boolean, pickerActive: boolean): boolean`
  - `export async function requestSuggestion(llm: Llm, recent: RecentMessage[], input: string, isStale: () => boolean): Promise<string | null>`

- [ ] **Step 1: 写失败测试**

`apps/cli/test/core/autocomplete.test.ts`（新建）：

```typescript
import { describe, it, expect } from 'vitest'
import type { Llm } from '../../src/providers/llm'
import {
  buildAutocompleteRequest,
  extractCompletion,
  shouldAutocomplete,
  requestSuggestion,
  AUTOCOMPLETE_MAX_CONTEXT,
} from '../../src/core/autocomplete'

function textLlm(text: string): Llm {
  return {
    chat: async function* () {
      yield { type: 'text', content: text }
      yield { type: 'stop' }
    },
  }
}

describe('buildAutocompleteRequest', () => {
  it('拼出续写请求：active model + 限长 + 尾含待续写输入', () => {
    const req = buildAutocompleteRequest(
      [
        { role: 'user', content: '写一个排序函数' },
        { role: 'assistant', content: '好的' },
      ],
      '请用快速',
    )
    expect(req.model).toBe('')
    expect(req.temperature).toBe(0)
    expect(req.maxTokens).toBe(64)
    expect(req.systemPrompt).toContain('续写')
    expect(req.messages[req.messages.length - 1]).toEqual({ role: 'user', content: '请用快速' })
  })

  it('只带最近 N 条上下文', () => {
    const recent = Array.from({ length: 10 }, (_, i) => ({
      role: 'user' as const,
      content: `msg ${i}`,
    }))
    const req = buildAutocompleteRequest(recent, 'x')
    // AUTOCOMPLETE_MAX_CONTEXT 条 + 当前输入
    expect(req.messages.length).toBe(AUTOCOMPLETE_MAX_CONTEXT + 1)
  })
})

describe('extractCompletion', () => {
  it('剥掉 input 前缀返回纯续写', () => {
    expect(extractCompletion('请用快速排序数组', '请用快速')).toBe('排序数组')
  })
  it('LLM 返回空 → null', () => {
    expect(extractCompletion('  ', 'x')).toBeNull()
  })
  it('返回仅前缀 → null', () => {
    expect(extractCompletion('请用快速', '请用快速')).toBeNull()
  })
  it('不重复前缀时原样返回', () => {
    expect(extractCompletion('排序数组', '请用快速')).toBe('排序数组')
  })
})

describe('shouldAutocomplete', () => {
  it('空 / / 开头 / @ 开头 / loading / picker → false', () => {
    expect(shouldAutocomplete('', false, false)).toBe(false)
    expect(shouldAutocomplete('/help', false, false)).toBe(false)
    expect(shouldAutocomplete('@alice', false, false)).toBe(false)
    expect(shouldAutocomplete('正常', true, false)).toBe(false)
    expect(shouldAutocomplete('正常', false, true)).toBe(false)
  })
  it('正常自由文本 → true', () => {
    expect(shouldAutocomplete('写一个', false, false)).toBe(true)
  })
})

describe('requestSuggestion', () => {
  it('返回剥前缀后的续写', async () => {
    const s = await requestSuggestion(textLlm('请用快速排序数组'), [], '请用快速', () => false)
    expect(s).toBe('排序数组')
  })
  it('stale → null（丢弃过期结果）', async () => {
    const s = await requestSuggestion(textLlm('排序数组'), [], 'x', () => true)
    expect(s).toBeNull()
  })
  it('LLM 返回空 → null', async () => {
    const s = await requestSuggestion(textLlm(''), [], 'x', () => false)
    expect(s).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/core/autocomplete.test.ts`
Expected: FAIL（`autocomplete` 模块不存在）。

- [ ] **Step 3: 实现 `core/autocomplete.ts` + 配置**

**3a. `apps/cli/src/core/autocomplete.ts`**（新建）：

```typescript
import type { ChatRequest } from '../providers/registry'
import type { Llm } from '../providers/llm'

export const AUTOCOMPLETE_SYSTEM_PROMPT =
  '你是续写助手。只续写用户正在输入的这条消息，只返回续写部分（不要重复已输入的文字、不要解释、不要换行）。'

/** 带上最近几条对话（含待续写输入），供续写贴合上下文。 */
export const AUTOCOMPLETE_MAX_CONTEXT = 6

export interface RecentMessage {
  role: 'user' | 'assistant'
  content: string
}

/** 拼续写请求：systemPrompt + 最近 N 条 + 当前输入作为待续写消息。 */
export function buildAutocompleteRequest(recent: RecentMessage[], input: string): ChatRequest {
  return {
    model: '', // falsy → registry 回退 active model
    messages: [...recent.slice(-AUTOCOMPLETE_MAX_CONTEXT), { role: 'user', content: input }],
    systemPrompt: AUTOCOMPLETE_SYSTEM_PROMPT,
    temperature: 0,
    maxTokens: 64,
  }
}

/** 剥掉 LLM 可能重复的 input 前缀，返回纯续写 suffix；空/无效 → null。 */
export function extractCompletion(response: string, input: string): string | null {
  let completion = response.trim()
  if (!completion) return null
  const normInput = input.trim()
  if (normInput && completion.startsWith(normInput)) {
    completion = completion.slice(normInput.length).trimStart()
  }
  return completion || null
}

/** 触发 guard：非空、非 `/`·`@` 开头、非 loading、无活跃 picker。 */
export function shouldAutocomplete(
  value: string,
  isLoading: boolean,
  pickerActive: boolean,
): boolean {
  if (!value.trim()) return false
  if (value.startsWith('/') || value.startsWith('@')) return false
  if (isLoading) return false
  if (pickerActive) return false
  return true
}

/** 异步取建议：llm.chat → 竞态检查（isStale）→ 剥前缀。stale / 空 → null。 */
export async function requestSuggestion(
  llm: Llm,
  recent: RecentMessage[],
  input: string,
  isStale: () => boolean,
): Promise<string | null> {
  const req = buildAutocompleteRequest(recent, input)
  let text = ''
  for await (const chunk of llm.chat(req)) {
    if (chunk.type === 'text' && chunk.content) text += chunk.content
  }
  if (isStale()) return null
  return extractCompletion(text, input)
}
```

**3b. `packages/shared/src/types.ts`** —— `MiphamConfig` 接口内加字段（约 line 152 `crsi?` 之后）：

```typescript
  /** Ghost-text 自动补全（输入续写）。默认 enabled: true、debounceMs: 400。 */
  autocomplete?: Partial<AutocompleteConfig>
```

并在文件里加：

```typescript
export interface AutocompleteConfig {
  enabled: boolean
  debounceMs: number
}
```

**3c. `apps/cli/src/config/defaults.ts`** —— `DEFAULT_CONFIG` 内加（约 line 19 `showCommandPicker: false` 之后）：

```typescript
  autocomplete: {
    enabled: true,
    debounceMs: 400,
  },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm vitest run test/core/autocomplete.test.ts`
Expected: PASS（11 测试绿）。

- [ ] **Step 5: typecheck**

Run: `cd apps/cli && pnpm typecheck` → 0 error；`cd /Users/sarvadaya/Rismed_Ronxin_Capital/One_Mipham_Corporation/mipham-code && pnpm -r typecheck` → 0 error（packages/shared 变更也过）。

- [ ] **Step 6: Commit**

```bash
cd apps/cli && git add src/core/autocomplete.ts test/core/autocomplete.test.ts src/config/defaults.ts ../../packages/shared/src/types.ts
git commit -m "feat(ui): ghost-text 自动补全纯函数——拼 prompt/剥前缀/guard/异步取建议

Co-Authored-By: Mipham <noreply@mipham.ai>"
```

（注：`packages/shared` 与 `apps/cli` 同属 monorepo 根，用相对或根路径 `git add` 均可，确保 4 个文件都 staged。）

---

## Task A2: `input.tsx` 接线 + `app.tsx` 传参

**Files:**

- Modify: `apps/cli/src/ui/input.tsx`
- Modify: `apps/cli/src/ui/app.tsx`

**Interfaces:**

- Consumes: `buildAutocompleteRequest`（不用，直接 `requestSuggestion`）、`requestSuggestion`、`shouldAutocomplete`、`RecentMessage`、`AUTOCOMPLETE_MAX_CONTEXT`（autocomplete.ts，Task A1 产出）、`Llm`（providers/llm.ts）
- Produces: `InputBar` 新 props（`llm`/`recentMessages`/`autocompleteEnabled`/`autocompleteDebounceMs`）+ ghost text 渲染 + Tab 接受

- [ ] **Step 1: `input.tsx` 改造**

**1a.** 顶部 import 加：

```typescript
import { requestSuggestion, shouldAutocomplete, type RecentMessage } from '../core/autocomplete'
import type { Llm } from '../providers/llm'
```

**1b.** `InputBarProps` 接口加字段（`onCancel?` 之后、`showCommandPicker?` 之前或之后均可）：

```typescript
  /** LLM 续写建议所需的模型（app.tsx 传 engine.getLlm() ?? engine.getRegistry()）。 */
  llm?: Llm
  /** 最近对话上下文（供续写贴合）。 */
  recentMessages?: RecentMessage[]
  /** 默认 true；app.tsx 传 config.autocomplete?.enabled ?? true。 */
  autocompleteEnabled?: boolean
  /** 默认 400ms；app.tsx 传 config.autocomplete?.debounceMs ?? 400。 */
  autocompleteDebounceMs?: number
```

**1c.** 解构新 props（`showCommandPicker = true,` 之后加）：

```typescript
  llm,
  recentMessages,
  autocompleteEnabled = true,
  autocompleteDebounceMs = 400,
```

**1d.** 新增状态/ref（`savedDraftRef` 之后）：

```typescript
// ── Ghost-text 自动补全 ──
const [suggestion, setSuggestion] = useState<string | null>(null)
const suggestionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
const suggestionReqIdRef = useRef(0)
```

**1e.** `useInput` 里 `key.shift && key.tab` 分支之后加 Tab 接受：

```typescript
// Tab → 接受 ghost-text 建议（复用 Ctrl-key 的 revert 手法）
if (key.tab && !key.shift && suggestion) {
  const next = valueBeforeShortcut.current + suggestion
  setValue(next)
  valueRef.current = next
  setSuggestion(null)
  return
}
```

**1f.** `TextInput` 的 `onChange` 里，`const normalized = val.replace(/\n/g, ' ')` 之后、`const bulk = ...` 之前，插入补全触发（在批量节流逻辑之前清 suggestion + 重排防抖）：

```typescript
// ── Ghost-text 自动补全：每次输入清 suggestion + 重排防抖 ──
setSuggestion(null)
const suggestionReqId = ++suggestionReqIdRef.current
if (suggestionTimerRef.current) {
  clearTimeout(suggestionTimerRef.current)
  suggestionTimerRef.current = null
}
if (llm && autocompleteEnabled && shouldAutocomplete(normalized, isLoading, pickerActive)) {
  suggestionTimerRef.current = setTimeout(() => {
    requestSuggestion(
      llm,
      recentMessages ?? [],
      normalized,
      () => suggestionReqId !== suggestionReqIdRef.current,
    )
      .then((completion) => {
        if (completion) setSuggestion(completion)
      })
      .catch(() => {
        // 补全失败非关键——静默忽略
      })
  }, autocompleteDebounceMs)
}
```

**1g.** `TextInput` 之后渲染 ghost text（`<TextInput … />` 闭合后）：

```typescript
          {suggestion && <Text dimColor>{suggestion}</Text>}
```

- [ ] **Step 2: `app.tsx` 传参**

**2a.** 顶部 import 加：

```typescript
import { AUTOCOMPLETE_MAX_CONTEXT, type RecentMessage } from '../core/autocomplete'
```

**2b.** 组件内派生 `recentMessages`（`messages` state 之后）：

```typescript
const recentMessages = useMemo<RecentMessage[]>(
  () =>
    messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-AUTOCOMPLETE_MAX_CONTEXT)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
  [messages],
)
```

**2c.** `<InputBar …>` 加 4 个 prop：

```typescript
                <InputBar
                  llm={engine.getLlm() ?? engine.getRegistry()}
                  recentMessages={recentMessages}
                  autocompleteEnabled={
                    !process.env.MIPHAM_DISABLE_AUTOCOMPLETE && (config.autocomplete?.enabled ?? true)
                  }
                  autocompleteDebounceMs={config.autocomplete?.debounceMs ?? 400}
                  onSubmit={handleSubmit}
                  …（其余不变）
```

- [ ] **Step 3: typecheck**

Run: `cd apps/cli && pnpm typecheck`
Expected: 0 error。

- [ ] **Step 4: 全量回归**

Run: `cd apps/cli && pnpm test`
Expected: 全绿（A1 新增 11 测试 + 现有 1976 无回归）。

- [ ] **Step 5: Commit**

```bash
cd apps/cli && git add src/ui/input.tsx src/ui/app.tsx
git commit -m "feat(ui): ghost-text 自动补全接线——防抖/竞态/渲染/Tab 接受 + app 传参

Co-Authored-By: Mipham <noreply@mipham.ai>"
```

---

## Self-Review

- **Spec 覆盖**：§3.1（纯函数）→ Task A1 Step 3a；§3.2（配置）→ A1 Step 3b/3c；§3.3（input 改造）→ A2 Step 1；§3.4（app 接线）→ A2 Step 2；§六（测试）→ A1 Step 1。
- **占位符扫描**：无 TBD/TODO；每步给完整可跑代码。
- **类型一致性**：`RecentMessage`/`buildAutocompleteRequest`/`extractCompletion`/`shouldAutocomplete`/`requestSuggestion`/`AUTOCOMPLETE_MAX_CONTEXT` 在 A1 定义，A2 与测试消费同名同形；`AutocompleteConfig` 在 types.ts 定义，defaults.ts 与 app.tsx 消费一致。
- **A1 不破**：LLM 只生成续写，Tab 接受/忽略判定在人（§Global Constraints）。
- **Reconciliation 落实**：spec §3.3 内联逻辑抽成 `requestSuggestion`（§Reconciliation #1）；A2 组件测试延后、核心逻辑由 A1 覆盖（#2）；`ChatMessage.content` 是 string（#3）。
