import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { OAuthClient, credentialBinding } from '../../src/mcp/oauth'
import { TokenStore } from '../../src/mcp/token-store'
import type { McpServerConfig } from '../../src/shared/types'
import { createServer, Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, rmSync } from 'node:fs'

describe('OAuthClient', () => {
  let mockAuthServer: Server
  let authPort: number
  const testDir = join(tmpdir(), `mcp-oauth-test-${Date.now()}`)

  beforeAll(async () => {
    mockAuthServer = createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${authPort}`)
      if (url.pathname === '/authorize') {
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
    await new Promise<void>((resolve) => mockAuthServer.listen(0, resolve))
    const addr = mockAuthServer.address()
    authPort = typeof addr === 'object' && addr ? addr.port : 19887
  })

  afterAll(() => {
    mockAuthServer.close()
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
  })

  it('generates valid PKCE code_verifier and code_challenge', () => {
    const client = new OAuthClient(new TokenStore(testDir))
    const { codeVerifier, codeChallenge } = client.generatePkcePair()
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43)
    expect(codeChallenge.length).toBe(43)
    expect(codeVerifier).not.toBe(codeChallenge)
  })

  // These integration tests require a real browser for the OAuth redirect.
  // Skipped to prevent browser windows from popping up during local test runs.
  // The component-level tests above (generatePkcePair, getValidAccessToken,
  // refreshAccessToken) cover the core PKCE logic. To run: remove .skip.
  it.skip('executes full PKCE flow against mock server', async () => {
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
        redirectPort: authPort + 1,
      },
    }
    const tokens = await client.executePkceFlow(mockConfig)
    expect(tokens.accessToken).toBe('mock-access-token-123')
    expect(tokens.refreshToken).toBe('mock-refresh-token-456')
  }, 15000)

  // These integration tests require a real browser for the OAuth redirect.
  // Skipped to prevent browser windows from popping up during local test runs.
  // The component-level tests above (generatePkcePair, getValidAccessToken,
  // refreshAccessToken) cover the core PKCE logic. To run: remove .skip.
  it.skip('stores tokens via TokenStore after successful flow', async () => {
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
        redirectPort: authPort + 2,
      },
    }
    await client.executePkceFlow(mockConfig)
    const saved = store.load('test-oauth-store')
    expect(saved).not.toBeNull()
    expect(saved!.accessToken).toBe('mock-access-token-123')
  }, 15000)

  it('getValidAccessToken returns existing non-expired token', async () => {
    const store = new TokenStore(testDir)
    const config: McpServerConfig = {
      name: 'cached-srv',
      command: 'echo',
      args: [],
      auth: {
        type: 'oauth',
        authorizationUrl: '',
        tokenUrl: '',
        clientId: '',
      },
    }
    // 写入时必须绑上签发方 —— 绑定值由被测代码同一个函数算出，测试不另抄一份，
    // 否则两边可以各自漂移而测试照样绿。
    store.save('cached-srv', {
      accessToken: 'cached-token',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      boundTo: credentialBinding(config),
    })
    const client = new OAuthClient(store)
    const token = await client.getValidAccessToken('cached-srv', config)
    expect(token).toBe('cached-token')
  })

  it('getValidAccessToken refreshes expired token', async () => {
    const store = new TokenStore(testDir)
    const config: McpServerConfig = {
      name: 'expired-srv',
      command: 'echo',
      args: [],
      auth: {
        type: 'oauth',
        authorizationUrl: '',
        tokenUrl: `http://localhost:${authPort}/token`,
        clientId: '',
      },
    }
    store.save('expired-srv', {
      accessToken: 'old-token',
      refreshToken: 'refresh-me',
      expiresAt: new Date(Date.now() - 3600000).toISOString(),
      boundTo: credentialBinding(config),
    })
    const client = new OAuthClient(store)
    const token = await client.getValidAccessToken('expired-srv', config)
    expect(token).toBe('mock-access-token-123')
  }, 15000)

  describe('refreshAccessToken retry', () => {
    const config = {
      name: 'retry-srv',
      command: 'echo',
      args: [],
      auth: {
        type: 'oauth' as const,
        authorizationUrl: '',
        tokenUrl: 'http://localhost/token',
        clientId: '',
      },
    }

    it('retries the refresh request before falling back to PKCE', async () => {
      const store = new TokenStore(testDir)
      store.save('retry-srv', {
        accessToken: 'old-token',
        refreshToken: 'refresh-me',
        expiresAt: new Date(Date.now() - 3600000).toISOString(),
        boundTo: credentialBinding(config),
      })
      const client = new OAuthClient(store)

      let attempts = 0
      const fetchMock = vi.fn(async () => {
        attempts++
        if (attempts === 1) return new Response('oops', { status: 500 })
        return new Response(
          JSON.stringify({
            access_token: 'fresh-token',
            refresh_token: 'refresh-me',
            expires_in: 3600,
          }),
          { status: 200 },
        )
      })
      vi.stubGlobal('fetch', fetchMock)
      const pkceSpy = vi
        .spyOn(client, 'executePkceFlow')
        .mockRejectedValue(new Error('PKCE should not be called'))

      try {
        const token = await client.refreshAccessToken('retry-srv', config)
        expect(token).toBe('fresh-token')
        expect(attempts).toBe(2)
        expect(pkceSpy).not.toHaveBeenCalled()
      } finally {
        pkceSpy.mockRestore()
        vi.unstubAllGlobals()
      }
    })

    it('falls back to PKCE after refresh retries are exhausted', async () => {
      const store = new TokenStore(testDir)
      store.save('retry-srv', {
        accessToken: 'old-token',
        refreshToken: 'refresh-me',
        expiresAt: new Date(Date.now() - 3600000).toISOString(),
        boundTo: credentialBinding(config),
      })
      const client = new OAuthClient(store)

      let attempts = 0
      const fetchMock = vi.fn(async () => {
        attempts++
        return new Response('oops', { status: 500 })
      })
      vi.stubGlobal('fetch', fetchMock)
      const pkceSpy = vi.spyOn(client, 'executePkceFlow').mockResolvedValue({
        accessToken: 'pkce-token',
        refreshToken: 'pkce-refresh',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      })

      try {
        const token = await client.refreshAccessToken('retry-srv', config)
        expect(token).toBe('pkce-token')
        expect(attempts).toBe(2)
        expect(pkceSpy).toHaveBeenCalledTimes(1)
        expect(store.load('retry-srv')).toBeNull()
      } finally {
        pkceSpy.mockRestore()
        vi.unstubAllGlobals()
      }
    })
  })

  // 凭证只按服务名存，而服务名来自 `.mcp.json` —— 那是**从 cwd 读**的项目级配置，
  // clone 一个仓库就等于让它给你的 MCP 服务起名。「同名」因而推不出「同一签发方」，
  // 下面钉的就是这条推论：名字一样、端点不同 ⇒ 缓存里那份真凭证一个字节都不许出去。
  describe('凭证绑定：同名服务不等于同一签发方', () => {
    const mkConfig = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
      name: 'gh',
      url: 'https://mcp.example/rpc',
      auth: {
        type: 'oauth',
        authorizationUrl: 'https://auth.example/authorize',
        tokenUrl: 'https://auth.example/token',
        clientId: 'client-1',
      },
      ...over,
    })

    const saveBound = (store: TokenStore, config: McpServerConfig, extra = {}) => {
      store.save(config.name, {
        accessToken: 'cached-token',
        refreshToken: 'real-refresh-token',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        boundTo: credentialBinding(config),
        ...extra,
      })
    }

    it('绑定值覆盖四个字段，任一变化即不同（同一份配置则恒等）', () => {
      const base = credentialBinding(mkConfig())
      expect(credentialBinding(mkConfig())).toBe(base)
      const auth = mkConfig().auth!
      for (const over of [
        { url: 'https://evil.example/rpc' },
        { auth: { ...auth, tokenUrl: 'https://evil.example/token' } },
        { auth: { ...auth, authorizationUrl: 'https://evil.example/authorize' } },
        { auth: { ...auth, clientId: 'client-2' } },
      ] as Partial<McpServerConfig>[]) {
        expect(credentialBinding(mkConfig(over))).not.toBe(base)
      }
    })

    it('正控：签发方一致 ⇒ 用缓存凭证，不重新授权', async () => {
      // 少了这条，下面「端点变了就不给」只能证明这个函数对什么都不给。
      const store = new TokenStore(testDir)
      const config = mkConfig()
      saveBound(store, config)
      const client = new OAuthClient(store)
      const pkceSpy = vi
        .spyOn(client, 'executePkceFlow')
        .mockRejectedValue(new Error('不该走 PKCE'))
      try {
        expect(await client.getValidAccessToken('gh', config)).toBe('cached-token')
        expect(pkceSpy).not.toHaveBeenCalled()
      } finally {
        pkceSpy.mockRestore()
      }
    })

    it('资源端点被换掉 ⇒ 缓存凭证不给出（access token 不发往新主机）', async () => {
      const store = new TokenStore(testDir)
      const saved = mkConfig()
      saveBound(store, saved)
      const client = new OAuthClient(store)
      const pkceSpy = vi.spyOn(client, 'executePkceFlow').mockResolvedValue({
        accessToken: 'fresh-token',
        refreshToken: 'fresh-refresh',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      })
      try {
        const token = await client.getValidAccessToken(
          'gh',
          mkConfig({ url: 'https://evil.example/rpc' }),
        )
        expect(token).toBe('fresh-token')
        expect(token).not.toBe('cached-token')
        expect(pkceSpy).toHaveBeenCalledTimes(1)
      } finally {
        pkceSpy.mockRestore()
      }
    })

    it('令牌端点被换掉 ⇒ 拒绝刷新，且**在外发之前**就拒绝', async () => {
      const store = new TokenStore(testDir)
      const saved = mkConfig()
      saveBound(store, saved, { expiresAt: new Date(Date.now() - 3600000).toISOString() })
      const client = new OAuthClient(store)
      // 判据是「一次都没发出去」，所以两面都钉：报的是绑定错误（而不是网络错误），
      // 且 fetch 零调用 —— 后者才是 refresh token 没外流的直接证据。
      const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      try {
        await expect(
          client.refreshAccessToken(
            'gh',
            mkConfig({ auth: { ...saved.auth!, tokenUrl: 'http://127.0.0.1:1/token' } }),
          ),
        ).rejects.toThrow(/different endpoint/)
        expect(fetchMock).not.toHaveBeenCalled()
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('旧版本写下的凭证（没有 boundTo）一律视为不可用', async () => {
      // 这是认下的代价：无法核实签发方的凭证不能拿出去用 ⇒ 老用户多授权一次。
      const store = new TokenStore(testDir)
      store.save('gh', {
        accessToken: 'legacy-token',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      })
      const client = new OAuthClient(store)
      const pkceSpy = vi.spyOn(client, 'executePkceFlow').mockResolvedValue({
        accessToken: 'fresh-token',
        refreshToken: 'fresh-refresh',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      })
      try {
        expect(await client.getValidAccessToken('gh', mkConfig())).toBe('fresh-token')
        expect(pkceSpy).toHaveBeenCalledTimes(1)
      } finally {
        pkceSpy.mockRestore()
      }
    })
  })
})
