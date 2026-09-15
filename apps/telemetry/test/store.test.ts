import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadAllowlist } from '../src/allowlist.js'
import { dayKey } from '../src/aggregate.js'
import { decrypt, encrypt } from '../src/crypto.js'
import { AggregateStore, InstanceLock, LockHeldError } from '../src/store.js'
import { validateEvent, type NormalizedEvent } from '../src/validate.js'
import { sessionEvent } from './fixtures.js'

const ALLOWLIST = loadAllowlist()
const KEY = Buffer.alloc(32, 5)
const OTHER_KEY = Buffer.alloc(32, 6)
/** A fixed instant, so day rollover is a deterministic fact and not a race. */
const DAY_ONE = new Date('2026-09-15T12:00:00.000Z')
const DAY_TWO = new Date('2026-09-16T12:00:00.000Z')

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mipham-telemetry-store-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  vi.useRealTimers()
  dirs.length = 0
})

/**
 * A pid that is not running. `spawnSync` reaps the child before returning, so
 * by the time it hands back `.pid` the kernel has already released it.
 */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''])
  if (child.pid === undefined) throw new Error('spawnSync returned no pid')
  return child.pid
}

function event(id = 'e1', overrides: Record<string, unknown> = {}): NormalizedEvent {
  const result = validateEvent(sessionEvent(overrides, { id }), ALLOWLIST)
  if (!result.ok) throw new Error(`fixture rejected: ${result.reason}`)
  return result.event
}

function newStore(dataDir: string, key: Buffer = KEY): AggregateStore {
  return new AggregateStore({ dataDir, key })
}

describe('atomic writes', () => {
  it('leaves no .tmp behind and writes the aggregate at mode 0600', () => {
    const dataDir = tempDir()
    const store = newStore(dataDir)
    store.aggregator.record(event(), DAY_ONE.getTime())
    store.noteDirty()
    expect(store.flush(DAY_ONE)).toBe(true)

    const path = store.pathForDay('2026-09-15')
    expect(existsSync(path)).toBe(true)
    expect(existsSync(`${path}.tmp`)).toBe(false)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(dataDir, 'aggregate'))).toEqual(['2026-09-15.json.enc'])
  })

  it('does not write when nothing has changed', () => {
    const dataDir = tempDir()
    const store = newStore(dataDir)
    expect(store.flush(DAY_ONE)).toBe(false)
    expect(existsSync(store.pathForDay('2026-09-15'))).toBe(false)
  })

  it('overwrites by rename, so a reader never sees a half-written file', () => {
    const dataDir = tempDir()
    const store = newStore(dataDir)
    store.aggregator.record(event(), DAY_ONE.getTime())
    store.noteDirty()
    store.flush(DAY_ONE)

    const first = readFileSync(store.pathForDay('2026-09-15'), 'utf-8')
    store.aggregator.record(event('e2'), DAY_ONE.getTime())
    store.noteDirty()
    store.flush(DAY_ONE)
    const second = readFileSync(store.pathForDay('2026-09-15'), 'utf-8')

    // Different ciphertext, both decryptable: the file was replaced, not
    // appended to in place.
    expect(second).not.toBe(first)
    expect(JSON.parse(decrypt(second, KEY)).server.accepted).toBe(2)
  })

  it('a leftover .tmp from a killed process is inert', () => {
    const dataDir = tempDir()
    mkdirSync(join(dataDir, 'aggregate'), { recursive: true })
    const path = join(dataDir, 'aggregate', '2026-09-15.json.enc')
    writeFileSync(`${path}.tmp`, 'garbage from a crash')

    const store = newStore(dataDir)
    store.aggregator.record(event(), DAY_ONE.getTime())
    store.noteDirty()
    store.flush(DAY_ONE)
    expect(JSON.parse(decrypt(readFileSync(path, 'utf-8'), KEY)).server.accepted).toBe(1)
  })
})

describe('the load path refuses to silently start over', () => {
  it('returns an empty aggregator when there is no file yet', () => {
    const store = newStore(tempDir())
    expect(store.aggregator.server.accepted).toBe(0)
    expect(store.day).toBe(dayKey(new Date()))
  })

  it('re-raises a decryption failure instead of overwriting the day', () => {
    const dataDir = tempDir()
    const store = newStore(dataDir)
    store.aggregator.record(event(), DAY_ONE.getTime())
    store.noteDirty()
    store.flush(DAY_ONE)

    // A fresh store with the wrong key must fail loudly: starting fresh would
    // turn a key problem into permanent data loss.
    expect(() => newStore(dataDir, OTHER_KEY)).toThrow()
  })

  it('refuses a file whose contents claim a different day', () => {
    const dataDir = tempDir()
    mkdirSync(join(dataDir, 'aggregate'), { recursive: true })
    const foreign = JSON.stringify({ day: '2020-01-01' })
    writeFileSync(
      join(dataDir, 'aggregate', `${dayKey(new Date())}.json.enc`),
      encrypt(foreign, KEY),
    )

    // Aggregating it under its new name would corrupt two days at once.
    expect(() => newStore(dataDir)).toThrow(/refusing to load it as/)
  })

  it('re-reads a day without disturbing in-memory state', () => {
    const dataDir = tempDir()
    const store = newStore(dataDir)
    store.aggregator.record(event(), DAY_ONE.getTime())
    store.noteDirty()
    store.flush(DAY_ONE)

    expect(store.readDay('2026-09-15').server.accepted).toBe(1)
    expect(store.aggregator.server.accepted).toBe(1)
  })
})

