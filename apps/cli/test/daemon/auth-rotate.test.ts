// apps/cli/test/daemon/auth-rotate.test.ts
//
// Rotation is destructive to the server's own token, so it gets its own server
// instance rather than mutating the shared one in server.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from '../../src/daemon/server'
import { DaemonDatabase } from '../../src/daemon/database'
import { SessionManager } from '../../src/daemon/session-manager'
import { AgentManager } from '../../src/daemon/agent-manager'
import { GoalManager } from '../../src/daemon/goal-manager'
import { ScheduleManager } from '../../src/daemon/schedule-manager'
import { WorkerPool } from '../../src/daemon/worker-pool'
import { generateToken, listTokens, rotateToken } from '../../src/daemon/auth'
import { RateLimiter } from '../../src/daemon/rate-limiter'
import { unlinkSync } from 'node:fs'
import type { Server } from 'bun'

const TEST_DB = '/tmp/mipham-auth-rotate-test.db'
const TEST_TOKEN_PATH = '/tmp/mipham-auth-rotate.token'
const TEST_PORT = 46017

function cleanDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(TEST_DB + suffix)
    } catch {}
  }
}

describe('POST /api/v1/auth/rotate', () => {
  let server: Server<any>
  let db: DaemonDatabase
  const ORIGINAL_TOKEN = generateToken()

  beforeAll(async () => {
    cleanDb()
    try {
      unlinkSync(TEST_TOKEN_PATH)
    } catch {}
    db = new DaemonDatabase(TEST_DB)
    db.init()
    const sm = new SessionManager(db)
    const pool = new WorkerPool(db)
    server = createServer({
      db,
      sm,
      pool,
      token: ORIGINAL_TOKEN,
      tokenPath: TEST_TOKEN_PATH,
      port: TEST_PORT,
      hostname: '127.0.0.1',
      agentManager: new AgentManager(db),
      goalManager: new GoalManager(db),
      scheduleManager: new ScheduleManager(db, pool),
      rateLimiter: new RateLimiter(1000, 60_000),
    })
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`http://127.0.0.1:${TEST_PORT}/api/v1/health`)
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
    try {
      unlinkSync(TEST_TOKEN_PATH)
    } catch {}
  })

  // Runs with a non-loopback peer, because `authMiddleware` accepts loopback
  // before it ever compares a token — a rotation bug is invisible from 127.0.0.1.
  it('invalidates the old token and accepts the new one', async () => {
    ;(globalThis as Record<string, unknown>).__miphamTestPeer = '203.0.113.7'
    try {
      const sessions = (token: string) =>
        fetch(`http://127.0.0.1:${TEST_PORT}/api/v1/sessions`, {
          headers: { Authorization: `Bearer ${token}` },
        })

      expect((await sessions(ORIGINAL_TOKEN)).status).toBe(200)

      const rotate = await fetch(`http://127.0.0.1:${TEST_PORT}/api/v1/auth/rotate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ORIGINAL_TOKEN}` },
      })
      expect(rotate.status).toBe(200)
      const newToken = (await rotate.json()).data.token
      expect(typeof newToken).toBe('string')
      expect(newToken).not.toBe(ORIGINAL_TOKEN)

      // The API just handed this token out; the daemon must honour it, and must
      // have stopped honouring the one it replaced.
      expect((await sessions(newToken)).status).toBe(200)
      expect((await sessions(ORIGINAL_TOKEN)).status).toBe(403)
    } finally {
      delete (globalThis as Record<string, unknown>).__miphamTestPeer
    }
  })
})

// The CLI path (`mipham token rotate` in bin/mipham.ts) is NOT the endpoint
// above: it runs in a separate process and only rewrites the token file, so a
// running daemon never learns about it. The CLI's closing message tells the
// user exactly that ("still ACCEPTS the old token until it restarts"). That
// message is a behavioural claim, so this pins the behaviour — otherwise it
// drifts into a lie the day someone re-points the CLI at the API.
describe('file-level rotation (the CLI path) does not reach a running daemon', () => {
  const CLI_TOKEN_PATH = '/tmp/mipham-auth-rotate-cli.token'
  const CLI_DB = '/tmp/mipham-auth-rotate-cli.db'
  const CLI_PORT = 46018
  let server: Server<any>
  let db: DaemonDatabase
  const FILE_TOKEN = generateToken()

  beforeAll(async () => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(CLI_DB + suffix)
      } catch {}
    }
    try {
      unlinkSync(CLI_TOKEN_PATH)
    } catch {}
    db = new DaemonDatabase(CLI_DB)
    db.init()
    const pool = new WorkerPool(db)
    server = createServer({
      db,
      sm: new SessionManager(db),
      pool,
      token: FILE_TOKEN,
      tokenPath: CLI_TOKEN_PATH,
      port: CLI_PORT,
      hostname: '127.0.0.1',
      agentManager: new AgentManager(db),
      goalManager: new GoalManager(db),
      scheduleManager: new ScheduleManager(db, pool),
      rateLimiter: new RateLimiter(1000, 60_000),
    })
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`http://127.0.0.1:${CLI_PORT}/api/v1/health`)
        break
      } catch {
        await new Promise((r) => setTimeout(r, 20))
      }
    }
  })

  afterAll(async () => {
    await server.stop()
    db.close()
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(CLI_DB + suffix)
      } catch {}
    }
    try {
      unlinkSync(CLI_TOKEN_PATH)
    } catch {}
  })

  it('leaves the running daemon honouring the token it loaded at startup', async () => {
    ;(globalThis as Record<string, unknown>).__miphamTestPeer = '203.0.113.7'
    try {
      const sessions = (token: string) =>
        fetch(`http://127.0.0.1:${CLI_PORT}/api/v1/sessions`, {
          headers: { Authorization: `Bearer ${token}` },
        })

      expect((await sessions(FILE_TOKEN)).status).toBe(200)

      // Exactly what `mipham token rotate` does — rewrite the file, touch nothing else.
      const newToken = rotateToken(CLI_TOKEN_PATH)
      expect(newToken).not.toBe(FILE_TOKEN)
      expect(listTokens(CLI_TOKEN_PATH)).toEqual([newToken]) // on disk the old one is gone

      // …and yet the daemon that is already running still honours it. That is the
      // whole point of the CLI's warning, and why it names `daemon restart`.
      expect((await sessions(FILE_TOKEN)).status).toBe(200)

      // The flip side, and what makes this test discriminating: the daemon does
      // not pick the new token up either. If it ever starts re-reading the file,
      // this flips to 200 and the assertion above flips to 403 — the test fails,
      // which is exactly what should happen to the CLI's warning that day.
      expect((await sessions(newToken)).status).toBe(403)
    } finally {
      delete (globalThis as Record<string, unknown>).__miphamTestPeer
    }
  })
})
