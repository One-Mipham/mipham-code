import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  SessionLog,
  closeInterruptedToolCalls,
  deriveMessages,
  assertModelVisible,
  sanitizeSessionName,
  type SessionEvent,
} from '../../src/core/session-log'
import { ContextManager } from '../../src/core/context'
import type { Message } from '../../src/shared/types'

/**
 * A session whose log holds a tool call that nothing answers.
 *
 * Replayed as-is that history is not a history a provider will accept: an
 * assistant message carrying `tool_calls` must be followed by a result for each
 * of them (OpenAI/DeepSeek reject the whole request otherwise, and Anthropic
 * requires the `tool_result` block immediately after). So a resumed session
 * broke on its *next* message with a protocol error, which reads as "resume is
 * broken", not "the last call never finished".
 *
 * Where that log comes from is checked, not assumed: the engine logs the call
 * immediately before its result in one synchronous block, and the buffer is
 * flushed only on exit — so a process killed mid-tool-call leaves no call on
 * disk at all. The reachable route is the **read** side (`save()` appends line
 * by line, `open()` silently drops lines it cannot parse), which the last
 * describe below walks end to end on a real file.
 *
 * The repair appends the missing result **as an event**: the model then sees the
 * call and is told the outcome is unknown. It cannot be an unlogged message
 * pushed onto the context — the repository's invariant is that whatever the
 * model can see is in the log (`assertModelVisible`), and it is asserted below.
 */

function events(...rest: SessionEvent[]): SessionEvent[] {
  return [
    { type: 'session/start', at: 1, sessionId: 's1' },
    { type: 'user/message', at: 2, message: { role: 'user', content: 'run the thing' } },
    ...rest,
  ]
}

function logWith(...rest: SessionEvent[]): SessionLog {
  const log = new SessionLog('interrupted')
  for (const e of events(...rest)) log.append(e)
  return log
}

const CALL: SessionEvent = {
  type: 'tool/call',
  at: 3,
  id: 'call_1',
  name: 'probe',
  input: {},
}

function toolResults(events: SessionEvent[]): string[] {
  return deriveMessages(events)
    .filter((m) => Array.isArray(m.content))
    .flatMap((m) => m.content as Array<{ type: string; tool_use_id?: string }>)
    .filter((b) => b.type === 'tool_result')
    .map((b) => b.tool_use_id!)
}

describe('resuming a session that ended during a tool call', () => {
  it('replays the unanswered call as-is — which is the shape no provider accepts', () => {
    // The premise of this file, checked rather than assumed: without the repair
    // the projection asks for a call and never answers it.
    const log = logWith(CALL)
    const derived = deriveMessages(log.events())

    expect(derived.at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'probe' }],
    })
    expect(toolResults(log.events())).toEqual([])
  })

  it('tells the model the call happened and that its outcome is unknown', () => {
    const log = logWith(CALL)

    expect(closeInterruptedToolCalls(log)).toBe(1)

    const derived = deriveMessages(log.events())
    const result = derived.at(-1)
    expect(result?.role).toBe('user')
    const block = (
      result!.content as Array<{ type: string; tool_use_id: string; content: string }>
    )[0]!
    expect(block.type).toBe('tool_result')
    expect(block.tool_use_id).toBe('call_1')
    expect(block.content).toMatch(/unknown/i)
    // The call itself is still visible — the model is not left guessing what it
    // was in the middle of.
    expect(JSON.stringify(derived)).toContain('probe')
  })

  it('does nothing to a call that was answered, and nothing the second time', () => {
    const answered = logWith(CALL, {
      type: 'tool/result',
      at: 4,
      id: 'call_1',
      result: { success: true, content: 'probe done' },
    })
    expect(closeInterruptedToolCalls(answered)).toBe(0)
    expect(answered.events()).toHaveLength(events(CALL).length + 1)
    expect(answered.events().filter((e) => e.type === 'tool/result')).toHaveLength(1)

    const log = logWith(CALL)
    expect(closeInterruptedToolCalls(log)).toBe(1)
    const after = log.events().length
    expect(closeInterruptedToolCalls(log)).toBe(0)
    expect(log.events()).toHaveLength(after)
  })

  it('closes every unanswered call, not just the last one', () => {
    // 两条没结果、一条有 —— 「全都补」与「只补最后一条」在这里才分得开：
    // 若只留一条未答的调用，两种实现给出同一个读数，这条用例就名不副实了。
    const log = logWith(
      CALL,
      { type: 'tool/call', at: 4, id: 'call_2', name: 'other', input: {} },
      { type: 'tool/result', at: 5, id: 'call_2', result: { success: true, content: 'ok' } },
      { type: 'tool/call', at: 6, id: 'call_3', name: 'third', input: {} },
    )
    expect(closeInterruptedToolCalls(log)).toBe(2)
    expect(toolResults(log.events()).sort()).toEqual(['call_1', 'call_2', 'call_3'])
  })

  it('counts a result that is embedded in a multi-block user message as an answer', () => {
    // `messageToEvents` 只把「整条就是一个 tool_result」的消息拆成 `tool/result` 事件；
    // 多块消息（结果 + 别的内容）整条留在 `user/message` 里。扫描只看事件类型的话，
    // 这类**已经答过**的调用会被再答一遍。
    const log = logWith(CALL, {
      type: 'user/message',
      at: 4,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'probe done' },
          { type: 'text', text: 'and now this' },
        ],
      },
    })
    expect(closeInterruptedToolCalls(log)).toBe(0)
    expect(toolResults(log.events())).toEqual(['call_1'])
  })
})

