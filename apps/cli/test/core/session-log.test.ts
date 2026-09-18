import { describe, it, expect, afterEach, vi } from 'vitest'

// Isolate session log storage to a temp homedir (same pattern as cron.test.ts)
// so tests never touch the developer's real ~/.mipham/sessions/.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-session-log`,
  }
})

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  messageToEvents,
  deriveMessages,
  SessionLog,
  assertModelVisible,
  replayMessages,
  replayChunks,
  forkEvents,
  resumeMessages,
  sanitizeSessionName,
  setAssertModelVisibleDebug,
  isAssertModelVisibleDebug,
} from '../../src/core/session-log'
import type { Message } from '../../src/shared/types'
import type { SessionEvent } from '../../src/core/session-log'

describe('messageToEvents ↔ deriveMessages round-trip', () => {
  const samples: Message[] = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there!', reasoning_content: 'thinking...' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'read', input: { file_path: '/a' } }],
      reasoning_content: '',
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '…' },
        { type: 'text', text: 'done' },
      ],
    },
  ]

  it('round-trips each sample byte-identically', () => {
    for (const m of samples) {
      expect(deriveMessages(messageToEvents(m))).toEqual([m])
    }
  })

  it('round-trips a full turn sequence preserving order', () => {
    const seq = samples
    const events = seq.flatMap((m) => messageToEvents(m, 1000))
    expect(deriveMessages(events)).toEqual(seq)
  })

  it('round-trips tool_use without reasoning_content (sub-agent shape) byte-identically', () => {
    const m: Message = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't2', name: 'read', input: { file_path: '/b' } }],
    }
    expect(deriveMessages(messageToEvents(m))).toEqual([m])
  })

  it('round-trips a multi-tool_use message without changing boundaries', () => {
    const m: Message = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'a', name: 'x', input: {} },
        { type: 'tool_use', id: 'b', name: 'y', input: {} },
      ],
      reasoning_content: '',
    }
    expect(deriveMessages(messageToEvents(m))).toEqual([m])
  })
})

const HOME = homedir()
const LOG_DIR = join(HOME, '.mipham', 'sessions')

describe('SessionLog append-only', () => {
  const name = `test-log-${Date.now()}`
  afterEach(() => {
    rmSync(join(LOG_DIR, `${name}.jsonl`), { force: true })
  })

  it('appends events and returns an immutable snapshot', () => {
    const log = new SessionLog(name)
    const a = { type: 'user/message', at: 1, message: { role: 'user', content: 'hi' } } as const
    log.append(a)
    const snap = log.events()
    expect(snap).toHaveLength(1)
    snap.push(a) // mutation of the snapshot must not affect the log
    expect(log.events()).toHaveLength(1)
  })

  it('persists to JSONL and reopens byte-identically', () => {
    const log = new SessionLog(name)
    log.append({ type: 'session/start', at: 1, sessionId: name })
    log.append({ type: 'user/message', at: 1, message: { role: 'user', content: 'hi' } })
    log.append(messageToEvents({ role: 'assistant', content: 'ok' }, 1)[0]!)
    log.save()

    expect(existsSync(join(LOG_DIR, `${name}.jsonl`))).toBe(true)
    const reopened = SessionLog.open(name)
    expect(reopened.events()).toEqual(log.events())
  })

  it('save is idempotent — double save does not duplicate events', () => {
    const log = new SessionLog(name)
    log.append({ type: 'user/message', at: 1, message: { role: 'user', content: 'hi' } })
    log.save()
    log.save()

    const reopened = SessionLog.open(name)
    expect(reopened.events()).toHaveLength(1)
    expect(reopened.events()).toEqual(log.events())
  })

  it('open on missing file returns empty log', () => {
    const log = SessionLog.open('test-log-nonexistent-xyz')
    expect(log.events()).toEqual([])
  })
})

describe('assertModelVisible', () => {
  const ev = (m: Message) => messageToEvents(m, 0)

  it('passes when messages are a subsequence of the derived log', () => {
    const log = [
      ...ev({ role: 'user', content: 'a' }),
      ...ev({ role: 'assistant', content: 'b' }),
      ...ev({ role: 'user', content: 'c' }),
    ]
    expect(() =>
      assertModelVisible(log, [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'c' },
      ]),
    ).not.toThrow()
  })

  it('throws when a message is not logged', () => {
    const log = ev({ role: 'user', content: 'a' })
    expect(() => assertModelVisible(log, [{ role: 'user', content: 'NOT-LOGGED' }])).toThrow(
      /not logged/,
    )
  })

  it('exempts compaction summaries', () => {
    const log = ev({ role: 'user', content: 'a' })
    expect(() =>
      assertModelVisible(log, [{ role: 'user', content: '[Earlier conversation summary]: …' }]),
    ).not.toThrow()
  })
})

