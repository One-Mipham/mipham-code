# LLM Ghost Text 自动补全设计

> **日期**: 2026-08-28
> **作者**: Guohua Zhang · One Mipham Corporation
> **术语**: ghost text = 输入框内淡色的「续写建议」，Tab 接受；自动补全 = 用户打字停顿后 LLM 预测续写；防抖 = debounce，停顿 N ms 才触发；竞态 = stale 结果丢弃（request-id 序列号）
> **前情**: 借鉴 Claude Code 终端版的「淡色建议 + Tab 接受」交互；独立于既有斜杠选择器（`/`）与 @mention 提示

---

## 一、背景与动机

用户反馈：Claude Code 输入框会显示淡色的「建议/提示性回答」，Tab 即可接受，希望 Mipham Code 也能实现。

现状：`input.tsx` 的 `InputBar` 用 `ink-text-input`，已有**静态**提示——斜杠命令提示（`/`）与 @mention 提示（`@`）显示在输入框下方，但**没有**「自由文本的 LLM 预测式续写 + Tab 接受」的 ghost text 能力。

本 spec 新增 B 档能力：用户打自由文本时，停顿后 LLM 生成续写建议，淡色显示在光标后，Tab 接受、其他输入忽略。

---

## 二、目标与非目标

**目标**：

1. 新增纯函数模块 `core/autocomplete.ts`：`buildAutocompleteRequest`（拼 prompt）+ `extractCompletion`（剥前缀取续写）+ `shouldAutocomplete`（触发 guard）——全确定性、可测。
2. `InputBar` 接入 LLM：防抖触发 → `llm.chat` → ghost text 渲染 → Tab 接受 / 其他输入清空 → 竞态丢弃。
3. 配置开关：默认开，`MIPHAM_DISABLE_AUTOCOMPLETE` 强制关。

**非目标**：

- ❌ 斜杠命令 / @mention 的 Tab 补全（A 档）——本 spec 的 ghost text **主动跳过** `/`、`@` 开头输入，避免与现有选择器/提示打架。
- ❌ 自定义补全模型 tier（flash/pro 等）——用 active model（`model: ''` 回退），模型优化另议。
- ❌ 多行补全 / 代码块级补全——只续写当前这一行的自由文本（单行）。
- ❌ 补全结果做「质量自评」——LLM 只生成，用户 Tab 接受/忽略 = 判定在人（A1 铁律）。
- ❌ 改动主对话 `engine.process` 的 streaming 路径——补全是独立 `llm.chat` 调用，不触碰主回复流。

---

## 三、核心设计

### 3.1 纯函数模块 `apps/cli/src/core/autocomplete.ts`

```typescript
import type { ChatRequest } from '../providers/registry'

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
    maxTokens: 64, // 续写短，限长
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
```

### 3.2 配置

`packages/shared/src/types.ts` 加：

```typescript
export interface AutocompleteConfig {
  enabled: boolean
  debounceMs: number
}
```

`MiphamConfig` 加字段 `autocomplete?: Partial<AutocompleteConfig>`。

默认值（`config/defaults.ts`）：`enabled: true`、`debounceMs: 400`。环境变量 `MIPHAM_DISABLE_AUTOCOMPLETE` 存在即强制 `enabled: false`。

### 3.3 `input.tsx` 改造

新 props：

```typescript
interface InputBarProps {
  // …现有…
  llm?: Llm
  recentMessages?: RecentMessage[]
  autocompleteEnabled?: boolean
  autocompleteDebounceMs?: number
}
```

新增状态/ref：

```typescript
const [suggestion, setSuggestion] = useState<string | null>(null)
const suggestionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
const suggestionReqIdRef = useRef(0) // 竞态序列号
```

**触发流程**（onChange 内，批量输入节流之后）：

```typescript
// 每次新输入立即清 suggestion
setSuggestion(null)
const reqId = ++suggestionReqIdRef.current
if (suggestionTimerRef.current) clearTimeout(suggestionTimerRef.current)
if (!autocompleteEnabled || !llm) return
if (!shouldAutocomplete(normalized, isLoading, pickerActive)) return
suggestionTimerRef.current = setTimeout(async () => {
  try {
    const req = buildAutocompleteRequest(recentMessages ?? [], normalized)
    let text = ''
    for await (const chunk of llm.chat(req)) {
      if (chunk.type === 'text' && chunk.content) text += chunk.content
    }
    // 竞态：期间又输入了 → 丢弃 stale 结果
    if (reqId !== suggestionReqIdRef.current) return
    const completion = extractCompletion(text, normalized)
    if (completion) setSuggestion(completion)
  } catch {
    // 补全失败非关键——静默忽略
  }
}, autocompleteDebounceMs ?? 400)
```

**Tab 接受**（`useInput` 内，`key.shift && key.tab` 分支之后）：

```typescript
if (key.tab && !key.shift && suggestion) {
  const next = valueRef.current + suggestion
  setValue(next)
  valueRef.current = next
  setSuggestion(null)
  return
}
```

（注：ink-text-input 可能对 Tab 有默认行为，实现时复用现有 Ctrl-key 的「revert ink-text-input 插入」手法，在 plan 中钉死。）

**渲染**（`TextInput` 之后，同一行）：

```typescript
<TextInput value={value} … />
{suggestion && (
  <Text dimColor>{suggestion}</Text>
)}
```

### 3.4 `app.tsx` 接线

`InputBar` 传：

```typescript
<InputBar
  llm={engine.getLlm() ?? engine.getRegistry()}
  recentMessages={recentMessages}  // 从 messages 取最后 AUTOCOMPLETE_MAX_CONTEXT 条 {role,content}
  autocompleteEnabled={config.autocomplete?.enabled ?? true}
  autocompleteDebounceMs={config.autocomplete?.debounceMs ?? 400}
  …现有 props…
/>
```

