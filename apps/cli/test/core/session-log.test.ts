import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
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

const HOME = process.env.HOME || '~'
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
  it('messageToEvents derives success:true best-effort from a tool_result block', () => {
    const m: Message = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'body' }],
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
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom' }] },
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
