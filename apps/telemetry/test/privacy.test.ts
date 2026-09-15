import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadAllowlist } from '../src/allowlist.js'
import { decrypt, encrypt, generateKey, KeyError, loadKey } from '../src/crypto.js'
import { AggregateStore } from '../src/store.js'
import { validateEvent } from '../src/validate.js'
import {
  crashEvent,
  FRAME_SENTINEL,
  INSTALL_ID,
  MESSAGE_SENTINEL,
  type FixtureEvent,
  sessionEvent,
} from './fixtures.js'

/**
 * What the stored file may and may not contain.
 *
 * Every claim here is checked against the bytes on disk after decrypting — not
 * against the in-memory aggregate. "We do not store X" is a statement about the
 * file, and an aggregate that holds X only in memory would still pass a test
 * written against the wrong layer.
 */

const ALLOWLIST = loadAllowlist()
const KEY = Buffer.alloc(32, 11)
const WRONG_KEY = Buffer.alloc(32, 12)

describe('the stored file', () => {
  let dir: string
  let store: AggregateStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mipham-privacy-'))
    store = new AggregateStore({ dataDir: dir, key: KEY })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** Run a wire fixture through the real validate → aggregate path. */
  function ingest(raw: FixtureEvent): void {
    const result = validateEvent(raw, ALLOWLIST)
    if (!result.ok) throw new Error(`fixture rejected: ${result.reason}`)
    store.aggregator.noteObservations(result.notes)
    store.aggregator.record(result.event, Date.now())
    store.noteDirty()
  }

  /** Flush, then return the day's file both as raw bytes and decrypted. */
  function sealed(): { bytes: string; plaintext: string } {
    store.flush()
    const bytes = readFileSync(store.pathForDay(store.day), 'utf-8')
    return { bytes, plaintext: decrypt(bytes, KEY) }
  }

  it('is ciphertext, not a readable aggregate with a wrapper', () => {
    ingest(sessionEvent())
    const { bytes, plaintext } = sealed()

    // Sanity: the file really does hold the aggregate.
    expect(plaintext).toContain('byPlatform')
    // A JSON key and a value that would both appear verbatim if the encryption
    // were an encoding rather than a cipher.
    expect(bytes).not.toContain('byPlatform')
    expect(bytes).not.toContain('darwin/arm64')
  })

  it('never contains an install id, while still counting the install', () => {
    ingest(sessionEvent())
    ingest(crashEvent())
    const { plaintext } = sealed()

    // The id is what makes the distinct-install estimate possible, and it is
    // also the one value that would turn the day's file into a roster of who
    // ran the CLI. It is fed to the sketch and dropped.
    expect(plaintext).not.toContain(INSTALL_ID)
    expect(store.aggregator.estimatedInstalls).toBe(1)
  })

  it('never contains a stack frame, and says how many it discarded', () => {
    ingest(crashEvent())
    const { plaintext } = sealed()

    expect(plaintext).not.toContain(FRAME_SENTINEL)
    expect(plaintext).not.toContain('SENTINELSTACKFRAMESTRING')
    // Discarded at the boundary rather than silently ignored, so the count is
    // visible in the report as the price of "aggregates only".
    expect(store.aggregator.server.framesDiscarded).toBe(2)
  })

  it('never stores an unrecognised payload field, whatever it carries', () => {
    // A crash event with the message text in full, plus a field no rule knows.
    // This is the exact figure the client refuses to send — so the test is
    // really asking whether the server would have kept it if it had.
    ingest(crashEvent({ message: MESSAGE_SENTINEL, stderrTail: MESSAGE_SENTINEL }))
    const { plaintext } = sealed()

    expect(plaintext).not.toContain(MESSAGE_SENTINEL)
    expect(plaintext).not.toContain('stderrTail')
    // The hash is what survives, and it is the only thing that should.
    expect(plaintext).toContain('a1b2c3d4e5f60718')
  })

  it('stores no raw label when the allowlist does not cover it', () => {
    const garbage: Record<string, number> = {}
    for (let i = 0; i < 10_000; i++) garbage[`command_calls.junk-${i}`] = 1
    ingest(sessionEvent({ counters: garbage }))
    const { plaintext } = sealed()

    // The count is kept and the name is not: an unrecognised label never gets a
    // slot, so the endpoint cannot be pumped full of junk to push genuine
    // labels out of the table T4 votes on.
    expect(plaintext).not.toContain('junk-')
    expect(plaintext).toContain('command_calls.__other__')
    expect(store.aggregator.server.unknownLabels).toBe(10_000)

    const counters = (JSON.parse(plaintext) as { session: { counters: Record<string, number> } })
      .session.counters
    expect(Object.keys(counters)).toEqual(['command_calls.__other__'])
  })

  it('keeps a label the allowlist does cover, under its own name', () => {
    const known = ALLOWLIST.get('command_calls')
    expect(known).toBeDefined()
    const label = [...(known ?? [])][0]
    expect(label).toBeDefined()

    ingest(sessionEvent({ counters: { [`command_calls.${String(label)}`]: 3 } }))
    const { plaintext } = sealed()
    expect(plaintext).toContain(`command_calls.${String(label)}`)
  })
})

describe('the key file', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mipham-key-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('is created readable only by its owner, and never overwritten', () => {
    const keyPath = join(dir, 'aggregate.key')
    generateKey(keyPath)

    expect(statSync(keyPath).mode & 0o777).toBe(0o400)
    expect(loadKey(keyPath).length).toBe(32)
    // Overwriting would orphan every existing daily file, which is the failure
    // the absent create-if-absent path exists to make impossible.
    expect(() => generateKey(keyPath)).toThrow(KeyError)
  })

  it('refuses to load a missing or wrong-sized key by name', () => {
    expect(() => loadKey(join(dir, 'nope.key'))).toThrow(/aggregate key not found/)

    const shortPath = join(dir, 'short.key')
    writeFileSync(shortPath, Buffer.alloc(16))
    // A truncated key would otherwise fail inside `createDecipheriv` with a
    // message naming neither the file nor what was expected.
    expect(() => loadKey(shortPath)).toThrow(/is 16 bytes, expected 32/)
  })

  it('cannot be read with the wrong key, and the failure is not silent', () => {
    const ciphertext = encrypt('{"secret":1}', KEY)
    expect(decrypt(ciphertext, KEY)).toBe('{"secret":1}')
    expect(() => decrypt(ciphertext, WRONG_KEY)).toThrow()
  })

  it('rejects a file that is not one of ours, by length', () => {
    expect(() => decrypt(Buffer.alloc(8).toString('base64'), KEY)).toThrow(/only 8 bytes/)
  })
})