`recentMessages` 用 `useMemo` 从 `messages` 派生（取最后 6 条 `{role,content}`），避免每渲染重建。

---

## 四、A1 铁律边界

自动补全是**纯生成**：LLM 只产出「续写候选」，质量判定完全在**用户**（Tab 接受 / 继续打字忽略）。零 LLM 自评、零「采纳自己生成的建议」——不触碰 CRSI 的「LLM 只生成不判定」铁律。`extractCompletion`/`shouldAutocomplete` 是确定性字符串/布尔逻辑。

---

## 五、里程碑

| 里程碑 | 内容                                                              | 交付物     |
| ------ | ----------------------------------------------------------------- | ---------- |
| **A1** | `core/autocomplete.ts` 纯函数 + 配置字段/默认值 + 环境变量 + 测试 | 可测纯逻辑 |
| **A2** | `input.tsx` 防抖/竞态/渲染/Tab 接受 + `app.tsx` 接线              | 端到端可跑 |

A1/A2 一个 plan 两阶段（A2 依赖 A1 的导出与配置字段）。

---

## 六、测试

- **buildAutocompleteRequest**：messages 尾含 `{role:'user',content:input}`；`model:''`；`temperature:0`；`maxTokens:64`；只带最近 N 条。
- **extractCompletion**：返回纯续写（剥 input 前缀）；LLM 返回空 → null；LLM 返回全文含前缀 → 剥掉；返回仅前缀 → null。
- **shouldAutocomplete**：空/`/`/`@`/loading/pickerActive → false；正常自由文本 → true。
- **A2（组件级，mock llm）**：防抖后触发 llm；stale 结果丢弃（快速连续输入只显示最后一次）；Tab 接受 = value+suggestion；新输入清 suggestion；`MIPHAM_DISABLE_AUTOCOMPLETE` 时 llm 不被调。
- **无回归**：现有 1976 测试全绿（纯新增，不动现有 input/engine 路径）。

---

## 七、风险与开放问题

1. **【成本/限流】** 默认开 + 每次停顿调 LLM → 频繁小请求。缓解：防抖 400ms + `maxTokens:64` + 可关（env/config）+ 静默失败。若未来 provider 限流告警，再加「每会话补全次数上限」或「短间隔内不重触发」。
2. **【与主回复流并发】** 补全 `llm.chat` 与主 `engine.process` 共用 provider，可能并发打同一 API key。缓解：补全短请求 + 可取消（`signal` 字段留空未接，未来可接 AbortSignal）。当前先接受并发，观察。
3. **【ghost text 渲染精度】** `ink-text-input` 光标后有 `dimColor` 续写文本，视觉上「建议紧跟光标」，但非真·inline ghost text（那是终端特性）。可接受——Claude Code 终端版也是近似。若追求更精准，需自研 input 渲染（成本高，非目标）。
4. **【Tab 的 ink-text-input 冲突】** ink-text-input 可能对 Tab 有默认行为（插入 tab 字符/移动光标），需 revert（复用 Ctrl-key 手法）。实现时用真实交互验证。
5. **【active model 成本】** 用 active model（可能是大模型）续写较慢/贵。缓解：`maxTokens` 限长；若嫌贵，未来加 `autocomplete.model` 配置指定 flash 等低价 tier（非目标，回访触发）。

---

## 八、决策记录（岔路口）

| # | 岔路口 | 选项 | 选了 | 为何（否决项理由） | 推迟的 | 回访触发 |
| --- | --- | --- | --- | --- | --- |
| 1 | 默认开关 | A 默认关 / B 默认开+开关关 | B | Claude Code 同款「开箱即用」；成本由防抖+限长+可关兜底 | — | 成本/限流告警时 |
| 2 | 上下文深度 | A 只当前输入 / B 当前+最近上下文 | B | 带上下文建议更贴合（Claude Code 同款）；代价是 prompt 略大，由 maxTokens 限长兜底 | — | — |
| 3 | 模型 tier | A active / B 便宜 tier | A | 简化（`model:''` 回退）；模型优化是独立关注点 | autocomplete.model 配置 | 嫌贵/慢时 |
| 4 | A 档是否并入 | A 并入 / B 独立 | B | ghost text 与斜杠/mention 是两类输入；且 ghost text 主动跳过 `/`/`@` | A 档 @mention Tab 补全 | 用户要 @mention Tab 补全时 |
| 5 | 纯逻辑归属 | A 内联 input.tsx / B 抽 core/autocomplete.ts | B | 拼 prompt/剥前缀/guard 是纯函数，抽出来可单测（A1 确定性可证），组件只做接线 | — | — |

---

## Self-Review 记录

- **接口一致性**：`buildAutocompleteRequest` 返回 `ChatRequest`（`model`/`messages`/`systemPrompt`/`temperature`/`maxTokens` 与 registry.ts:12-22 一致）；`RecentMessage` 形状 `{role,content}` 与 app.tsx 派生一致（§3.1/§3.4）。
- **A1 不破**：LLM 只生成续写，用户 Tab 接受/忽略 = 判定在人；`extractCompletion`/`shouldAutocomplete` 确定性（§四）。
- **竞态安全**：`suggestionReqIdRef` 序列号，stale 结果丢弃；每次输入清 suggestion（§3.3）。
- **成本兜底**：防抖 + maxTokens 64 + 可关（env/config）+ 静默失败（§七.1）。
- **诚实边界**：ghost text 是「建议紧跟光标」的近似渲染，非真 inline（§七.3）；active model 成本风险已标注（§七.5）。
- **无占位符**：三个纯函数、配置字段、触发/Tab/渲染流程、测试点均给具体实现。
