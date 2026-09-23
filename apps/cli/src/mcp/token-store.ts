import { existsSync, readFileSync, mkdirSync, unlinkSync, readdirSync, chmodSync } from 'node:fs'
import { atomicWriteFileSync } from '../shared/atomic-write'
import { join, dirname } from 'node:path'
import { encrypt, decrypt, getCredentialKey } from '../config/credential-crypto'
import { miphamHome } from '../core/paths.ts'

export interface TokenData {
  accessToken: string
  refreshToken?: string
  expiresAt: string
  createdAt?: string
  scopes?: string[]
  /**
   * 这份凭证绑给哪个签发方（见 `credentialBinding`）。缺失 = 绑定未知，
   * 调用方必须当作**不可用** —— 凭证只按服务名存，而服务名来自可从 cwd 读的
   * 项目级配置，故「同名」推不出「同一签发方」。
   */
  boundTo?: string
}

export class TokenStore {
  private key: Buffer
  private storeDir: string

  constructor(storeDir?: string) {
    this.storeDir = storeDir || miphamHome('mcp-tokens')
    this.key = getCredentialKey(dirname(this.storeDir))
  }

  save(serverName: string, data: TokenData): void {
    mkdirSync(this.storeDir, { recursive: true })
    const filePath = join(this.storeDir, `${serverName}.enc`)
    const json = JSON.stringify({
      ...data,
      createdAt: data.createdAt || new Date().toISOString(),
    })
    const encrypted = encrypt(json, this.key)
    atomicWriteFileSync(filePath, encrypted, { mode: 0o600 })
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