describe('ContextManager.restoreLog with an interrupted tail', () => {
  function restore(log: SessionLog): ContextManager {
    const context = new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.9 })
    context.restoreLog(log)
    return context
  }

  it('restores the call with its unknown outcome, and logs what it restored', () => {
    const log = logWith(CALL)
    const context = restore(log)

    const messages: Message[] = context.getMessages()
    expect(JSON.stringify(messages)).toContain('"type":"tool_result"')

    // The invariant that rules out the shortcut (pushing a message the log never
    // saw): whatever the model can see has to be in the log.
    expect(() => assertModelVisible(log.events(), messages)).not.toThrow()
    expect(log.events().filter((e) => e.type === 'tool/result')).toHaveLength(1)
  })

  it('leaves a clean log exactly as it was', () => {
    const log = logWith(CALL, {
      type: 'tool/result',
      at: 4,
      id: 'call_1',
      result: { success: true, content: 'probe done' },
    })
    const before = JSON.parse(JSON.stringify(log.events()))
    const context = restore(log)

    expect(log.events()).toEqual(before)
    expect(context.getMessages()).toHaveLength(3)
  })
})

describe('the shape this can actually arrive in: a half-written tail on disk', () => {
  /**
   * 上面几条用例都在内存里造出「有调用、没结果」的日志。**盘上那份真能长成这样吗？**
   * 这条用例把那条路走完，而不是假设它存在。
   *
   * 引擎自己的日志顺序到不了这个形状：调用消息与它的结果在同一个同步块里相邻落
   * （`engine.ts` 先 `addMessage(tool_use)` 再 `addToolResult`），而这批事件只在退出
   * 时整份刷盘。够得着的是**读侧**：`save()` 逐行追加，`open()` 把读不动的行静默丢掉
   * （半截 JSON 过不了 `JSON.parse`）—— 写盘写到一半被杀，最后那行半截结果被丢，
   * 上一次调用就在盘上失去了结果。于是恢复之后的第一句话被整条拒收。
   */
  const SESSIONS_DIR = join(homedir(), '.mipham', 'sessions')

  function writeTruncated(name: string): string {
    mkdirSync(SESSIONS_DIR, { recursive: true })
    const path = join(SESSIONS_DIR, `${sanitizeSessionName(name)}.jsonl`)
    const whole = (e: unknown) => JSON.stringify(e) + '\n'
    writeFileSync(
      path,
      whole({ type: 'session/start', at: 1, sessionId: name }) +
        whole({
          type: 'user/message',
          at: 2,
          message: { role: 'user', content: 'run the thing' },
        }) +
        whole({ type: 'tool/call', at: 3, id: 'call_1', name: 'probe', input: {} }) +
        // 结果只写了一半就被打断 —— 没有换行，也没有闭合的 JSON。
        '{"type":"tool/result","at":4,"id":"call_1","result":{"success":true,"cont',
      'utf-8',
    )
    return path
  }

  it('opens as an unanswered call, and restoring it answers the call', () => {
    const name = 'interrupted-tail-half-written'
    const path = writeTruncated(name)
    try {
      const log = SessionLog.open(name)
      // 前提先证实：盘上那份历史确实是一条没有结果的调用（半截行被 `open()` 丢掉了）。
      expect(toolResults(log.events())).toEqual([])
      expect(deriveMessages(log.events()).at(-1)).toMatchObject({
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'probe' }],
      })

      const context = new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.9 })
      context.restoreLog(log)

      const messages: Message[] = context.getMessages()
      expect(JSON.stringify(messages)).toContain('"type":"tool_result"')
      expect(() => assertModelVisible(log.events(), messages)).not.toThrow()
    } finally {
      if (existsSync(path)) rmSync(path)
    }
  })
})
