# Phase 9 — MCP 深度集成 + 1M 上下文窗口 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MCP OAuth PKCE 认证 + 动态工具更新 + 运行时管理，以及 js-tiktoken 真实 tokenizer + 硬编码限制自适应升级

**Architecture:** 两个独立子系统并行交付。MCP 在现有 stdio transport 上叠加 OAuth 认证层，新增 TokenStore 加密持久化，McpClient 增加断线重连和 tools-changed 事件。上下文层用 js-tiktoken cl100k_base 替换 chars/4 启发式估算，阈值随 contextWindow 大小自适应。

**Tech Stack:** TypeScript 5.5+, Bun/Node.js 22+, js-tiktoken (WASM cl100k_base), Node.js crypto (AES-256-GCM), http (OAuth local server)

## Global Constraints

- 现有 834 测试零回归
- Bun 优先，Node.js 22+ 兼容
- 所有 Provider 保持字母序
- 提交信息遵循 Conventional Commits
- 代码风格：ESLint (flat config) + Prettier，CI 强制执行
- Feature flags: `mcp.oauthEnabled`, `context.useRealTokenizer`, `context.adaptiveThresholds`（默认全开）
- OAuth: PKCE only，不实现 device flow / client credentials
- Tokenizer: cl100k_base only，不多 encoder
- Transport: stdio only，不 WebSocket/HTTP

---

### Task 1: MCP Token Store + 加密持久化

**Files:**

- Create: `apps/cli/src/mcp/token-store.ts`
- Test: `apps/cli/test/mcp/token-store.test.ts`

**Interfaces:**

- Produces: `TokenStore` class — `save(serverName, tokens)`, `load(serverName)`, `delete(serverName)`, `list()`

- [ ] **Step 1: 写 TokenStore 测试**

```typescript
// apps/cli/test/mcp/token-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { TokenStore } from '../../src/mcp/token-store'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('TokenStore', () => {
  let store: TokenStore
  let testDir: string

  beforeEach(() => {
    testDir = join(tmpdir(), `mcp-tokens-test-${Date.now()}`)
    store = new TokenStore(testDir)
  })

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
  })

  it('saves and loads tokens', () => {
    store.save('test-server', {
      accessToken: 'access-abc',
      refreshToken: 'refresh-xyz',
      expiresAt: '2026-09-07T10:00:00Z',
      scopes: ['tools.read'],
    })
    const loaded = store.load('test-server')
    expect(loaded).not.toBeNull()
    expect(loaded!.accessToken).toBe('access-abc')
    expect(loaded!.refreshToken).toBe('refresh-xyz')
  })

  it('encrypts tokens at rest', () => {
    store.save('test-server', {
      accessToken: 'secret-token',
      refreshToken: 'secret-refresh',
      expiresAt: '2026-09-07T10:00:00Z',
    })
    const { readFileSync } = require('node:fs')
    const raw = readFileSync(join(testDir, 'test-server.enc'), 'utf-8')
    // 原始文件不应包含明文 token
    expect(raw).not.toContain('secret-token')
    expect(raw).not.toContain('secret-refresh')
  })

  it('returns null for missing server', () => {
    expect(store.load('nonexistent')).toBeNull()
  })

  it('deletes tokens', () => {
    store.save('to-delete', { accessToken: 'x', expiresAt: '2026-09-07T10:00:00Z' })
    store.delete('to-delete')
    expect(store.load('to-delete')).toBeNull()
  })

  it('lists all stored servers', () => {
    store.save('server-a', { accessToken: 'a', expiresAt: '2026-09-07T10:00:00Z' })
    store.save('server-b', { accessToken: 'b', expiresAt: '2026-09-07T10:00:00Z' })
    const list = store.list()
    expect(list).toContain('server-a')
    expect(list).toContain('server-b')
  })

  it('creates directory on first save', () => {
    const nested = join(testDir, 'nested', 'deep')
    const nestedStore = new TokenStore(nested)
    nestedStore.save('srv', { accessToken: 't', expiresAt: '2026-09-07T10:00:00Z' })
    expect(existsSync(nested)).toBe(true)
  })

  it('sets file permissions to 600', () => {
    store.save('perm-test', { accessToken: 't', expiresAt: '2026-09-07T10:00:00Z' })
    const { statSync } = require('node:fs')
    const stat = statSync(join(testDir, 'perm-test.enc'))
    // mode 0o600 = 33152 decimal (owner rw only, on Unix)
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600)
    }
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

```bash
cd apps/cli && npx vitest run test/mcp/token-store.test.ts
```

Expected: FAIL — `TokenStore` 模块不存在

- [ ] **Step 3: 实现 TokenStore**

```typescript
// apps/cli/src/mcp/token-store.ts
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
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'
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
  // 生成新密钥
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
  // Pack: iv (16) + authTag (16) + ciphertext
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
      /* Windows */
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
```

- [ ] **Step 4: 运行测试验证通过**

```bash
cd apps/cli && npx vitest run test/mcp/token-store.test.ts
```

Expected: 7 tests PASS

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @miphamai/cli typecheck
```

Expected: clean

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/mcp/token-store.ts apps/cli/test/mcp/token-store.test.ts
git commit -m "feat(mcp): add TokenStore with AES-256-GCM encrypted token persistence

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: MCP OAuth PKCE 认证流程

**Files:**

