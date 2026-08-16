// apps/cli/src/daemon/index.ts — Daemon Lifecycle Management
//
// startDaemon()  initializes DB + SessionManager + HTTP server, writes PID/port files
// stopDaemon()   shuts down server, closes DB, cleans up PID/port files
// getDaemonStatus()  reads PID file and verifies process is alive
// getPort()      reads the last known port from disk

import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { homedir } from 'node:os'
import type { Server } from 'bun'
import { DaemonDatabase } from './database'
import { SessionManager } from './session-manager'
import { AgentManager } from './agent-manager'
import { MessageBus } from './message-bus'
import { GoalManager } from './goal-manager'
import { ScheduleManager } from './schedule-manager'
import { createServer } from './server'
import { WorkerPool } from './worker-pool'
import { loadOrCreateToken } from './auth'
import { RateLimiter } from './rate-limiter'
import { PACKAGE_VERSION } from '../shared/package-info'
import type { DaemonStatus } from './types'
import { logger } from './logger'

const HOME = homedir()
const MIPHAM_HOME = join(HOME, '.mipham')
const DB_PATH = join(MIPHAM_HOME, 'daemon.db')
const TOKEN_PATH = join(MIPHAM_HOME, 'daemon.token')
const PID_FILE = join(MIPHAM_HOME, 'daemon.pid')
const PORT_FILE = join(MIPHAM_HOME, 'daemon.port')

const DEFAULT_PORT = 45671

// The lifecycle only needs .stop() on the server; WebSocketData type is opaque here.
let activeServer: Server<unknown> | null = null
let activeDb: DaemonDatabase | null = null
let activePool: WorkerPool | null = null
let activeAgentManager: AgentManager | null = null
let activeMessageBus: MessageBus | null = null
let activeScheduleManager: ScheduleManager | null = null
let activeRateLimiter: RateLimiter | null = null

function getConfiguredPort(): number {
  if (process.env.MIPHAM_PORT) {
    const p = parseInt(process.env.MIPHAM_PORT, 10)
    if (!isNaN(p) && p > 0 && p < 65536) return p
  }
  return DEFAULT_PORT
}

function getConfiguredBind(): string {
  return process.env.MIPHAM_BIND || '127.0.0.1'
}

/**
 * Test whether a TCP port is available on the given hostname.
 */
function isPortAvailable(port: number, hostname: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer()
    server.once('error', () => {
      server.removeAllListeners()
      resolve(false)
    })
    server.once('listening', () => {
      server.close()
      resolve(true)
    })
    server.listen(port, hostname)
  })
}

/**
 * Find an available port starting from startPort, trying up to 10 ports.
 * Falls back to startPort if the range is exhausted (Bun.serve will throw if
 * the port is actually unavailable at bind time).
 */
async function findAvailablePort(startPort: number, hostname: string): Promise<number> {
  for (let port = startPort; port < startPort + 10; port++) {
    if (await isPortAvailable(port, hostname)) {
      return port
    }
  }
  // If all ports in range appear busy, return startPort and let Bun.serve fail
  // with a clear error rather than silently binding to an unexpected port.
  return startPort
}

/**
 * Read the last daemon port from the port file on disk.
 * Returns DEFAULT_PORT if the file doesn't exist or is unreadable.
 */
export function getPort(): number {
  if (existsSync(PORT_FILE)) {
    try {
      const raw = readFileSync(PORT_FILE, 'utf-8').trim()
      const port = parseInt(raw, 10)
      if (!isNaN(port) && port > 0 && port < 65536) return port
    } catch {
      // Corrupt port file — fall through to default
    }
  }
  return DEFAULT_PORT
}

/**
 * Start the Mipham Code daemon.
 *
 * 1. Ensures ~/.mipham exists (mode 0o700)
 * 2. Loads or creates the auth token
 * 3. Initializes the SQLite database and runs JSONL migration on first start
 * 4. Creates a SessionManager, AgentManager, and MessageBus
 * 5. Starts the HTTP server on an available port
 * 6. Writes PID and port files to disk
 *
 * Returns the port and token so the CLI can connect immediately.
 */
