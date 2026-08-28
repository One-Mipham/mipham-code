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