describe('replay / fork / resume', () => {
  const turn = (at: number): SessionEvent[] => [
    { type: 'user/message', at, message: { role: 'user', content: 'q' } },
    { type: 'assistant/message', at, message: { role: 'assistant', content: 'a' } },
  ]

  it('replayMessages derives the full message history from a log', () => {
    const log = new SessionLog('replay-test')
    turn(1).forEach((e) => log.append(e))
    turn(2).forEach((e) => log.append(e))
    expect(replayMessages(log)).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ])
  })

  it('forkEvents truncates the log at a prefix index', () => {
    const events = [...turn(1), ...turn(2)]
    expect(forkEvents(events, 2)).toEqual(turn(1))
  })

  it('resumeMessages equals replayMessages (alias for streaming resume)', () => {
    const log = new SessionLog('resume-test')
    turn(1).forEach((e) => log.append(e))
    expect(resumeMessages(log)).toEqual(replayMessages(log))
  })
})

describe('sanitizeSessionName', () => {
  it('replaces path-special chars with underscores', () => {
    expect(sanitizeSessionName('../etc/passwd')).toBe('___etc_passwd')
  })

  it('hashes over-long names deterministically', () => {
    const long = 'x'.repeat(120)
    const a = sanitizeSessionName(long)
    const b = sanitizeSessionName(long)
    expect(a).toBe(b)
    expect(a.length).toBeLessThan(100)
  })
})

describe('assertModelVisible debug gating', () => {
  afterEach(() => setAssertModelVisibleDebug(false))

  it('defaults to off', () => {
    expect(isAssertModelVisibleDebug()).toBe(false)
  })

  it('toggles on and off', () => {
    setAssertModelVisibleDebug(true)
    expect(isAssertModelVisibleDebug()).toBe(true)
    setAssertModelVisibleDebug(false)
    expect(isAssertModelVisibleDebug()).toBe(false)
  })
})

describe('compaction/summary stream position', () => {
  it('replaces the dropped prefix with the summary at its position', () => {
    const events: SessionEvent[] = [
      { type: 'user/message', at: 1, message: { role: 'user', content: 'm1' } },
      { type: 'assistant/message', at: 2, message: { role: 'assistant', content: 'm2' } },
      { type: 'user/message', at: 3, message: { role: 'user', content: 'm3' } },
      { type: 'assistant/message', at: 4, message: { role: 'assistant', content: 'm4' } },
      { type: 'compaction/summary', at: 5, summary: 'S', replacedCount: 3 },
    ]
    expect(deriveMessages(events)).toEqual([
      { role: 'user', content: '[Earlier conversation summary]: S' },
      { role: 'assistant', content: 'm4' },
    ])
  })

  it('old summary events (no replacedCount) still append at end', () => {
    const events = [
      { type: 'user/message', at: 1, message: { role: 'user', content: 'm1' } },
      { type: 'compaction/summary', at: 2, summary: 'S' },
    ] as unknown as SessionEvent[] // 模拟旧 JSONL 解析（无 replacedCount）
    expect(deriveMessages(events)).toEqual([
      { role: 'user', content: 'm1' },
      { role: 'user', content: '[Earlier conversation summary]: S' },
    ])
  })
})

describe('compaction/rewrite stream position', () => {
  it('replaces the whole projection with the snapshot and continues appending', () => {
    const events: SessionEvent[] = [
      { type: 'user/message', at: 1, message: { role: 'user', content: 'm1' } },
      { type: 'assistant/message', at: 2, message: { role: 'assistant', content: 'm2' } },
      {
        type: 'compaction/rewrite',
        at: 3,
        messages: [
          { role: 'user', content: 'kept-a' },
          { role: 'assistant', content: 'kept-b' },
        ],
      },
      { type: 'user/message', at: 4, message: { role: 'user', content: 'after' } },
    ]
    expect(deriveMessages(events)).toEqual([
      { role: 'user', content: 'kept-a' },
      { role: 'assistant', content: 'kept-b' },
      { role: 'user', content: 'after' },
    ])
  })

  it('does not alias the stored snapshot (mutating the derived array leaves the log intact)', () => {
    const snapshot: Message[] = [{ role: 'user', content: 'x' }]
    const events: SessionEvent[] = [{ type: 'compaction/rewrite', at: 1, messages: snapshot }]
    const derived = deriveMessages(events)
    derived.push({ role: 'user', content: 'y' })
    expect(snapshot).toEqual([{ role: 'user', content: 'x' }])
  })
})

