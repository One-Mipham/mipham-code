import { describe, it, expect } from 'vitest'
import { SessionWorker } from '../../src/daemon/session-worker'
import type { StreamChunk } from '../../src/shared/types'
import type { DaemonSession, MessageRecord } from '../../src/daemon/types'
import type { ServerMessage } from '../../src/daemon/attach-protocol'

describe('SessionWorker', () => {
  it('getLastAssistantContent 委托给 engine', () => {
    const engine = { getLastAssistantContent: () => '最终回复' } as any
    const worker = new SessionWorker(engine, {} as any, {} as any)
    expect(worker.getLastAssistantContent()).toBe('最终回复')
  })
})

// ── processPrompt：按真实 chunk 序列端到端驱动 ─────────────────────────────
//
// `engine.process()` 在一次调用里跑完整个回合（内部 `yield* continueWithTools()`），
// 所以下面这份脚本就是「这一次 process() 期间真实流出来的全部 chunk」。
//
// **顺序是要害**：`stop` 在 daemon 侧是一个被重载的信号 —— provider 侧的 A 类
// `stop`（`openai-compat.ts:182` / `anthropic.ts:245`，每条 LLM 流结束时**无条件**
// 发出，含工具调用那一轮）与引擎侧的 B 类 `stop`（`engine.ts:668` `yield …; return`，
// 回合真结束）在消费端长得一模一样。A 类夹在中间，工具执行与第二轮全在它之后。
// 顺序写错就复现不出「工具一个都没跑」那个 bug。

const SESSION: DaemonSession = {
  id: 'sess-1',
  name: 'probe',
  cwd: '/tmp/work',
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  status: 'active',
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
  closedAt: null,
  turnCount: 0,
  tokenIn: 0,
  tokenOut: 0,
}

/** 最小假库：只实现 processPrompt 这条路径真正碰到的方法。 */
function makeDb() {
  const savedMessages: Array<{ sessionId: string; role: string; content: string }> = []
  const turns: Array<[number, number]> = []
  const session: DaemonSession = { ...SESSION }

  return {
    savedMessages,
    turns,
    saveMessage(sessionId: string, role: string, content: string) {
      savedMessages.push({ sessionId, role, content })
    },
    incrementTurn(_sessionId: string, tokenIn: number, tokenOut: number) {
      turns.push([tokenIn, tokenOut])
      session.turnCount += 1
      session.tokenIn += tokenIn
      session.tokenOut += tokenOut
    },
    getSession: () => session,
    getMessages: (): MessageRecord[] => [],
  }
}

/** 假 WebSocket：只记下 send() 出去的每一帧。 */
function makeWs() {
  const sent: ServerMessage[] = []
  return {
    sent,
    send(raw: string) {
      sent.push(JSON.parse(raw) as ServerMessage)
    },
  }
}

/** 假引擎：把一整回合的 chunk 原样吐出来，不做任何取舍。 */
function scriptedEngine(chunks: StreamChunk[]) {
  return {
    async *process(_prompt: string, _signal?: AbortSignal) {
      for (const chunk of chunks) yield chunk
    },
    getLastAssistantContent: () => undefined,
    getContext: () => ({ getMessages: () => [] }),
  } as any
}

const CHUNKS: StreamChunk[] = [
  { type: 'text', content: '我先看看' },
  { type: 'usage', inputTokens: 100, outputTokens: 10 },
  {
    type: 'tool_use',
    toolUse: { type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: 'calc.py' } },
  },
  // ↓ A 类 stop：provider 在每条 LLM 流结束时无条件发出 —— 此刻工具还没跑
  { type: 'stop' },
  { type: 'tool_result', tool_use_id: 'c1', content: 'file body' },
  { type: 'text', content: '答案是 42' },
  { type: 'usage', inputTokens: 200, outputTokens: 20 },
  // ↓ B 类 stop：引擎收尾，生成器随后 return
  { type: 'stop' },
]

async function run() {
  const db = makeDb()
  const ws = makeWs()
  const worker = new SessionWorker(scriptedEngine(CHUNKS), db as any, { ...SESSION })
  worker.addClient(ws as any)
  await worker.processPrompt('calc.py 是做什么的？')
  return { db, ws }
}

describe('SessionWorker.processPrompt — 一次回合的真实 chunk 序列', () => {
  it('工具真执行了：A 类 stop 之后的 tool_result 仍广播给客户端', async () => {
    const { ws } = await run()
    const results = ws.sent.filter((m) => m.type === 'tool_result')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ toolId: 'c1', content: 'file body' })
  })

  it('终局内容没丢：第二轮文本落库', async () => {
    const { db } = await run()
    const assistantWrites = db.savedMessages.filter((m) => m.role === 'assistant')
    expect(assistantWrites).toHaveLength(1)
    const assistant = assistantWrites[0]
    if (!assistant) throw new Error('assistant 消息未落库')
    const persisted = JSON.parse(assistant.content) as { content: string }
    expect(persisted.content).toContain('答案是 42')
  })

  it('成本是两轮累加：incrementTurn 收到 (300, 30)', async () => {
    const { db } = await run()
    expect(db.turns).toEqual([[300, 30]])
  })

  it('done 恰好一次 —— 去掉 break 后的新终止路径不得重复收尾', async () => {
    const { ws } = await run()
    expect(ws.sent.filter((m) => m.type === 'done')).toHaveLength(1)
  })
})
