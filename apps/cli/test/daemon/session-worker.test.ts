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

async function run(chunks: StreamChunk[] = CHUNKS) {
  const db = makeDb()
  const ws = makeWs()
  const worker = new SessionWorker(scriptedEngine(chunks), db as any, { ...SESSION })
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

  // ── T12-A：成败位必须活着穿到 WS 上 ──────────────────────────────────────
  // 协议侧 `ServerToolResultMessage.isError` 早已声明（attach-protocol.ts:33），
  // 此前从未有人填过。不填 ⇒ 第三方基准驱动只看到一串 tool_result，分不出
  // 「工具跑了」与「工具被拒/报错」，失败归因只能靠解析正文散文。
  it('失败的工具结果带 isError:true 广播出去', async () => {
    const { ws } = await run([
      { type: 'tool_result', tool_use_id: 'c1', content: 'permission denied', isError: true },
    ])
    const results = ws.sent.filter((m) => m.type === 'tool_result')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ toolId: 'c1', isError: true })
  })

  it('成功时 isError:false —— 与失败同形不同值，协议上可判别', async () => {
    const { ws } = await run([{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }])
    const results = ws.sent.filter((m) => m.type === 'tool_result')
    expect(results[0]).toMatchObject({ toolId: 'c1', isError: false })
  })

  // ── 输出被截断：stopReason 必须分得出「撞上限」与「模型自己结束」 ───────────
  // `stopReason` 原是三值常量（end_turn / interrupted / error），含义是「这轮没有
  // 中止、没有抛错」—— **结构上无法表达截断**。provider 侧新加的 `truncated` 标记
  // 若不在这一层被读出来，基准产物读到的仍是一个合法结束。
  it('test_a_truncated_turn_is_reported_as_output_limit', async () => {
    // 会让这条失败的改动：不观察 `chunk.truncated`（截断又落回 end_turn），
    // 或把取值写成 provider 私有的 `'max_tokens'` / `'length'`。
    const { ws } = await run([
      { type: 'text', content: '半截话' },
      { type: 'stop', truncated: true },
    ])
    const done = ws.sent.filter((m) => m.type === 'done')
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ stopReason: 'output_limit' })
  })

  it('抛错的回合不被 output_limit 改写', async () => {
    // 会让这条失败的改动：把 output_limit 写成无条件赋值（覆写更坏的那个事实）。
    const db = makeDb()
    const ws = makeWs()
    const engine = {
      async *process() {
        yield { type: 'stop', truncated: true } as StreamChunk
        throw new Error('boom')
      },
      getLastAssistantContent: () => undefined,
      getContext: () => ({ getMessages: () => [] }),
    } as any
    const worker = new SessionWorker(engine, db as any, { ...SESSION })
    worker.addClient(ws as any)
    await worker.processPrompt('go')

    const done = ws.sent.filter((m) => m.type === 'done')
    expect(done[0]).toMatchObject({ stopReason: 'error' })
  })
})