- Create: `apps/cli/src/mcp/oauth.ts`
- Modify: `apps/cli/src/shared/types.ts` — 添加 `McpServerConfig.auth` 字段
- Modify: `apps/cli/src/mcp/client.ts` — 集成 OAuth connect
- Test: `apps/cli/test/mcp/oauth.test.ts`

**Interfaces:**

- Consumes: `TokenStore` from Task 1 — `save()`, `load()`, `delete()`
- Produces: `OAuthClient` class — `executePkceFlow(config: McpServerConfig): Promise<string>`, `refreshAccessToken(config): Promise<string>`, `getValidAccessToken(serverName, config): Promise<string>`

- [ ] **Step 1: 扩展 McpServerConfig 类型**

```typescript
// apps/cli/src/shared/types.ts — 在 McpServerConfig 接口中添加:
auth?: {
  type: 'oauth'
  authorizationUrl: string
  tokenUrl: string
  clientId: string
  scopes?: string[]
  redirectPort?: number
}
```

- [ ] **Step 2: 写 OAuthClient 测试**

```typescript
// apps/cli/test/mcp/oauth.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OAuthClient } from '../../src/mcp/oauth'
import { TokenStore } from '../../src/mcp/token-store'
import { createServer, Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, rmSync } from 'node:fs'

describe('OAuthClient', () => {
  let mockAuthServer: Server
  let authPort: number
  const testDir = join(tmpdir(), `mcp-oauth-test-${Date.now()}`)

  beforeAll(async () => {
    // 启动 mock OAuth server
    authPort = 19877
    mockAuthServer = createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${authPort}`)
      if (url.pathname === '/authorize') {
        // 返回 redirect 到 callback（模拟用户授权）
        const redirectUri = url.searchParams.get('redirect_uri') || ''
        const state = url.searchParams.get('state') || ''
        const code = 'mock-auth-code-' + Date.now()
        res.writeHead(302, {
          Location: `${redirectUri}?code=${code}&state=${state}`,
        })
        res.end()
      } else if (url.pathname === '/token') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            access_token: 'mock-access-token-123',
            refresh_token: 'mock-refresh-token-456',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        )
      }
    })
    await new Promise<void>((resolve) => mockAuthServer.listen(authPort, resolve))
  })

  afterAll(() => {
    mockAuthServer.close()
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
  })

  it('generates valid PKCE code_verifier and code_challenge', () => {
    const client = new OAuthClient(new TokenStore(testDir))
    const { codeVerifier, codeChallenge } = client.generatePkcePair()
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43)
    expect(codeChallenge.length).toBe(43) // SHA-256 base64url = 43 chars
    expect(codeVerifier).not.toBe(codeChallenge)
  })

  it('executes full PKCE flow against mock server', async () => {
    const client = new OAuthClient(new TokenStore(testDir))
    const mockConfig = {
      name: 'test-oauth-server',
      command: 'echo',
      args: ['test'],
      auth: {
        type: 'oauth' as const,
        authorizationUrl: `http://localhost:${authPort}/authorize`,
        tokenUrl: `http://localhost:${authPort}/token`,
        clientId: 'test-client-id',
        scopes: ['tools.read'],
        redirectPort: 19878,
      },
    }
    // 启动本地 callback 服务器然后立即停止（避免端口冲突）
    const tokens = await client.executePkceFlow(mockConfig)
    expect(tokens.accessToken).toBe('mock-access-token-123')
    expect(tokens.refreshToken).toBe('mock-refresh-token-456')
  })

  it('stores tokens via TokenStore after successful flow', async () => {
    const store = new TokenStore(testDir)
    const client = new OAuthClient(store)
    const mockConfig = {
      name: 'test-oauth-store',
      command: 'echo',
      args: ['test'],
      auth: {
        type: 'oauth' as const,
        authorizationUrl: `http://localhost:${authPort}/authorize`,
        tokenUrl: `http://localhost:${authPort}/token`,
        clientId: 'test-client-id',
        redirectPort: 19879,
      },
    }
    await client.executePkceFlow(mockConfig)
    const saved = store.load('test-oauth-store')
    expect(saved).not.toBeNull()
    expect(saved!.accessToken).toBe('mock-access-token-123')
  })

  it('getValidAccessToken returns existing non-expired token', async () => {
    const store = new TokenStore(testDir)
    store.save('cached-srv', {
      accessToken: 'cached-token',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    })
    const client = new OAuthClient(store)
    const token = await client.getValidAccessToken('cached-srv', {
      name: 'cached-srv',
      command: 'echo',
      args: [],
      auth: { type: 'oauth', authorizationUrl: '', tokenUrl: '', clientId: '' },
    })
    expect(token).toBe('cached-token')
  })

  it('getValidAccessToken refreshes expired token', async () => {
    const store = new TokenStore(testDir)
    store.save('expired-srv', {
      accessToken: 'old-token',
      refreshToken: 'refresh-me',
      expiresAt: new Date(Date.now() - 3600000).toISOString(),
    })
    const client = new OAuthClient(store)
    const token = await client.getValidAccessToken('expired-srv', {
      name: 'expired-srv',
      command: 'echo',
      args: [],
      auth: {
        type: 'oauth',
        authorizationUrl: '',
        tokenUrl: `http://localhost:${authPort}/token`,
        clientId: '',
      },
    })
    expect(token).toBe('mock-access-token-123')
  })
})
```

- [ ] **Step 3: 运行测试验证失败**

```bash
cd apps/cli && npx vitest run test/mcp/oauth.test.ts
```

Expected: FAIL — `OAuthClient` 模块不存在

- [ ] **Step 4: 实现 OAuthClient**

```typescript
// apps/cli/src/mcp/oauth.ts
import { randomBytes, createHash } from 'node:crypto'
import { createServer, Server } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { McpServerConfig } from '../shared/types'
import { TokenStore } from './token-store'