describe('day rollover', () => {
  it('seals the finished day before starting the new one', () => {
    const dataDir = tempDir()
    const store = newStore(dataDir)
    store.aggregator.record(event(), DAY_ONE.getTime())
    store.noteDirty()

    store.flush(DAY_TWO)

    expect(store.day).toBe('2026-09-16')
    // Yesterday survived the rollover even though nothing else triggered a write.
    expect(store.readDay('2026-09-15').server.accepted).toBe(1)
    expect(store.aggregator.server.accepted).toBe(0)
  })

  it('resumes an existing day rather than resetting it', () => {
    const dataDir = tempDir()
    const first = newStore(dataDir)
    first.aggregator.record(event(), DAY_ONE.getTime())
    first.noteDirty()
    first.flush(DAY_ONE)

    // Simulate a restart on the same day.
    vi.setSystemTime(DAY_ONE)
    const second = newStore(dataDir)
    expect(second.day).toBe('2026-09-15')
    expect(second.aggregator.server.accepted).toBe(1)
  })
})

describe('dedup survives a restart — the at-least-once case', () => {
  it('calls an id delivered before the restart a duplicate', () => {
    const dataDir = tempDir()
    const first = newStore(dataDir)
    expect(first.aggregator.record(event('same-id'), DAY_ONE.getTime())).toBe('new')
    first.noteDirty()
    first.flush(DAY_ONE)

    vi.setSystemTime(DAY_ONE)
    const second = newStore(dataDir)
    expect(second.aggregator.record(event('same-id'), DAY_ONE.getTime())).toBe('duplicate')
    expect(second.aggregator.server.duplicates).toBe(1)
    // Counted, not discarded: the re-delivery is visible as extra traffic.
    expect(second.aggregator.server.accepted).toBe(2)
  })
})

describe('the instance lock', () => {
  it('refuses a second holder and allows re-acquisition after release', () => {
    const dataDir = tempDir()
    const first = new InstanceLock(dataDir)
    first.acquire()

    const second = new InstanceLock(dataDir)
    expect(() => second.acquire()).toThrow(LockHeldError)

    first.release()
    expect(() => second.acquire()).not.toThrow()
    second.release()
  })

  it('creates the data directory if it does not exist', () => {
    const dataDir = join(tempDir(), 'nested', 'deeper')
    const lock = new InstanceLock(dataDir)
    lock.acquire()
    expect(existsSync(lock.path)).toBe(true)
    lock.release()
    expect(existsSync(lock.path)).toBe(false)
  })

  it('releases idempotently', () => {
    const lock = new InstanceLock(tempDir())
    lock.release()
    lock.acquire()
    lock.release()
    lock.release()
  })

  // The three cases below are the whole point of reading the pid back. Without
  // them the lock leaks on any start failure — `main()` acquires it and then
  // runs everything that can throw under a catch that exits without releasing —
  // and the next start dies with LockHeldError forever, which under
  // `Restart=on-failure` is an unrecoverable restart loop.
  it('reclaims a lock whose holder is gone, and claims it for this process', () => {
    const lock = new InstanceLock(tempDir())
    writeFileSync(lock.path, String(deadPid()))

    expect(() => lock.acquire()).not.toThrow()
    // Rewritten, not merely unlinked: the next reader must see a live holder.
    expect(readFileSync(lock.path, 'utf-8')).toBe(String(process.pid))
    lock.release()
  })

  it('reclaims a lock file left empty by a crash between create and write', () => {
    const lock = new InstanceLock(tempDir())
    writeFileSync(lock.path, '')
    expect(() => lock.acquire()).not.toThrow()
    lock.release()
  })

  it('refuses a lock file whose contents it did not write', () => {
    const lock = new InstanceLock(tempDir())
    writeFileSync(lock.path, 'not-a-pid')
    expect(() => lock.acquire()).toThrow(LockHeldError)
  })
})

describe('availableDays', () => {
  it('lists encrypted days oldest first and ignores everything else', () => {
    const dataDir = tempDir()
    mkdirSync(join(dataDir, 'aggregate'), { recursive: true })
    for (const name of ['2026-09-16.json.enc', '2026-09-14.json.enc', 'notes.txt', '.tmp']) {
      writeFileSync(join(dataDir, 'aggregate', name), '')
    }
    expect(newStore(dataDir).availableDays()).toEqual(['2026-09-14', '2026-09-16'])
  })

  it('is empty rather than throwing when the directory is absent', () => {
    expect(newStore(tempDir()).availableDays()).toEqual([])
  })
})
