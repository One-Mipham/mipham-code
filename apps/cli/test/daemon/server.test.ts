// apps/cli/test/daemon/server.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from '../../src/daemon/server'
import { DaemonDatabase } from '../../src/daemon/database'
import { SessionManager } from '../../src/daemon/session-manager'
import { WorkerPool } from '../../src/daemon/worker-pool'
import { generateToken } from '../../src/daemon/auth'
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

describe('Daemon HTTP Server', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: Server<any>
  let db: DaemonDatabase
  let sm: SessionManager
  let pool: WorkerPool

  beforeAll(async () => {
    cleanDb()
    db = new DaemonDatabase(TEST_DB)
    db.init()
    sm = new SessionManager(db)
    pool = new WorkerPool(db)
    server = createServer({
      db,
      sm,
      pool,
      token: TEST_TOKEN,
      port: TEST_PORT,
      hostname: '127.0.0.1',
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

  afterAll(() => {
    server.stop()
    db.close()
    cleanDb()
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
        cwd: '/tmp/test',
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
      body: JSON.stringify({ name: 'to-delete', cwd: '/tmp', provider: 'openai', model: 'gpt-5' }),
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

  it('rejects requests without auth when not localhost', async () => {
    // Use a raw TCP socket to bypass fetch's restriction on the Host header.
    // fetch() always sets Host based on the URL, which would be 127.0.0.1
    // and trigger the localhost auth bypass.
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
    expect(status).toBe(401)
  })
})