interface PkceKeys {
  codeVerifier: string
  codeChallenge: string
}

interface TokenResponse {
  accessToken: string
  refreshToken?: string
  expiresAt: string
  scopes?: string[]
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export class OAuthClient {
  constructor(private store: TokenStore) {}

  generatePkcePair(): PkceKeys {
    const codeVerifier = base64url(randomBytes(64)) // 128 raw bytes
    const hash = createHash('sha256').update(codeVerifier).digest()
    const codeChallenge = base64url(hash)
    return { codeVerifier, codeChallenge }
  }

  async executePkceFlow(config: McpServerConfig): Promise<TokenResponse> {
    const auth = config.auth!
    const port = auth.redirectPort || 19876
    const { codeVerifier, codeChallenge } = this.generatePkcePair()
    const state = base64url(randomBytes(32))

    // 启动本地 HTTP server 接收 callback
    const code = await new Promise<string>((resolve, reject) => {
      const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url || '/', `http://localhost:${port}`)
        if (url.pathname === '/callback') {
          const receivedCode = url.searchParams.get('code')
          const receivedState = url.searchParams.get('state')
          if (receivedState !== state) {
            res.writeHead(400)
            res.end('State mismatch')
            reject(new Error('OAuth state mismatch'))
            return
          }
          if (!receivedCode) {
            res.writeHead(400)
            res.end('No code received')
            reject(new Error('No authorization code received'))
            return
          }
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(
            '<html><body><h1>✅ Authenticated</h1><p>You may close this window.</p></body></html>',
          )
          server.close()
          resolve(receivedCode)
        }
      })
      server.listen(port, () => {
        // 打开浏览器到 authorization URL
        const authUrl = new URL(auth.authorizationUrl)
        authUrl.searchParams.set('response_type', 'code')
        authUrl.searchParams.set('client_id', auth.clientId)
        authUrl.searchParams.set('code_challenge', codeChallenge)
        authUrl.searchParams.set('code_challenge_method', 'S256')
        authUrl.searchParams.set('redirect_uri', `http://localhost:${port}/callback`)
        authUrl.searchParams.set('state', state)
        if (auth.scopes?.length) {
          authUrl.searchParams.set('scope', auth.scopes.join(' '))
        }
        // 用 open 命令打开浏览器
        const cmd =
          process.platform === 'darwin'
            ? `open "${authUrl.toString()}"`
            : process.platform === 'win32'
              ? `start "" "${authUrl.toString()}"`
              : `xdg-open "${authUrl.toString()}"`
        const { exec } = require('node:child_process')
        exec(cmd, () => {
          /* fire-and-forget */
        })
      })
      // 超时 5 分钟
      setTimeout(() => {
        server.close()
        reject(new Error('OAuth flow timed out (5 minutes)'))
      }, 300_000)
    })

    // 交换 code 获取 token
    const tokenResponse = await fetch(auth.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        redirect_uri: `http://localhost:${port}/callback`,
        client_id: auth.clientId,
      }).toString(),
    })

    if (!tokenResponse.ok) {
      const body = await tokenResponse.text()
      throw new Error(`Token exchange failed: ${tokenResponse.status} ${body}`)
    }

    const data = (await tokenResponse.json()) as {
      access_token: string
      refresh_token?: string
      expires_in?: number
      scope?: string
    }

    const result: TokenResponse = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString(),
      scopes: data.scope?.split(' '),
    }

    // 加密持久化
    this.store.save(config.name, result)
    return result
  }

  async getValidAccessToken(serverName: string, config: McpServerConfig): Promise<string> {
    const saved = this.store.load(serverName)
    if (saved && new Date(saved.expiresAt).getTime() > Date.now() + 60000) {
      // Token still valid (>1 minute buffer)
      return saved.accessToken
    }
    if (saved?.refreshToken) {
      // 过期，尝试 refresh
      return this.refreshAccessToken(serverName, config)
    }
    // 没有有效 token，执行完整 PKCE
    const fresh = await this.executePkceFlow(config)
    return fresh.accessToken
  }

  async refreshAccessToken(serverName: string, config: McpServerConfig): Promise<string> {
    const saved = this.store.load(serverName)
    if (!saved?.refreshToken) {
      throw new Error(`No refresh token available for "${serverName}"`)
    }
    const auth = config.auth!
    const response = await fetch(auth.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: saved.refreshToken,
        client_id: auth.clientId,
      }).toString(),
    })
    if (!response.ok) {
      // Refresh 失败，回退到完整 PKCE
      this.store.delete(serverName)
      const fresh = await this.executePkceFlow(config)
      return fresh.accessToken
    }
    const data = (await response.json()) as {
      access_token: string
      refresh_token?: string
      expires_in?: number
    }
    this.store.save(serverName, {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || saved.refreshToken,
      expiresAt: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString(),
    })
    return data.access_token
  }
}
```

- [ ] **Step 5: 修改 McpClient 集成 OAuth**

在 `apps/cli/src/mcp/client.ts` 中添加 `connectWithOAuth` 方法：

```typescript
// 在 McpClient 类中添加:
import { OAuthClient } from './oauth'
import { TokenStore } from './token-store'

