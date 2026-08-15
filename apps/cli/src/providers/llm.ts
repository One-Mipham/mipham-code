import type { Context, Disposer } from '../vajra'
import type { ChatRequest } from './registry'
import type { StreamChunk } from '../shared'

/** LLM 适配缝的 capability —— chat 能力。换 provider = 换 chat 实现，engine 零 fork 跟随。 */
export interface Llm {
  chat(req: ChatRequest): AsyncGenerator<StreamChunk>
}

/** 缝键：ctx.llm。 */
export const LLM_KEY = 'llm'

/** 把一个 Llm（如 ProviderRegistry 或 llm-replay）挂载为 ctx.llm。 */
export function mountLlm(ctx: Context, llm: Llm): Disposer {
  return ctx.provide(LLM_KEY, llm)
}
