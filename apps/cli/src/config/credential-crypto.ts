import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  copyFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Shared AES-256-GCM primitives for encrypting credentials at rest.
 *
 * Extracted from the MCP token store so config.yml API keys get the exact
 * same at-rest protection (parent/subsidiary CLAUDE.md mandate "存储层
 * AES-256-GCM"). The wire format `iv || authTag || ciphertext` (base64) is
 * preserved verbatim from the original token-store implementation so existing
 * `~/.mipham/mcp-tokens/*.enc` files remain decryptable.
 */

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16
const KEY_LENGTH = 32

/** Prefix marking an encrypted API key value in config.yml. */
export const ENC_PREFIX = 'enc:v1:'

/** Shared master-credential key file (used by both MCP tokens and config.yml). */
const CREDENTIAL_KEY_FILENAME = '.cred-key'
/** Pre-shared-key filename; migrated to {@link CREDENTIAL_KEY_FILENAME} on first use. */
const LEGACY_KEY_FILENAME = '.mcp-key'

/**
 * Load the shared credential key from `keyDir`, migrating the legacy
 * MCP-only `.mcp-key` to the shared `.cred-key` so existing encrypted MCP
 * tokens stay decryptable. Falls back to creating a fresh key when neither
 * exists.
 */
export function getCredentialKey(keyDir: string): Buffer {
  const keyPath = join(keyDir, CREDENTIAL_KEY_FILENAME)
  if (!existsSync(keyPath)) {
    const legacyPath = join(keyDir, LEGACY_KEY_FILENAME)
    if (existsSync(legacyPath)) {
      copyFileSync(legacyPath, keyPath)
      chmodSync(keyPath, 0o400)
    }
  }
  return getOrCreateKey(keyPath)
}

/**
 * Load the 32-byte encryption key from `keyPath`, creating a fresh random key
 * (with owner-only read permissions) on first use.
 */
export function getOrCreateKey(keyPath: string): Buffer {
  if (existsSync(keyPath)) {
    return readFileSync(keyPath)
  }
  const key = randomBytes(KEY_LENGTH)
  mkdirSync(dirname(keyPath), { recursive: true })
  writeFileSync(keyPath, key)
  chmodSync(keyPath, 0o400)
  return key
}

/** Encrypt plaintext with AES-256-GCM. Returns `base64(iv || authTag || ciphertext)`. */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, encrypted]).toString('base64')
}

/** Decrypt a value produced by {@link encrypt}. Throws on wrong key / corrupt data. */
export function decrypt(ciphertext: string, key: Buffer): string {
  const buf = Buffer.from(ciphertext, 'base64')
  const iv = buf.subarray(0, IV_LENGTH)
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const encrypted = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8')
}

/**
 * True when `value` is an environment-variable template rather than a literal
 * secret — both `${VAR}` and `$VAR` forms (the provider resolvers accept both).
 */
export function isEnvTemplate(value: string): boolean {
  return /^\$\{.*\}$/.test(value) || /^\$[A-Z_][A-Z0-9_]*$/.test(value)
}

/**
 * Encrypt an API key for storage. Environment-variable templates and empty
 * values are not secrets, so they pass through unchanged (keeping config.yml
 * readable for env-based setups). Literal secrets get the `enc:v1:` prefix.
 */
export function encryptApiKey(apiKey: string, key: Buffer): string {
  if (!apiKey || isEnvTemplate(apiKey)) return apiKey
  return ENC_PREFIX + encrypt(apiKey, key)
}

/**
 * Decrypt a stored API key. Plaintext (legacy or template) values pass through
 * unchanged; `enc:v1:` values are decrypted. Throws on a missing/corrupt key so
 * the caller can surface a clear error instead of sending a garbage key.
 */
export function decryptApiKey(stored: string, key: Buffer): string {
  if (!stored.startsWith(ENC_PREFIX)) return stored
  return decrypt(stored.slice(ENC_PREFIX.length), key)
}