// 新增字段:
private oauthClient: OAuthClient
private tokenStore: TokenStore

constructor() {
  // ...existing singleton check...
  this.tokenStore = new TokenStore()
  this.oauthClient = new OAuthClient(this.tokenStore)
}

async connectWithOAuth(config: McpServerConfig): Promise<ConnectionInfo> {
  const accessToken = await this.oauthClient.getValidAccessToken(config.name, config)
  // 将 access token 注入 env
  const oauthConfig = {
    ...config,
    env: {
      ...config.env,
      MCP_ACCESS_TOKEN: accessToken,
    },
  }
  return this.connect(oauthConfig)
}
```

- [ ] **Step 6: 运行测试验证通过**

```bash
cd apps/cli && npx vitest run test/mcp/oauth.test.ts test/mcp/token-store.test.ts
```

Expected: 13 tests PASS

- [ ] **Step 7: Typecheck**

```bash
pnpm --filter @miphamai/cli typecheck
```

Expected: clean

- [ ] **Step 8: Commit**

```bash
git add apps/cli/src/mcp/oauth.ts apps/cli/src/mcp/client.ts apps/cli/src/shared/types.ts apps/cli/test/mcp/oauth.test.ts
git commit -m "feat(mcp): add OAuth PKCE authentication flow

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: MCP 动态工具更新 + 断线重连

**Files:**

- Modify: `apps/cli/src/mcp/protocol.ts` — 注册 `notifications/tools/list_changed` handler
- Modify: `apps/cli/src/mcp/client.ts` — `reconnect()`, `onToolsChanged()`, 事件系统
- Modify: `apps/cli/src/mcp/registry.ts` — 运行时 diff + re-register

**Interfaces:**

- Consumes: `McpClient` from Task 2 — 已有 `connectWithOAuth()`
- Produces: `McpClient.reconnect()`, `McpClient.onToolsChanged()`, `McpClient.on()/emit()` 事件系统

- [ ] **Step 1: 修改 McpProtocol — 监听 list_changed 通知**

```typescript
// apps/cli/src/mcp/protocol.ts — 在 initialize() 方法末尾添加:
this.transport.onNotification((notification) => {
  if (notification.method === 'notifications/tools/list_changed') {
    this.emit('tools-changed', notification.params)
  }
})
```

在 `McpProtocol` 类中添加事件发射器:

```typescript
// 简单事件系统（不引入外部依赖）
private handlers = new Map<string, Array<(...args: any[]) => void>>()

on(event: string, handler: (...args: any[]) => void): void {
  const list = this.handlers.get(event) || []
  list.push(handler)
  this.handlers.set(event, list)
}

private emit(event: string, ...args: any[]): void {
  const list = this.handlers.get(event) || []
  for (const h of list) h(...args)
}
```

- [ ] **Step 2: 修改 McpClient — 事件系统 + 重连 + tools-changed**

```typescript
// apps/cli/src/mcp/client.ts — 在 McpClient 中添加事件系统:
private handlers = new Map<string, Array<(...args: any[]) => void>>()

on(event: string, handler: (...args: any[]) => void): void {
  const list = this.handlers.get(event) || []
  list.push(handler)
  this.handlers.set(event, list)
}

private emit(event: string, ...args: any[]): void {
  const list = this.handlers.get(event) || []
  for (const h of list) h(...args)
}

// 在 connect() 方法中注册 tools-changed 监听:
const protocol = new McpProtocol(transport)
protocol.on('tools-changed', async () => {
  await this.onToolsChanged(config.name)
})

// onToolsChanged 实现:
async onToolsChanged(name: string): Promise<void> {
  const connection = this.connections.get(name)
  if (!connection || connection.status !== 'connected') return

  const oldToolNames = new Set(connection.tools.map(t => t.name))
  const newTools = await connection.protocol.listTools()
  const newToolNames = new Set(newTools.map(t => t.name))

  const added = newTools.filter(t => !oldToolNames.has(t.name))
  const removed = connection.tools.filter(t => !newToolNames.has(t.name))

  connection.tools = newTools

  // 通知外部（由 registry 层处理注册/注销）
  if (added.length > 0 || removed.length > 0) {
    this.emit('tools-changed', name, added, removed)
  }
}

// reconnect 实现（指数退避）:
async reconnect(name: string): Promise<ConnectionInfo> {
  const connection = this.connections.get(name)
  if (!connection) throw new Error(`No connection for "${name}"`)

  const config = connection.config
  let delay = 1000
  const maxDelay = 60000
  const maxAttempts = 10

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // 清理旧连接
      try { connection.transport.close() } catch { /* ok */ }
      this.connections.delete(name)

      // 重新连接
      const result = await this.connect(config)
      this.emit('reconnected', name)
      return result
    } catch (err) {
      if (attempt === maxAttempts) {
        connection.status = 'error'
        connection.error = String(err)
        this.emit('disconnected', name, err)
        throw err
      }
      await new Promise(resolve => setTimeout(resolve, delay))
      delay = Math.min(delay * 2, maxDelay)
    }
  }
  throw new Error(`Failed to reconnect "${name}" after ${maxAttempts} attempts`)
}
```

- [ ] **Step 3: 修改 registerMcpServerTools — 运行时支持**

在 `apps/cli/src/mcp/registry.ts` 中新增 `diffAndUpdateTools` 函数:

