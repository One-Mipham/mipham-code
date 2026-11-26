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
  return replayChunks(turns.map((turn) => turn.chunks))
}

/**
 * 只回放响应流、不带请求。
 *
 * `RecordedTurn.req` 里嵌着录制时的完整系统提示（本机 cwd、指令文件内容），
 * 不适合提交进仓库；而回放本就忽略请求。提交的夹具用这个形状。
 */
export function replayChunks(sequences: StreamChunk[][]): Llm {
  let cursor = 0
  return {
    async *chat() {
      const chunks = sequences[cursor++]
      if (!chunks) return
      for (const chunk of chunks) yield chunk
    },
  }
}