describe('tool/result carries full ToolResult', () => {
  it('messageToEvents treats an absent is_error as success (legacy messages)', () => {
    const m: Message = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'body' }],
    }
    expect(messageToEvents(m)).toEqual([
      { type: 'tool/result', at: 0, id: 't1', result: { success: true, content: 'body' } },
    ])
    expect(deriveMessages(messageToEvents(m))).toEqual([m])
  })

  it('messageToEvents reads is_error instead of fabricating success', () => {
    const m: Message = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }],
    }
    expect(messageToEvents(m)).toEqual([
      { type: 'tool/result', at: 0, id: 't1', result: { success: false, content: 'boom' } },
    ])
  })

  it('round-trips a failed tool_result block byte-identically', () => {
    const m: Message = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }],
    }
    expect(deriveMessages(messageToEvents(m))).toEqual([m])
  })

  it('deriveMessages reproduces error content for a failed tool', () => {
    const events: SessionEvent[] = [
      {
        type: 'tool/result',
        at: 1,
        id: 't1',
        result: { success: false, content: 'partial', error: 'boom' },
      },
    ]
    expect(deriveMessages(events)).toEqual([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }],
      },
    ])
  })

  it('deriveMessages reproduces content for a successful tool', () => {
    const events: SessionEvent[] = [
      { type: 'tool/result', at: 1, id: 't1', result: { success: true, content: 'ok' } },
    ]
    expect(deriveMessages(events)).toEqual([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ])
  })

  it('deriveMessages carries is_error for a failed tool and omits it for a successful one', () => {
    const events: SessionEvent[] = [
      {
        type: 'tool/result',
        at: 1,
        id: 'f',
        result: { success: false, content: 'partial', error: 'boom' },
      },
      { type: 'tool/result', at: 2, id: 's', result: { success: true, content: 'ok' } },
    ]
    const derived = deriveMessages(events)
    expect(derived[0]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'f', content: 'boom', is_error: true }],
    })
    // 成功路径保持逐字节不变：该键「不存在」，而不是被写成 false
    const okBlock = (derived[1]!.content as unknown as Array<Record<string, unknown>>)[0]!
    expect('is_error' in okBlock).toBe(false)
  })

  it('backward-compat: old tool/result with content:string still derives', () => {
    const events = [
      { type: 'tool/result', at: 1, id: 't1', content: 'legacy' },
    ] as unknown as SessionEvent[]
    expect(deriveMessages(events)).toEqual([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'legacy' }] },
    ])
  })
})

describe('assistant/chunk stream replay', () => {
  it('replayChunks extracts raw chunk strings in order', () => {
    const log = new SessionLog('chunk-test')
    log.append({ type: 'assistant/chunk', at: 1, chunk: 'Hel' })
    log.append({ type: 'assistant/chunk', at: 2, chunk: 'lo ' })
    log.append({ type: 'assistant/chunk', at: 3, chunk: 'world' })
    log.append({
      type: 'assistant/message',
      at: 4,
      message: { role: 'assistant', content: 'Hello world' },
    })
    expect(replayChunks(log)).toEqual(['Hel', 'lo ', 'world'])
  })

  it('deriveMessages ignores chunks (message comes from assistant/message)', () => {
    const events: SessionEvent[] = [
      { type: 'assistant/chunk', at: 1, chunk: 'Hel' },
      { type: 'assistant/chunk', at: 2, chunk: 'lo' },
      { type: 'assistant/message', at: 3, message: { role: 'assistant', content: 'Hello' } },
    ]
    expect(deriveMessages(events)).toEqual([{ role: 'assistant', content: 'Hello' }])
  })
})

describe('checker/decision (Recuris C 组件)', () => {
  it('deriveMessages ignores checker/decision — 决策只记证据，不进投影（M1 字节级可逆）', () => {
    const events: SessionEvent[] = [
      { type: 'user/message', at: 1, message: { role: 'user', content: 'hi' } },
      { type: 'assistant/message', at: 2, message: { role: 'assistant', content: 'ok' } },
      {
        type: 'checker/decision',
        at: 3,
        toolName: 'Bash',
        decision: {
          verdict: 'rejected',
          checkerId: 'bash-exit',
          reason: 'post-condition failed (bash-exit)',
        },
      },
      { type: 'assistant/message', at: 4, message: { role: 'assistant', content: 'done' } },
    ]
    expect(deriveMessages(events)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok' },
      { role: 'assistant', content: 'done' },
    ])
  })

  it('assertModelVisible passes when a checker/decision sits between logged messages', () => {
    const log = new SessionLog('checker-decision-test')
    log.append({ type: 'user/message', at: 1, message: { role: 'user', content: 'run it' } })
    log.append({
      type: 'checker/decision',
      at: 2,
      toolName: 'Bash',
      decision: { verdict: 'supported', checkerId: 'bash-exit' },
    })
    log.append({ type: 'assistant/message', at: 3, message: { role: 'assistant', content: 'ran' } })
    assertModelVisible(log.events(), [
      { role: 'user', content: 'run it' },
      { role: 'assistant', content: 'ran' },
    ])
  })
})