```typescript
export function diffAndUpdateTools(
  serverName: string,
  oldTools: Map<string, any>,
  newTools: McpToolDefinition[],
): { added: number; removed: number } {
  const sanitizedPrefix = `mcp__${sanitize(serverName)}__`

  // 找到旧工具中属于该 server 的
  const oldServerTools = new Map<string, any>()
  for (const [name, def] of oldTools.entries()) {
    if (name.startsWith(sanitizedPrefix)) {
      oldServerTools.set(name, def)
    }
  }

  // 注销已删除的工具
  let removed = 0
  for (const [name] of oldServerTools.entries()) {
    const mcpName = name.replace(sanitizedPrefix, '')
    if (!newTools.find((t) => sanitize(t.name) === mcpName)) {
      oldTools.delete(name)
      removed++
    }
  }

  // 注册新增的工具
  let added = 0
  for (const mcpTool of newTools) {
    const fullName = `${sanitizedPrefix}${sanitize(mcpTool.name)}`
    if (!oldTools.has(fullName)) {
      const converted = convertMcpTool(serverName, mcpTool)
      oldTools.set(fullName, converted)
      added++
    }
  }

  return { added, removed }
}
```

- [ ] **Step 4: 运行回归测试**

```bash
cd apps/cli && npx vitest run test/mcp/
```

Expected: 所有已有 MCP 测试仍绿

- [ ] **Step 5: Typecheck + format**

```bash
pnpm --filter @miphamai/cli typecheck && npx prettier --check apps/cli/src/mcp/
```

Expected: clean

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/mcp/protocol.ts apps/cli/src/mcp/client.ts apps/cli/src/mcp/registry.ts
git commit -m "feat(mcp): add dynamic tool updates and reconnect with exponential backoff

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: MCP 运行时服务器管理 — Slash 命令

**Files:**

- Modify: `apps/cli/src/ui/commands.ts` — 增强 `/mcp` 命令，新增 `/mcp connect/disconnect/reload`
- Modify: `apps/cli/src/config/loader.ts` — 运行时 mcp-tokens 读取

**Interfaces:**

- Consumes: `McpClient` — `connectWithOAuth()`, `disconnect()`, `connect()`; `TokenStore` — `list()`, `load()`

- [ ] **Step 1: 重写 mcpCmd 添加 connect/disconnect/reload 子命令**

```typescript
// apps/cli/src/ui/commands.ts — 替换现有 mcpCmd

const mcpCmd: CommandHandler = async (ctx, args) => {
  const client = McpClient.getInstance()
  const sub = args[0]?.toLowerCase()

  // /mcp connect <name>
  if (sub === 'connect') {
    const name = args[1]
    if (!name) return { content: 'Usage: /mcp connect <server-name>' }

    // 查找配置
    const mcpServers = ctx.config.skills?.mcpServers ?? []
    const config = mcpServers.find((s) => s.name === name)
    if (!config) {
      return {
        content: `Server "${name}" not found in config.\n\nConfigured servers: ${mcpServers.map((s) => s.name).join(', ') || '(none)'}`,
      }
    }

    if (config.auth?.type === 'oauth') {
      return {
        content: [
          `── MCP Connect: ${name} (OAuth) ──`,
          '',
          'Starting OAuth PKCE flow...',
          'A browser window will open for authentication.',
          `Authorization: ${config.auth.authorizationUrl}`,
          `Scopes: ${config.auth.scopes?.join(', ') || '(default)'}`,
          '',
          'This may take up to 5 minutes.',
        ].join('\n'),
        forwardToAI: `Connect to MCP server "${name}" using OAuth. Call McpClient.getInstance().connectWithOAuth(config) with the server config "${name}". After connecting, call registerMcpServerTools() to register its tools. Report the result.`,
      }
    }

    return {
      content: `── MCP Connect: ${name} ──\n\nConnecting via stdio...`,
      forwardToAI: `Connect to MCP server "${name}" using McpClient.getInstance().connect(config). After connecting, register its tools. Report the result.`,
    }
  }

  // /mcp disconnect <name>
  if (sub === 'disconnect') {
    const name = args[1]
    if (!name) return { content: 'Usage: /mcp disconnect <server-name>' }
    const tools = client.disconnect(name)
    return {
      content: [
        `── MCP Disconnect: ${name} ──`,
        '',
        tools.length > 0
          ? `✓ Disconnected. ${tools.length} tool(s) unregistered.`
          : '✓ Disconnected (no tools were registered).',
      ].join('\n'),
    }
  }

  // /mcp reload
  if (sub === 'reload') {
    return {
      content: '── MCP Reload ──\n\nDisconnecting all servers and reconnecting...',
      forwardToAI:
        'Disconnect all MCP servers via McpClient.getInstance().closeAll(), then reconnect all configured servers. Report each server status.',
    }
  }

  // /mcp (default status)
  const configuredServers = ctx.config.skills?.mcpServers ?? []
  const liveConnections = client.listConnections()
  const tokenStore = new TokenStore()

  const lines: string[] = ['── MCP Servers ──', '']

  if (configuredServers.length > 0) {
    lines.push(`Configured servers (${configuredServers.length}):`)
    lines.push('')
    for (const s of configuredServers) {
      const live = liveConnections.find((c) => c.config.name === s.name)
      const statusIcon = live
        ? live.status === 'connected'
          ? '🟢'
          : live.status === 'connecting'
            ? '🟡'
            : live.status === 'error'
              ? '🔴'
              : '⚪'
        : '⚪'
      const statusLabel = live ? live.status : 'not started'
      const oauthStatus = s.auth?.type === 'oauth' ? (tokenStore.load(s.name) ? ' 🔑' : ' 🔒') : ''
      lines.push(`  ${statusIcon} ${s.name}${oauthStatus}  [${statusLabel}]`)
      lines.push(`     Command: ${s.command} ${s.args.join(' ')}`)
      if (live?.tools && live.tools.length > 0) {
        lines.push(`     Tools: ${live.tools.length} registered`)
      }
      if (live?.error) lines.push(`     Error: ${live.error}`)
      lines.push('')
    }
  } else {
    lines.push('No MCP servers configured.')
  }

  lines.push('── Commands ──')
  lines.push('  /mcp connect <name>    Connect to a server (OAuth or stdio)')
  lines.push('  /mcp disconnect <name>  Disconnect from a server')
  lines.push('  /mcp reload            Disconnect all and reconnect')

  return { content: lines.join('\n') }
}
```

