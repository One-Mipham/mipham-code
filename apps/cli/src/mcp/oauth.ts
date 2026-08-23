import { randomBytes, createHash } from 'node:crypto'
import { exec } from 'node:child_process'
import { createServer, Server } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { McpServerConfig } from '../shared/types'
import { TokenStore } from './token-store'
import { fetchWithRetry } from '../providers/fetch-utils'
import { createT } from '../i18n-core/t'
import enUS from '../i18n-core/locales/en-US.json'
import zhCN from '../i18n-core/locales/zh-CN.json'
import type { TranslationMap } from '../i18n-core/types'

const bundles: Record<string, TranslationMap> = {
  'en-US': enUS as TranslationMap,
  'zh-CN': zhCN as TranslationMap,
}
const t = createT(bundles['en-US'] || (enUS as TranslationMap), enUS as TranslationMap)

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

  generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = base64url(randomBytes(64))
    const hash = createHash('sha256').update(codeVerifier).digest()
    const codeChallenge = base64url(hash)
    return { codeVerifier, codeChallenge }
  }

  async executePkceFlow(config: McpServerConfig): Promise<TokenResponse> {
    const auth = config.auth!
    const port = auth.redirectPort || 19876
    const { codeVerifier, codeChallenge } = this.generatePkcePair()
    const state = base64url(randomBytes(32))

    const code = await new Promise<string>((resolve, reject) => {
      const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url || '/', `http://localhost:${port}`)
        if (url.pathname === '/callback') {
          const receivedCode = url.searchParams.get('code')
          const receivedState = url.searchParams.get('state')
          if (receivedState !== state) {
            res.writeHead(400)
            res.end('State mismatch')
            reject(new Error(t('errors.oauth_state_mismatch')))
            return
          }
          if (!receivedCode) {
            res.writeHead(400)
            res.end('No code received')
            reject(new Error(t('errors.oauth_no_code')))
            return
          }
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(
            `<html><body><h1>${t('system.oauth.authenticated')}</h1><p>${t('system.oauth.close_window')}</p></body></html>`,
          )
          server.close()
          resolve(receivedCode)
        }
      })
      server.listen(port, '127.0.0.1', () => {
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
        const cmd =
          process.platform === 'darwin'
            ? `open "${authUrl.toString()}"`
            : process.platform === 'win32'
              ? `start "" "${authUrl.toString()}"`
              : `xdg-open "${authUrl.toString()}"`
        exec(cmd, () => {
          /* fire-and-forget */
        })
      })
      setTimeout(() => {
        server.close()
        reject(new Error(t('errors.oauth_timeout')))
      }, 300_000)
    })

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

    this.store.save(config.name, result)
    return result
  }

  async getValidAccessToken(serverName: string, config: McpServerConfig): Promise<string> {
    const saved = this.store.load(serverName)
    if (saved && new Date(saved.expiresAt).getTime() > Date.now() + 60000) {
      return saved.accessToken
    }
    if (saved?.refreshToken) {
      return this.refreshAccessToken(serverName, config)
    }
    const fresh = await this.executePkceFlow(config)
    return fresh.accessToken
  }

  async refreshAccessToken(serverName: string, config: McpServerConfig): Promise<string> {
    const saved = this.store.load(serverName)
    if (!saved?.refreshToken) {
      throw new Error(`No refresh token available for "${serverName}"`)
    }
    const auth = config.auth!
    // A single failed refresh is often a transient network/server error, not a
    // real revocation — retry (5xx/429/network) before forcing PKCE. 4xx (e.g.
    // invalid_grant) is a genuine revocation and falls through to PKCE directly.
    const response = await fetchWithRetry(
      auth.tokenUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: saved.refreshToken,
          client_id: auth.clientId,
        }).toString(),
      },
      { maxRetries: 1, baseDelay: 300 },
    )
    if (!response.ok) {
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
