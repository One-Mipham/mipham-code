// apps/cli/test/daemon/server.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from '../../src/daemon/server'
import { DaemonDatabase } from '../../src/daemon/database'
import { SessionManager } from '../../src/daemon/session-manager'
import { AgentManager } from '../../src/daemon/agent-manager'
import { GoalManager } from '../../src/daemon/goal-manager'
import { ScheduleManager } from '../../src/daemon/schedule-manager'
import { WorkerPool } from '../../src/daemon/worker-pool'
import { generateToken } from '../../src/daemon/auth'
import { RateLimiter } from '../../src/daemon/rate-limiter'
import { unlinkSync } from 'node:fs'
import { Socket } from 'node:net'
import type { Server } from 'bun'

const TEST_DB = '/tmp/mipham-server-test.db'
const TEST_PORT = 45999
const TEST_TOKEN = generateToken()

function cleanDb() {
  try {
    unlinkSync(TEST_DB)
  } catch {}
  try {
    unlinkSync(TEST_DB + '-wal')
  } catch {}
  try {
    unlinkSync(TEST_DB + '-shm')
  } catch {}
}

function apiUrl(path: string): string {
  return `http://127.0.0.1:${TEST_PORT}${path}`
}

async function fetchApi(path: string, options?: RequestInit) {
  return fetch(apiUrl(path), {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TEST_TOKEN}`,
      ...(options?.headers || {}),
    },
  })
}

/** Send a raw HTTP request (WS handshake or plain GET) and return the status code. */
function rawStatus(path: string, extraHeaders: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new Socket()
    let response = ''
    socket.on('data', (data) => {
      response += data.toString()
      const match = response.match(/HTTP\/1\.\d (\d+)/)
      if (match) {
        resolve(parseInt(match[1]!, 10))
        socket.destroy()
      }
    })
    socket.on('error', reject)
    socket.setTimeout(5000, () => {
      socket.destroy()
      reject(new Error('Socket timeout'))
    })
    socket.connect(TEST_PORT, '127.0.0.1', () => {
      const headers = Object.entries(extraHeaders)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join('')
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${TEST_PORT}\r\n${headers}\r\n`)
    })
  })
}

const WS_HANDSHAKE = {
  Upgrade: 'websocket',
  Connection: 'Upgrade',
  'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
  'Sec-WebSocket-Version': '13',
}

