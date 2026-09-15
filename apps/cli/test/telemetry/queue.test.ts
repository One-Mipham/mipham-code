import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => `${actual.tmpdir()}/mipham-test-tel-queue` }
})

import { tmpdir } from 'node:os'
import { mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  QUEUE_MAX_ENTRIES,
  queuePath,
  readQueue,
  writeQueue,
  enqueueSync,
  ackQueue,
  type QueuedEvent,
} from '../../src/telemetry/queue'

const HOME = `${tmpdir()}/mipham-test-tel-queue`

function event(id: string, kind: QueuedEvent['kind'] = 'session'): QueuedEvent {
  return { id, kind, payload: { n: id } }
}

function reset(): void {
  rmSync(HOME, { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true })
}

describe('telemetry queue', () => {
  beforeEach(reset)
  afterAll(() => rmSync(HOME, { recursive: true, force: true }))

  it('is empty before anything is queued', () => {
    expect(readQueue()).toEqual([])
  })

  it('round-trips events in order', () => {
    enqueueSync(event('a'))
    enqueueSync(event('b'))
    expect(readQueue().map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('appends without disturbing earlier entries', () => {
    enqueueSync(event('a', 'crash'))
    enqueueSync(event('b'))
    expect(readQueue()[0]).toEqual(event('a', 'crash'))
  })

  it('writes with owner-only permissions — the payload is not world-readable', () => {
    enqueueSync(event('a'))
    expect(statSync(queuePath()).mode & 0o777).toBe(0o600)
  })

  it('drops the OLDEST entries once at capacity', () => {
    // Newest events describe the current version, which is the version worth
    // hearing about.
    for (let i = 0; i < QUEUE_MAX_ENTRIES + 5; i++) enqueueSync(event(`e${i}`))

    const ids = readQueue().map((e) => e.id)
    expect(ids).toHaveLength(QUEUE_MAX_ENTRIES)
    expect(ids).not.toContain('e0')
    expect(ids).not.toContain('e4')
    expect(ids[0]).toBe('e5')
    expect(ids.at(-1)).toBe(`e${QUEUE_MAX_ENTRIES + 4}`)
  })

  it('acknowledges by id, keeping the rest', () => {
    enqueueSync(event('a'))
    enqueueSync(event('b'))
    enqueueSync(event('c'))
    ackQueue(['a', 'c'])
    expect(readQueue().map((e) => e.id)).toEqual(['b'])
  })

  it('treats an empty acknowledgement as a no-op', () => {
    enqueueSync(event('a'))
    ackQueue([])
    expect(readQueue().map((e) => e.id)).toEqual(['a'])
  })

  it('skips a damaged line rather than wedging future sessions', () => {
    writeQueue([event('a'), event('b')])
    writeFileSync(queuePath(), '{"id":"a","kind":"session","payload":{}}\n{ truncated\n')
    expect(readQueue().map((e) => e.id)).toEqual(['a'])
  })

  it('ignores lines that parse but carry no id', () => {
    mkdirSync(join(HOME, '.mipham', 'telemetry'), { recursive: true })
    writeFileSync(queuePath(), '{"kind":"session"}\n')
    expect(readQueue()).toEqual([])
  })

  it('never throws when the queue directory is unwritable', () => {
    // Best-effort by design: a queue write must not take down an exit path.
    // Occupy the path where the directory belongs with a regular file, so the
    // write genuinely fails with ENOTDIR.
    rmSync(HOME, { recursive: true, force: true })
    mkdirSync(HOME, { recursive: true })
    writeFileSync(join(HOME, '.mipham'), 'not a directory')

    expect(() => enqueueSync(event('a'))).not.toThrow()
    expect(readQueue()).toEqual([])
  })

  it('leaves an empty file behind when drained, not a stray newline', () => {
    enqueueSync(event('a'))
    ackQueue(['a'])
    expect(readQueue()).toEqual([])
  })
})
