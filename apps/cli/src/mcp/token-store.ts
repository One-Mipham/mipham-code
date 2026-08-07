import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  readdirSync,
  chmodSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16
const KEY_LENGTH = 32

interface TokenData {
  accessToken: string
  refreshToken?: string
  expiresAt: string
  createdAt?: string
  scopes?: string[]
}

function getEncryptionKey(keyPath: string): Buffer {
  if (existsSync(keyPath)) {
    return readFileSync(keyPath)
  }
  const key = randomBytes(KEY_LENGTH)
  mkdirSync(dirname(keyPath), { recursive: true })
  writeFileSync(keyPath, key)
  chmodSync(keyPath, 0o400)
  return key
}

function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, encrypted]).toString('base64')
}

function decrypt(ciphertext: string, key: Buffer): string {
  const buf = Buffer.from(ciphertext, 'base64')
  const iv = buf.subarray(0, IV_LENGTH)
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const encrypted = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8')
}

export class TokenStore {
  private key: Buffer
  private storeDir: string

  constructor(storeDir?: string) {
    this.storeDir = storeDir || join(homedir(), '.mipham', 'mcp-tokens')
    const keyPath = join(dirname(this.storeDir), '.mcp-key')
    this.key = getEncryptionKey(keyPath)
  }

  save(serverName: string, data: TokenData): void {
    mkdirSync(this.storeDir, { recursive: true })
    const filePath = join(this.storeDir, `${serverName}.enc`)
    const json = JSON.stringify({
      ...data,
      createdAt: data.createdAt || new Date().toISOString(),
    })
    const encrypted = encrypt(json, this.key)
    writeFileSync(filePath, encrypted, { mode: 0o600 })
    try {
      chmodSync(filePath, 0o600)
    } catch {
      /* Windows — chmod is a no-op */
    }
  }

  load(serverName: string): TokenData | null {
    const filePath = join(this.storeDir, `${serverName}.enc`)
    if (!existsSync(filePath)) return null
    try {
      const encrypted = readFileSync(filePath, 'utf-8')
      const json = decrypt(encrypted, this.key)
      return JSON.parse(json) as TokenData
    } catch {
      return null
    }
  }

  delete(serverName: string): void {
    const filePath = join(this.storeDir, `${serverName}.enc`)
    if (existsSync(filePath)) unlinkSync(filePath)
  }

  list(): string[] {
    if (!existsSync(this.storeDir)) return []
    return readdirSync(this.storeDir)
      .filter((f) => f.endsWith('.enc'))
      .map((f) => f.replace('.enc', ''))
  }
}
