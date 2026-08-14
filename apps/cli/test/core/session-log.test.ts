import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { messageToEvents, deriveMessages, SessionLog, assertModelVisible } from '../../src/core/session-log'
import type { Message } from '../../src/shared/types'

describe('messageToEvents ↔ deriveMessages round-trip', () => {
  const samples: Message[] = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there!', reasoning_content: 'thinking...' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: { file_path: '/a' } }], reasoning_content: '' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: 'done' }] },
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
    const log = new SessionLog(name, { now: () => 1 })
    log.append({ type: 'session/start', at: 1, sessionId: name })
    log.append({ type: 'user/message', at: 1, message: { role: 'user', content: 'hi' } })
    log.append(messageToEvents({ role: 'assistant', content: 'ok' }, 1)[0]!)
    log.save()

    expect(existsSync(join(LOG_DIR, `${name}.jsonl`))).toBe(true)
    const reopened = SessionLog.open(name)
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
    const log = [...ev({ role: 'user', content: 'a' }), ...ev({ role: 'assistant', content: 'b' }), ...ev({ role: 'user', content: 'c' })]
    expect(() => assertModelVisible(log, [{ role: 'user', content: 'a' }, { role: 'user', content: 'c' }])).not.toThrow()
  })

  it('throws when a message is not logged', () => {
    const log = ev({ role: 'user', content: 'a' })
    expect(() => assertModelVisible(log, [{ role: 'user', content: 'NOT-LOGGED' }])).toThrow(/not logged/)
  })

  it('exempts compaction summaries', () => {
    const log = ev({ role: 'user', content: 'a' })
    expect(() =>
      assertModelVisible(log, [{ role: 'user', content: '[Earlier conversation summary]: …' }]),
    ).not.toThrow()
  })
})
