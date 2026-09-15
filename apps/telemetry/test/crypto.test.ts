import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  KEY_LENGTH,
  KeyError,
  decrypt,
  encrypt,
  generateKey,
  keyFingerprint,
  loadKey,
} from '../src/crypto.js'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mipham-telemetry-key-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  dirs.length = 0
})

describe('round trip', () => {
  it('encrypts and decrypts to the original string', () => {
    const key = Buffer.alloc(KEY_LENGTH, 7)
    const plaintext = JSON.stringify({ day: '2026-09-15', note: '中文也要能回来' })
    expect(decrypt(encrypt(plaintext, key), key)).toBe(plaintext)
  })

  it('produces a different ciphertext every time for the same plaintext', () => {
    const key = Buffer.alloc(KEY_LENGTH, 7)
    // The IV is fresh per call. Identical output would leak that two days'
    // files have identical contents, which is the one thing the encryption of a
    // low-entropy aggregate is for.
    expect(encrypt('same', key)).not.toBe(encrypt('same', key))
  })

  it('is base64 of iv(16) || authTag(16) || ciphertext', () => {
    const key = Buffer.alloc(KEY_LENGTH, 7)
    const buf = Buffer.from(encrypt('x', key), 'base64')
    // 16 IV + 16 tag + at least one byte of ciphertext.
    expect(buf.length).toBeGreaterThan(32)
  })

  it('handles an empty plaintext', () => {
    const key = Buffer.alloc(KEY_LENGTH, 1)
    expect(decrypt(encrypt('', key), key)).toBe('')
  })
})

describe('a wrong key fails loudly rather than returning garbage', () => {
  it('throws when the key differs', () => {
    const ciphertext = encrypt('secret', Buffer.alloc(KEY_LENGTH, 1))
    expect(() => decrypt(ciphertext, Buffer.alloc(KEY_LENGTH, 2))).toThrow()
  })

  it('throws when the ciphertext was tampered with', () => {
    const key = Buffer.alloc(KEY_LENGTH, 3)
    const buf = Buffer.from(encrypt('secret', key), 'base64')
    // Flip a bit in the ciphertext body; GCM's tag must catch it.
    const last = buf.length - 1
    buf[last] = (buf[last] ?? 0) ^ 0xff
    expect(() => decrypt(buf.toString('base64'), key)).toThrow()
  })

  it('names the problem for a buffer too short to be one of ours', () => {
    expect(() => decrypt(Buffer.alloc(20).toString('base64'), Buffer.alloc(KEY_LENGTH, 1))).toThrow(
      /not a file this collector wrote/,
    )
  })
})

describe('key material on disk', () => {
  it('generates exactly 32 bytes at mode 0400', () => {
    const path = join(tempDir(), 'aggregate.key')
    const key = generateKey(path)
    expect(key).toHaveLength(KEY_LENGTH)
    expect(readFileSync(path)).toHaveLength(KEY_LENGTH)
    expect(statSync(path).mode & 0o777).toBe(0o400)
  })

  it('refuses to overwrite an existing key', () => {
    const path = join(tempDir(), 'aggregate.key')
    generateKey(path)
    // Overwriting would orphan every file the old key encrypted, which is the
    // exact loss `loadKey` is shaped to make impossible.
    expect(() => generateKey(path)).toThrow(KeyError)
    expect(() => generateKey(path)).toThrow(/refusing to overwrite/)
  })

  it('throws with instructions when the key is absent', () => {
    expect(() => loadKey(join(tempDir(), 'missing.key'))).toThrow(/keys init/)
  })

  it('rejects a key of the wrong length, naming the file and the expectation', () => {
    const path = join(tempDir(), 'short.key')
    writeFileSync(path, Buffer.alloc(16))
    expect(() => loadKey(path)).toThrow(/16 bytes, expected 32/)
  })

  it('generates a distinct key each time', () => {
    const a = generateKey(join(tempDir(), 'a.key'))
    const b = generateKey(join(tempDir(), 'b.key'))
    expect(a.equals(b)).toBe(false)
  })

  it('fingerprints stably and does not leak the key', () => {
    const key = Buffer.alloc(KEY_LENGTH, 9)
    const fingerprint = keyFingerprint(key)
    expect(fingerprint).toMatch(/^[0-9a-f]{8}$/)
    expect(fingerprint).toBe(keyFingerprint(Buffer.from(key)))
    // A prefix of the key itself would shorten the search space for anyone
    // reading journald; a hash of it does not.
    expect(key.toString('hex')).not.toContain(fingerprint)
  })
})