// ============================================================
// 合法 JSON ≠ 合法事件。
//
// `open()` 原先只 catch `JSON.parse`，于是 `null`、`{"type":"user/message"}`（无
// message）、`{"type":"compaction/rewrite"}`（无 messages）这些**能过 JSON.parse**
// 的行走进了 buf，而 `deriveMessages` 对它们直接解引用 —— 一条垃圾行就让整份历史
// 投影抛 TypeError。落盘路径（append/flush）是可信的，坏行来自手写、拼接、半截重排，
// 所以门槛放在磁盘→内存那唯一一个入口上。
// ============================================================

describe('open() 丢弃结构不合法的行', () => {
  const SESSIONS_DIR = join(homedir(), '.mipham', 'sessions')

  function writeLines(name: string, lines: string[]): string {
    mkdirSync(SESSIONS_DIR, { recursive: true })
    const path = join(SESSIONS_DIR, `${sanitizeSessionName(name)}.jsonl`)
    writeFileSync(path, lines.map((l) => l + '\n').join(''), 'utf-8')
    return path
  }

  function cleanup(name: string): void {
    const path = join(SESSIONS_DIR, `${sanitizeSessionName(name)}.jsonl`)
    if (existsSync(path)) rmSync(path)
  }

  it('正控：合法行一条都不丢', () => {
    const name = 'open-valid-control'
    writeLines(name, [
      '{"type":"user/message","at":1,"message":{"role":"user","content":"hi"}}',
      '{"type":"assistant/chunk","at":2,"chunk":"He"}',
      '{"type":"assistant/message","at":3,"message":{"role":"assistant","content":"Hello"}}',
      '{"type":"tool/call","at":4,"id":"t1","name":"Read","input":{"path":"a.ts"}}',
    ])
    try {
      const events = SessionLog.open(name).events()
      expect(events).toHaveLength(4)
      expect(deriveMessages(events)).toEqual([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'Hello' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a.ts' } }],
          reasoning_content: '',
        },
      ])
    } finally {
      cleanup(name)
    }
  })

  it('null / 非对象行被丢弃，其余事件照常派生', () => {
    const name = 'open-nonobject-lines'
    writeLines(name, [
      '{"type":"user/message","at":1,"message":{"role":"user","content":"hi"}}',
      'null',
      '42',
      '"just a string"',
      '[1,2]',
      '{"type":"assistant/message","at":6,"message":{"role":"assistant","content":"ok"}}',
    ])
    try {
      const log = SessionLog.open(name)
      expect(log.events()).toHaveLength(2)
      expect(deriveMessages(log.events())).toEqual([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'ok' },
      ])
    } finally {
      cleanup(name)
    }
  })

  it('缺 payload 的事件行被丢弃 —— 不把 undefined 推进历史', () => {
    const name = 'open-missing-payload'
    writeLines(name, [
      '{"type":"user/message","at":1}',
      '{"type":"assistant/message","at":2,"message":"不是对象"}',
      '{"type":"context/inject","at":3}',
      '{"type":"tool/result","at":4}',
      '{"type":"compaction/summary","at":5}',
      '{"type":"user/message","at":6,"message":{"role":"user","content":"survivor"}}',
    ])
    try {
      const log = SessionLog.open(name)
      expect(log.events()).toHaveLength(1)
      expect(deriveMessages(log.events())).toEqual([{ role: 'user', content: 'survivor' }])
    } finally {
      cleanup(name)
    }
  })

  it('compaction/rewrite 缺 messages 被丢弃 —— 投影不被抹成 undefined', () => {
    const name = 'open-rewrite-missing-messages'
    writeLines(name, [
      '{"type":"user/message","at":1,"message":{"role":"user","content":"before"}}',
      '{"type":"compaction/rewrite","at":2}',
      '{"type":"user/message","at":3,"message":{"role":"user","content":"after"}}',
    ])
    try {
      const log = SessionLog.open(name)
      expect(deriveMessages(log.events())).toEqual([
        { role: 'user', content: 'before' },
        { role: 'user', content: 'after' },
      ])
    } finally {
      cleanup(name)
    }
  })

  it('合法的 compaction/rewrite 仍然整体替换投影（守住正控的另一半）', () => {
    const name = 'open-rewrite-valid'
    writeLines(name, [
      '{"type":"user/message","at":1,"message":{"role":"user","content":"before"}}',
      '{"type":"compaction/rewrite","at":2,"messages":[{"role":"user","content":"snapshot"}]}',
    ])
    try {
      const log = SessionLog.open(name)
      expect(deriveMessages(log.events())).toEqual([{ role: 'user', content: 'snapshot' }])
    } finally {
      cleanup(name)
    }
  })
})
