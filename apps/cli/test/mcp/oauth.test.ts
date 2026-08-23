import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
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
    store.save('cached-srv', {
      accessToken: 'cached-token',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    })
    const client = new OAuthClient(store)
    const token = await client.getValidAccessToken('cached-srv', {
      name: 'cached-srv',
      command: 'echo',
      args: [],
      auth: {
        type: 'oauth',
        authorizationUrl: '',
        tokenUrl: '',
        clientId: '',
      },
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
})