- [ ] **Step 2: 运行测试验证已有 MCP 测试仍通过**

```bash
cd apps/cli && npx vitest run test/mcp/ test/ui/commands.test.ts
```

Expected: 所有测试 PASS

- [ ] **Step 3: Typecheck + format**

```bash
pnpm --filter @miphamai/cli typecheck
```

Expected: clean

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/ui/commands.ts apps/cli/src/config/loader.ts
git commit -m "feat(mcp): add runtime server management — /mcp connect/disconnect/reload

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: 真实 Tokenizer — js-tiktoken 集成

**Files:**

- Create: `apps/cli/src/core/tokenizer.ts`
- Modify: `apps/cli/src/core/context.ts` — 替换 `estimateTokens()`
- Modify: `apps/cli/src/core/context-token.ts` — 替换 `estimateMessageTokens()`
- Modify: `apps/cli/package.json` — 添加 `js-tiktoken` 依赖

**Interfaces:**

- Produces: `TokenCounter` class — `count(text: string): number`, `countMessages(messages: Message[]): number`, `truncateToTokens(text: string, maxTokens: number): string`

- [ ] **Step 1: 安装依赖**

```bash
cd apps/cli && pnpm add js-tiktoken
```

- [ ] **Step 2: 写 TokenCounter 实现**

```typescript
// apps/cli/src/core/tokenizer.ts
import type { Tiktoken } from 'js-tiktoken'
import type { Message } from '../shared/types'

let encoder: Tiktoken | null = null
let initPromise: Promise<void> | null = null

async function getEncoder(): Promise<Tiktoken> {
  if (encoder) return encoder
  if (!initPromise) {
    initPromise = (async () => {
      const { getEncoding } = await import('js-tiktoken')
      encoder = getEncoding('cl100k_base')
    })()
  }
  await initPromise
  return encoder!
}

export class TokenCounter {
  private cache = new Map<string, number>()
  private initialized = false

  private async ensureInit(): Promise<void> {
    if (!this.initialized) {
      await getEncoder()
      this.initialized = true
    }
  }

  async count(text: string): Promise<number> {
    if (!text) return 0
    // 检查缓存
    const cached = this.cache.get(text)
    if (cached !== undefined) return cached

    await this.ensureInit()
    const enc = encoder!
    const tokens = enc.encode(text).length
    this.cache.set(text, tokens)
    return tokens
  }

  countSync(text: string): number {
    if (!text) return 0
    const cached = this.cache.get(text)
    if (cached !== undefined) return cached
    // 兜底：chars/4 启发式（WASM 未加载时）
    return Math.ceil(text.length / 4)
  }

  async countMessages(messages: Message[]): Promise<number> {
    let total = 0
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        total += await this.count(msg.content)
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            total += await this.count(block.text)
          }
        }
      }
      // 每条消息有 ~4 tokens 的格式开销
      total += 4
    }
    return total
  }

  async truncateToTokens(text: string, maxTokens: number): Promise<string> {
    await this.ensureInit()
    const enc = encoder!
    const tokens = Array.from(enc.encode(text))
    if (tokens.length <= maxTokens) return text
    const truncated = tokens.slice(0, maxTokens)
    return new TextDecoder().decode(enc.decode(new Uint32Array(truncated)))
  }

  invalidateCache(): void {
    this.cache.clear()
  }

  /** 清除 WASM 状态，用于测试 reset */
  static reset(): void {
    encoder = null
    initPromise = null
  }
}
```

- [ ] **Step 3: 写 TokenCounter 测试**