describe('Daemon HTTP Server', () => {
  let server: Server<any>
  let db: DaemonDatabase
  let sm: SessionManager
  let pool: WorkerPool
  let agentManager: AgentManager

  beforeAll(async () => {
    cleanDb()
    db = new DaemonDatabase(TEST_DB)
    db.init()
    sm = new SessionManager(db)
    agentManager = new AgentManager(db)
    pool = new WorkerPool(db)
    server = createServer({
      db,
      sm,
      pool,
      token: TEST_TOKEN,
      tokenPath: '/tmp/mipham-test.token',
      port: TEST_PORT,
      hostname: '127.0.0.1',
      agentManager,
      goalManager: new GoalManager(db),
      scheduleManager: new ScheduleManager(db, pool),
      rateLimiter: new RateLimiter(1000, 60_000),
    })
    // Wait for the server to start listening (Node.js http.listen is async)
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(apiUrl('/api/v1/health'))
        break
      } catch {
        await new Promise((r) => setTimeout(r, 20))
      }
    }
  })

  afterAll(async () => {
    await server.stop()
    db.close()
    cleanDb()
  })

  it('serves in production mode, not Bun development mode', () => {
    // With `development` left at Bun's default, an exception thrown before the
    // auth check is rendered as Bun's development error page — whose body
    // carries the failing source frame and the absolute install path — to an
    // unauthenticated peer. Asserting the flag is all this suite can do: the
    // mock replaces Bun.serve with a Node http server, so the real error page
    // never exists here. The behavioural claim ("the 500 body contains no
    // source") is only verifiable against real Bun.
    expect(server.development).toBe(false)
  })

  it('GET /api/v1/health returns ok', async () => {
    const res = await fetch(apiUrl('/api/v1/health'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.pid).toBeGreaterThan(0)
    expect(body.port).toBe(TEST_PORT)
  })

  it('POST /api/v1/sessions creates a session', async () => {
    const res = await fetchApi('/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({
        name: 'api-test',
        cwd: process.cwd(),
        provider: 'anthropic',
        model: 'claude-sonnet-5',
      }),
    })
    const body = await res.json()
    expect(res.status).toBe(201)
    expect(body.ok).toBe(true)
    expect(body.data.session.name).toBe('api-test')
    expect(body.data.session.status).toBe('active')
  })

  it('GET /api/v1/sessions lists sessions', async () => {
    const res = await fetchApi('/api/v1/sessions')
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.data.sessions)).toBe(true)
  })

  it('DELETE /api/v1/sessions/:id closes a session', async () => {
    // Create first
    const create = await fetchApi('/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({
        name: 'to-delete',
        cwd: process.cwd(),
        provider: 'openai',
        model: 'gpt-5',
      }),
    })
    const { session } = (await create.json()).data

    // Close it
    const del = await fetchApi(`/api/v1/sessions/${session.id}`, { method: 'DELETE' })
    const delBody = await del.json()
    expect(del.status).toBe(200)
    expect(delBody.ok).toBe(true)

    // Verify closed
    const get = await fetchApi(`/api/v1/sessions/${session.id}`)
    const getBody = await get.json()
    expect(getBody.data.session.status).toBe('closed')
  })

  it('trusts loopback socket IP, ignoring a spoofed Host header', async () => {
    // Connect from loopback (127.0.0.1) but spoof the Host header to look remote.
    // Auth is based on the socket IP (requestIP), not the Host header, so this
    // is allowed — the spoofed Host must NOT trigger an auth challenge.
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new Socket()
      let response = ''
      socket.on('data', (data) => {
        response += data.toString()
        const match = response.match(/HTTP\/1\.\d (\d+)/)
        if (match) {
          resolve(parseInt(match[1]!, 10))
          socket.destroy()
        }
      })
      socket.on('error', reject)
      socket.setTimeout(5000, () => {
        socket.destroy()
        reject(new Error('Socket timeout'))
      })
      socket.connect(TEST_PORT, '127.0.0.1', () => {
        socket.write(
          'GET /api/v1/sessions HTTP/1.1\r\n' +
            'Host: external.example.com\r\n' +
            'Content-Type: application/json\r\n' +
            'Connection: close\r\n' +
            '\r\n',
        )
      })
    })
    expect(status).toBe(200)
  })

  // ── Origin gate: a foreign web page must not drive the daemon ────────
  // CORS headers only stop a page from *reading* a reply; they do not stop it
  // from *sending* the request. Origin is what separates a page from the CLI,
  // which sends none — so absent Origin passes and any other Origin is refused.

  it('rejects a state-changing request carrying a non-allow-listed Origin', async () => {
    const before = (await (await fetchApi('/api/v1/sessions')).json()).data.sessions.length
    const res = await fetchApi('/api/v1/sessions', {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
      body: JSON.stringify({
        name: 'cross-origin',
        cwd: process.cwd(),
        provider: 'anthropic',
        model: 'claude-sonnet-5',
      }),
    })
    expect(res.status).toBe(403)
    const after = (await (await fetchApi('/api/v1/sessions')).json()).data.sessions.length
    expect(after).toBe(before) // no session was created
  })

  it('allows a request with no Origin (CLI / curl)', async () => {
    const res = await fetchApi('/api/v1/sessions')
    expect(res.status).toBe(200)
  })

  it('rejects a WebSocket upgrade from a non-allow-listed Origin', async () => {
    const status = await rawStatus('/api/v1/sessions/whatever/stream', {
      ...WS_HANDSHAKE,
      Origin: 'https://evil.example',
    })
    expect(status).toBe(403)
  })

  it('lets a WebSocket upgrade with no Origin past the Origin gate', async () => {
    // The test mock's upgrade() always returns false, so the request falls
    // through to 404. What matters is that the Origin gate did NOT stop it.
    const status = await rawStatus('/api/v1/sessions/whatever/stream', WS_HANDSHAKE)
    expect(status).toBe(404)
  })

  // ── cwd guard: the session cwd is the read containment boundary ──────

  it('rejects a session cwd outside the trusted workspaces and the daemon root', async () => {
    const res = await fetchApi('/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({
        name: 'escape',
        cwd: '/tmp/not-a-trusted-workspace',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
      }),
    })
    expect(res.status).toBe(403)
  })

  it('rejects traversal that climbs out of the daemon root', async () => {
    const res = await fetchApi('/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({
        name: 'escape-2',
        cwd: `${process.cwd()}/../../../../..`,
        provider: 'anthropic',
        model: 'claude-sonnet-5',
      }),
    })
    expect(res.status).toBe(403)
  })

  // ── Remote peer: the auth branch that loopback short-circuits ────────
  // Every other case in this file arrives as 127.0.0.1, which `authMiddleware`
  // accepts before it ever reads the Authorization header. Those tests were
  // green even while `verifyToken` threw for *every* caller — the daemon's auth
  // path had no end-to-end coverage at all.

  /** Run `fn` with the socket peer reported as `address` instead of loopback. */
  async function asRemotePeer<T>(address: string, fn: () => Promise<T>): Promise<T> {
    ;(globalThis as Record<string, unknown>).__miphamTestPeer = address
    try {
      return await fn()
    } finally {
      delete (globalThis as Record<string, unknown>).__miphamTestPeer
    }
  }

  it('rejects a remote request with no Authorization header', async () => {
    const status = await asRemotePeer('203.0.113.7', async () => {
      const res = await fetch(apiUrl('/api/v1/sessions'))
      return res.status
    })
    expect(status).toBe(401)
  })

  it('rejects a remote request with a wrong token', async () => {
    const status = await asRemotePeer('203.0.113.7', async () => {
      const res = await fetch(apiUrl('/api/v1/sessions'), {
        headers: { Authorization: 'Bearer not-the-token' },
      })
      return res.status
    })
    expect(status).toBe(403)
  })

  it('accepts a remote request carrying the valid token', async () => {
    const status = await asRemotePeer('203.0.113.7', async () => {
      const res = await fetchApi('/api/v1/sessions')
      return res.status
    })
    expect(status).toBe(200)
  })

  /**
   * `POST /api/v1/agents/:id/message` 曾经回 **202 + `{ok:true}`** ——
   * 一张它兑现不了的收条。
   *
   * 它写进的是 `daemon/message-bus.ts` 这份**平行实现**，而全仓**没有任何地方 poll 它**：
   * daemon 侧根本不存在 agent 执行循环（`AgentManager` 纯持久化，`src/daemon/*.ts` 里
   * `SubAgent`/`spawn` 零命中），所以「把话交给 agent」这件事在进程内**无从发生**。
   * 而真正在用的那条总线是 `src/agent/message-bus.ts`，它的投递方（子代理 / workflow）
   * 用的是 `bg-…` 那套 id，与 `agent-<uuid8>` **不同一个 id 空间** ⇒ 就算改投那份也找不到人。
   *
   * 202 在这里是有害的：调用方据此认为话已送达，于是**不再重试、也不再报错**。
   */
  it('承认送不到：501 + 说清原因，而不是 202 的收条', async () => {
    const session = sm.createSession('msg-target', process.cwd(), 'test', 'test')
    const agent = agentManager.createAgent(session.id, 'general', 'a target agent')

    const res = await fetchApi(`/api/v1/agents/${agent.id}/message`, {
      method: 'POST',
      body: JSON.stringify({ content: 'hello' }),
    })

    expect(res.status, '202 是「已受理」的意思，而这里没有任何东西会去受理').toBe(501)

    const body = (await res.json()) as { ok: boolean; error?: string }
    expect(body.ok).toBe(false)
    // 光说「不支持」不够 —— 得让调用方知道该改用什么，否则它只会反复重试。
    expect(body.error ?? '').toMatch(/session|prompt/i)
  })

  it('参数校验照旧：缺 content 仍是 400、agent 不存在仍是 404', async () => {
    const session = sm.createSession('msg-target-2', process.cwd(), 'test', 'test')
    const agent = agentManager.createAgent(session.id, 'general', 'another agent')

    const noContent = await fetchApi(`/api/v1/agents/${agent.id}/message`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(noContent.status).toBe(400)

    const missing = await fetchApi('/api/v1/agents/agent-nope/message', {
      method: 'POST',
      body: JSON.stringify({ content: 'hello' }),
    })
    expect(missing.status).toBe(404)
  })
})
