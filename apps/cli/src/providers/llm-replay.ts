import type { Llm } from './llm'
import type { ChatRequest } from './registry'
import type { StreamChunk } from '../shared'

export interface RecordedTurn {
  req: ChatRequest
  chunks: StreamChunk[]
}

/** 包装一个 Llm：委托的同时记录每轮 (req, chunks)。 */
export function recordLlm(inner: Llm): { llm: Llm; turns: RecordedTurn[] } {
  const turns: RecordedTurn[] = []
  const llm: Llm = {
    async *chat(req) {
      const chunks: StreamChunk[] = []
      for await (const chunk of inner.chat(req)) {
        chunks.push(chunk)
        yield chunk
      }
      turns.push({ req, chunks })
    },
  }
  return { llm, turns }
}

/** 回放已记录的 turns（确定性、无网络）。按顺序消费，超出则静默结束。 */
export function replayLlm(turns: RecordedTurn[]): Llm {
  let cursor = 0
  return {
    async *chat() {
      const turn = turns[cursor++]
      if (!turn) return
      for (const chunk of turn.chunks) yield chunk
    },
  }
}