export async function startDaemon(): Promise<{ port: number; token: string }> {
  mkdirSync(MIPHAM_HOME, { recursive: true, mode: 0o700 })

  const hostname = getConfiguredBind()
  const port = await findAvailablePort(getConfiguredPort(), hostname)
  const token = loadOrCreateToken(TOKEN_PATH)

  // Initialize database
  const db = new DaemonDatabase(DB_PATH)
  db.init()
  activeDb = db

  // Run JSONL migration on first start (when no sessions exist yet)
  const sessionsCount = db.listSessions().length
  if (sessionsCount === 0) {
    const migrated = db.migrateFromJsonl()
    if (migrated > 0) {
      logger.info('migrated JSONL sessions to SQLite', { count: migrated })
    }
  }

  // Create session manager
  const sm = new SessionManager(db)

  // Create worker pool (idle timeout: 30 min default)
  const pool = new WorkerPool(db)
  activePool = pool

  // Create agent manager and message bus (Phase 3)
  const agentManager = new AgentManager(db)
  activeAgentManager = agentManager
  const messageBus = new MessageBus()
  activeMessageBus = messageBus

  // Create goal manager and schedule manager (Phase 4)
  const goalManager = new GoalManager(db)
  const scheduleManager = new ScheduleManager(db, pool)
  activeScheduleManager = scheduleManager

  // Start the schedule checking interval (checks every 60s)
  scheduleManager.start()

  // Create rate limiter (Phase 5 — 100 req/min per client IP)
  const rateLimiter = new RateLimiter(100, 60_000)
  activeRateLimiter = rateLimiter

  // Start HTTP server (Bun.serve starts listening immediately)
  const server = createServer({
    db,
    sm,
    pool,
    token,
    tokenPath: TOKEN_PATH,
    port,
    hostname,
    agentManager,
    messageBus,
    goalManager,
    scheduleManager,
    rateLimiter,
  })
  activeServer = server

  // Write PID and port files
  writeFileSync(PID_FILE, String(process.pid))
  writeFileSync(PORT_FILE, String(port))

  return { port, token }
}

/**
 * Stop the Mipham Code daemon.
 *
 * By default, refuses to stop if there are active sessions.
 * Pass `force: true` to bypass this check (active sessions will be
 * disconnected when the server stops).
 *
 * Cleans up PID and port files regardless of success/failure.
 */
export async function stopDaemon(force: boolean = false): Promise<void> {
  // Guard: check for active sessions unless forced
  if (!force && activeDb) {
    const stats = activeDb.getStats()
    if (stats.activeSessions > 0) {
      throw new Error(
        `Cannot stop: ${stats.activeSessions} active session(s). Use --force to stop anyway.`,
      )
    }
  }

  // Stop HTTP server (disconnects WebSocket clients)
  if (activeServer) {
    activeServer.stop()
    activeServer = null
  }

  // Stop worker pool (interrupts all in-progress prompts, persists state)
  if (activePool) {
    await activePool.stopAll()
    activePool = null
  }

  // Stop schedule manager interval (Phase 4)
  if (activeScheduleManager) {
    activeScheduleManager.stop()
    activeScheduleManager = null
  }

  // Stop rate limiter cleanup interval (Phase 5)
  if (activeRateLimiter) {
    activeRateLimiter.stop()
    activeRateLimiter = null
  }

  // Clean up agent manager and message bus (Phase 3)
  activeAgentManager = null
  activeMessageBus = null

  // Close database (commits any pending WAL)
  if (activeDb) {
    activeDb.close()
    activeDb = null
  }

  // Clean up PID/port files — best-effort, ignore errors
  try {
    unlinkSync(PID_FILE)
  } catch {
    // File may not exist
  }
  try {
    unlinkSync(PORT_FILE)
  } catch {
    // File may not exist
  }
}

/**
 * Check whether a daemon process is currently running.
 *
 * Returns DaemonStatus with basic info if the daemon is alive (PID exists
 * and process is reachable), or null if no daemon is running.
 *
 * Fields like uptime, activeSessions, etc. are filled with 0 when queried
 * from an external process. For real-time stats, call GET /api/v1/health
 * directly against the running daemon.
 */
export function getDaemonStatus(): DaemonStatus | null {
  if (!existsSync(PID_FILE)) return null

  let pid = 0
  try {
    const raw = readFileSync(PID_FILE, 'utf-8').trim()
    pid = parseInt(raw, 10)
    if (isNaN(pid) || pid <= 0) return null
  } catch {
    return null
  }

  // Signal 0 checks process existence without actually sending a signal
  try {
    process.kill(pid, 0)
  } catch {
    // Stale PID file — process is gone, clean up
    try {
      unlinkSync(PID_FILE)
    } catch {
      // Best effort
    }
    try {
      unlinkSync(PORT_FILE)
    } catch {
      // Best effort
    }
    return null
  }

  const port = getPort()

  return {
    pid,
    port,
    uptime: 0, // Call GET /api/v1/health for real-time stats
    activeSessions: 0,
    totalSessions: 0,
    activeAgents: 0,
    version: PACKAGE_VERSION,
  }
}
