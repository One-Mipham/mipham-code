import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Storage-layer encryption, mirroring `apps/cli/src/config/credential-crypto.ts`
 * byte for byte in format: AES-256-GCM, `base64(iv(16) || authTag(16) || ciphertext)`.
 *
 * **Why a second implementation rather than a shared module.** That file also
 * carries the `enc:v1:` marker and API-key semantics — `isEnvTemplate`,
 * `getOrCreateKey`'s create-if-absent behaviour. Lifting it into `packages/`
 * would mean either dragging those along (a telemetry app that imports
 * "credential" concepts it does not have) or splitting the file and rewriting
 * its callers. Twenty duplicated lines is cheaper than a shared module whose
 * name lies about half of what it does.
 *
 * **The one deliberate divergence** is `getOrCreateKey`'s create-if-absent: it
 * is right for an API key — losing it only costs a re-entry — and wrong here,
 * where silently minting a fresh key would make the entire history of daily
 * files undecryptable while looking like a clean start. So there is no
 * create-if-absent path at all: `loadKey` throws when the file is absent, and
 * `generateKey` is a separate entry point that only `deploy.sh keys init` calls.
 */

const ALGORITHM = 'aes-256-gcm'
/** AES-256. */
export const KEY_LENGTH = 32
const IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16

/** Raised when the key file is missing, unreadable, or the wrong size. */
export class KeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeyError'
  }
}

/**
 * Read the key, or throw.
 *
 * The length check is not decoration: a truncated or wrong-type file would
 * otherwise fail later inside `createDecipheriv` with a message about "invalid
 * key length" that names neither the file nor what was expected.
 */
export function loadKey(keyPath: string): Buffer {
  if (!existsSync(keyPath)) {
    throw new KeyError(
      `aggregate key not found at ${keyPath} — run "deploy.sh keys init" on the host to create one`,
    )
  }
  const key = readFileSync(keyPath)
  if (key.length !== KEY_LENGTH) {
    throw new KeyError(`aggregate key at ${keyPath} is ${key.length} bytes, expected ${KEY_LENGTH}`)
  }
  return key
}

/**
 * Create a key. Refuses to overwrite, because that would orphan every existing
 * daily file — the exact failure `loadKey` is shaped to make impossible.
 */
export function generateKey(keyPath: string): Buffer {
  if (existsSync(keyPath)) {
    throw new KeyError(`refusing to overwrite existing key at ${keyPath}`)
  }
  const key = randomBytes(KEY_LENGTH)
  mkdirSync(dirname(keyPath), { recursive: true })
  writeFileSync(keyPath, key, { mode: 0o400 })
  chmodSync(keyPath, 0o400)
  return key
}

/**
 * First 8 hex chars of the key's sha256, for the startup log line.
 *
 * Deliberately a hash of the key rather than a prefix of it: it has to be
 * comparable across restarts and across hosts, and it must not shorten the
 * search space for anyone reading journald.
 */
export function keyFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8)
}

/** Encrypt to `base64(iv || authTag || ciphertext)`. */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
}

/** Inverse of {@link encrypt}. Throws on a wrong key or a corrupt file. */
export function decrypt(ciphertext: string, key: Buffer): string {
  const buf = Buffer.from(ciphertext, 'base64')
  // A short buffer would make `subarray` return short slices and `setAuthTag`
  // throw a confusing low-level error; this names the actual problem.
  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error(`ciphertext is only ${buf.length} bytes — not a file this collector wrote`)
  }
  const iv = buf.subarray(0, IV_LENGTH)
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const encrypted = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8')
}