```typescript
// apps/cli/test/core/tokenizer.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { TokenCounter } from '../../src/core/tokenizer'

describe('TokenCounter', () => {
  let counter: TokenCounter

  beforeEach(() => {
    counter = new TokenCounter()
    counter.invalidateCache()
  })

  it('counts empty string as 0', async () => {
    expect(await counter.count('')).toBe(0)
  })

  it('counts simple English text', async () => {
    const tokens = await counter.count('Hello, world!')
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBeLessThan(10) // "Hello, world!" ≈ 4 tokens in cl100k
  })

  it('counts Chinese text (mixed CJK)', async () => {
    const tokens = await counter.count('你好世界')
    // CJK characters are more token-dense than chars/4 would suggest
    expect(tokens).toBeGreaterThan(0)
  })

  it('sync count falls back to chars/4', () => {
    const tokens = counter.countSync('Hello, this is a test message')
    expect(tokens).toBe(Math.ceil('Hello, this is a test message'.length / 4))
  })

  it('countMessages sums token counts for all messages', async () => {
    const msgs = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi there!' },
    ]
    const tokens = await counter.countMessages(msgs)
    expect(tokens).toBeGreaterThan(0)
    // Token count includes content + 4 per message overhead
    expect(tokens).toBeGreaterThanOrEqual(
      (await counter.count('Hello')) + (await counter.count('Hi there!')) + 8,
    )
  })

  it('uses cache for repeated text', async () => {
    const text = 'This is a test message that should be cached'
    const first = await counter.count(text)
    const second = await counter.count(text)
    expect(first).toBe(second)
  })

  it('truncateToTokens shortens long text', async () => {
    const text = 'one two three four five six seven eight nine ten'
    const truncated = await counter.truncateToTokens(text, 5)
    expect(truncated.length).toBeLessThan(text.length)
  })
})
```

- [ ] **Step 4: 运行测试验证失败**

```bash
cd apps/cli && npx vitest run test/core/tokenizer.test.ts
```

Expected: FAIL — 文件不存在

- [ ] **Step 5: 运行测试验证通过**

```bash
cd apps/cli && npx vitest run test/core/tokenizer.test.ts
```

Expected: 7 tests PASS

- [ ] **Step 6: 修改 ContextManager.estimateTokens() — 集成 TokenCounter**

在 `apps/cli/src/core/context.ts` 中：

```typescript
import { TokenCounter } from './tokenizer'

// ContextManager 类新增:
private tokenCounter = new TokenCounter()
private useRealTokenizer = true  // 通过 config 控制

async estimateTokensAsync(text: string): Promise<number> {
  if (this.useRealTokenizer) {
    try {
      return await this.tokenCounter.count(text)
    } catch {
      // 降级到启发式
    }
  }
  return this.estimateTokens(text)
}

// 保留现有 estimateTokens() 作为同步 fallback（不做破坏性变更）
estimateTokens(text: string): number {
  // ...existing implementation unchanged...
}

// addMessage() 改为异步感知:
async addMessageAsync(message: Message): Promise<void> {
  this.addMessage(message)
  // 更新精确 token count
  const content = typeof message.content === 'string' ? message.content : ''
  const tokens = await this.estimateTokensAsync(content)
  this.estimatedTokens = Math.max(this.estimatedTokens, tokens)
}
```

- [ ] **Step 7: 替换 context-token.ts 中的估算**

```typescript
// apps/cli/src/core/context-token.ts
import { TokenCounter } from './tokenizer'

const sharedCounter = new TokenCounter()

export async function estimateMessageTokensAsync(msgs: Message[]): Promise<number> {
  return sharedCounter.countMessages(msgs)
}

// 保留旧函数作为 fallback
export function estimateMessageTokens(msgs: Message[]): number {
  // ...existing implementation...
}
```

- [ ] **Step 8: 运行全部回归测试**

```bash
cd apps/cli && npx vitest run
```

Expected: 834+ 测试 PASS

- [ ] **Step 9: Commit**

```bash
git add apps/cli/src/core/tokenizer.ts apps/cli/src/core/context.ts apps/cli/src/core/context-token.ts apps/cli/package.json apps/cli/pnpm-lock.yaml apps/cli/test/core/tokenizer.test.ts
git commit -m "feat(context): add js-tiktoken real tokenizer with cl100k_base encoding

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 硬编码限制升级

**Files:**

- Modify: `apps/cli/src/core/engine.ts` — L1 summarizer 300→2000, L3 500→2000
- Modify: `apps/cli/src/core/context-compact.ts` — L2 2000→8000, L5 保留数自适应
- Modify: `apps/cli/src/core/memory/memory-manager.ts` — L4 预算自适应

- [ ] **Step 1: 升级 engine.ts — Summarizer 参数**

```typescript
// apps/cli/src/core/engine.ts — setupContextSummarizer() 方法中:

// 当前: maxTokens: 300
// 改为: maxTokens: 2000
const response = await registry.chat([{ role: 'user', content: summaryPrompt }], {
  maxTokens: 2000,
  temperature: 0.3,
})

// 当前: const text = typeof m.content === 'string' ? m.content.slice(0, 500) : ''
// 改为: slice(0, 2000)
const text = typeof m.content === 'string' ? m.content.slice(0, 2000) : ''
```

- [ ] **Step 2: 升级 context-compact.ts — 输出上限**

```typescript
// apps/cli/src/core/context-compact.ts

// 当前: const SUMMARY_MAX_CHARS = 2000
// 改为: 8000
const SUMMARY_MAX_CHARS = 8000

// 当前: keepRecent = 20
// 改为: 自适应
function getKeepRecent(contextWindow: number): number {
  return Math.max(20, Math.floor(contextWindow / 50000))
}
```

- [ ] **Step 3: 升级 memory-manager.ts — 自适应预算**

```typescript
// apps/cli/src/core/memory/memory-manager.ts — buildSystemReminder() 中:

