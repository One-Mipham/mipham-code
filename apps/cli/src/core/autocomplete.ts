import type { ChatRequest } from '../providers/registry'
import type { Llm } from '../providers/llm'

export const AUTOCOMPLETE_SYSTEM_PROMPT =
  '你是续写助手。只续写用户正在输入的这条消息，只返回续写部分（不要重复已输入的文字、不要解释、不要换行）。'

/** 带上最近几条对话（含待续写输入），供续写贴合上下文。 */
export const AUTOCOMPLETE_MAX_CONTEXT = 6

/**
 * 每条上下文消息最多带这么多**字符**（保留尾部）。
 *
 * 上面那个常数限的是**条数**，而一条 `content` 可以任意长 —— 贴进来一个文件、
 * 或一条长回复，6 条就是上万 token，而用户每次 >400ms 的停顿都要买一次。
 * 续写要看的是「刚说到哪儿」，所以砍头留尾；加 `…` 是免得把片段读成消息开头。
 * 每条封顶 + 条数封顶，总量就是封死的，不需要再维护第二个预算常数。
 */
export const AUTOCOMPLETE_MAX_CHARS_PER_MESSAGE = 2000

export interface RecentMessage {
  role: 'user' | 'assistant'
  content: string
}

function tailOf(content: string): string {
  return content.length <= AUTOCOMPLETE_MAX_CHARS_PER_MESSAGE
    ? content
    : '…' + content.slice(-AUTOCOMPLETE_MAX_CHARS_PER_MESSAGE)
}

/** 拼续写请求：systemPrompt + 最近 N 条（每条限长）+ 当前输入作为待续写消息。 */
export function buildAutocompleteRequest(recent: RecentMessage[], input: string): ChatRequest {
  return {
    model: '', // falsy → registry 回退 active model
    // 待续写的当前输入**不截断**：它是被续写的那条本身，且 extractCompletion 的
    // 判据依赖它的完整值。上限落在历史消息上。
    messages: [
      ...recent
        .slice(-AUTOCOMPLETE_MAX_CONTEXT)
        .map((m) => ({ role: m.role, content: tailOf(m.content) })),
      { role: 'user', content: input },
    ],
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
    // 用户又敲了一下 ⇒ 这条请求已经过期，当场走人。`break` 不只是「不再读」：
    // 它触发生成器的 `.return()` ⇒ provider 的 `finally` ⇒ `reader.cancel()`，
    // 连接当场释放。若把这一判挪到循环外，就等于**先把整条流读完**再丢掉结果 ——
    // 那正是「取消不掉」：每次 >400ms 的停顿都买一个完整 completion。
    if (isStale()) break
    if (chunk.type === 'text' && chunk.content) text += chunk.content
  }
  if (isStale()) return null
  return extractCompletion(text, input)
}