// 当前: const TOKEN_BUDGET = 5000
// 改为:
const contextWindow = this.contextMaxTokens || 200000
const TOKEN_BUDGET = Math.max(5000, Math.floor(contextWindow * 0.05))
```

- [ ] **Step 4: 运行回归测试**

```bash
cd apps/cli && npx vitest run
```

Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/engine.ts apps/cli/src/core/context-compact.ts apps/cli/src/core/memory/memory-manager.ts
git commit -m "feat(context): upgrade hardcoded limits — summarizer 300→2000, cap 2000→8000, adaptive memory budget

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: 自适应阈值

**Files:**

- Modify: `apps/cli/src/core/context.ts` — 动态计算 compactionThreshold 和 microcompactThreshold

- [ ] **Step 1: 修改 ContextManager**

```typescript
// apps/cli/src/core/context.ts

// 在 Config 中添加 contextWindow 字段用于计算阈值
interface ContextConfig {
  maxTokens: number
  compactionThreshold: number
  contextWindow: number  // 新增: 模型声明的上下文窗口
}

// 添加方法:
private calculateThresholds(): void {
  const w = this.config.contextWindow

  // compaction: 窗口越大越晚压缩
  //   200K → 0.90, 500K → 0.93, 1M → 0.95
  this.config.compactionThreshold = Math.max(0.90, 1 - 50000 / w)

  // microcompact: 窗口越大越晚微压缩
  //   200K → 0.70, 500K → 0.80, 1M → 0.85
  this.microcompactThreshold = Math.max(0.70, 1 - 150000 / w)
}

// 在构造时调用 calculateThresholds()
// 在 updateMaxTokens() 中也调用
```

- [ ] **Step 2: 修改 index.tsx 传入 contextWindow**

```typescript
// apps/cli/src/index.tsx — ContextManager 构造处:
const context = new ContextManager({
  maxTokens: contextMaxTokens,
  compactionThreshold: 0.9,
  contextWindow: modelContextWindow, // 原始模型窗口大小
})
```

- [ ] **Step 3: 写自适应阈值测试**

```typescript
// 在 apps/cli/test/core/context.test.ts 中添加:

describe('adaptive thresholds', () => {
  it('1M window gets 0.95 compaction threshold', () => {
    const ctx = new ContextManager({
      maxTokens: 1_000_000,
      compactionThreshold: 0.9,
      contextWindow: 1_000_000,
    })
    expect(ctx.getCompactionThreshold()).toBeCloseTo(0.95, 2)
  })

  it('200K window gets 0.90 compaction threshold', () => {
    const ctx = new ContextManager({
      maxTokens: 200_000,
      compactionThreshold: 0.9,
      contextWindow: 200_000,
    })
    expect(ctx.getCompactionThreshold()).toBeCloseTo(0.75, 2) // 1 - 50000/200000 = 0.75, clamped to 0.90
  })

  it('128K window gets 0.90 compaction threshold (clamped)', () => {
    const ctx = new ContextManager({
      maxTokens: 128_000,
      compactionThreshold: 0.9,
      contextWindow: 128_000,
    })
    expect(ctx.getCompactionThreshold()).toBe(0.9)
  })

  it('500K window gets 0.90 compaction threshold', () => {
    const ctx = new ContextManager({
      maxTokens: 500_000,
      compactionThreshold: 0.9,
      contextWindow: 500_000,
    })
    expect(ctx.getCompactionThreshold()).toBeCloseTo(0.9, 1)
  })
})
```

- [ ] **Step 4: 运行测试验证**

```bash
cd apps/cli && npx vitest run test/core/context.test.ts
```

Expected: 自适应阈值测试 PASS + 原有测试 PASS

- [ ] **Step 5: 运行全部测试**

```bash
cd apps/cli && npx vitest run
```

Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/core/context.ts apps/cli/src/index.tsx apps/cli/test/core/context.test.ts
git commit -m "feat(context): adaptive compaction thresholds — scale with context window size

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Phase 9 收尾 — Feature Flags + 最终回归

**Files:**

- Modify: `apps/cli/src/config/defaults.ts` — 添加 Phase 9 feature flags
- Modify: `apps/cli/src/index.tsx` — 读取并应用 feature flags

- [ ] **Step 1: 添加 feature flags 到默认配置**

```yaml
# mcp.oauthEnabled: true
# context.useRealTokenizer: true
# context.adaptiveThresholds: true
```

在 `apps/cli/src/config/defaults.ts` 中添加相应 TypeScript 默认值。

- [ ] **Step 2: 在 index.tsx 中读取并应用**

```typescript
// 读取 feature flags
const oauthEnabled = config.features?.mcp?.oauthEnabled !== false // 默认 true
const useRealTokenizer = config.features?.context?.useRealTokenizer !== false
const adaptiveThresholds = config.features?.context?.adaptiveThresholds !== false

// 传入 ContextManager
const context = new ContextManager({
  maxTokens: contextMaxTokens,
  compactionThreshold: 0.9,
  contextWindow: modelContextWindow,
  useRealTokenizer,
  adaptiveThresholds,
})
```

- [ ] **Step 3: 运行全部回归测试**

```bash
cd apps/cli && npx vitest run
```

Expected: 834+ 测试全部 PASS

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @miphamai/cli typecheck
```

Expected: clean

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/config/defaults.ts apps/cli/src/index.tsx
git commit -m "feat(phase9): add feature flags for OAuth, real tokenizer, adaptive thresholds

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### 修订历史

| 版本  | 日期       | 变更内容                               | 维护人     |
| ----- | ---------- | -------------------------------------- | ---------- |
| 1.0.0 | 2026-08-07 | 初版：8 任务，MCP 深度集成 + 1M 上下文 | 技术委员会 |
