// apps/cli/src/daemon/server.ts
import type { Server, ServerWebSocket } from 'bun'
import type { DaemonDatabase } from './database'
import type { SessionManager } from './session-manager'
import type { DaemonGoal } from './types'
import { authMiddleware } from './auth'
import { PACKAGE_VERSION } from '../shared/package-info'
import { WorkerPool } from './worker-pool'
import type { SessionWorker } from './session-worker'
import type { ClientMessage } from './attach-protocol'
import { QueryEngine } from '../core/engine'
import { ContextManager } from '../core/context'
import { loadConfig } from '../config/loader'
import { bootstrapProviders } from '../providers/bootstrap'
import { createToolRegistry } from '../tools'
import { PermissionSystem } from '../core/permission'
import type { ProviderRegistry } from '../providers/registry'
import type { ToolDefinition } from '../shared/types'

interface ServerConfig {
  db: DaemonDatabase
  sm: SessionManager
  pool: WorkerPool
  token: string
  port: number
  hostname: string
}

interface WsData {
  sessionId: string
}

export function createServer(config: ServerConfig): Server<WsData> {
  const { db, sm, pool, token, port, hostname } = config

  const wsClients = new Map<string, Set<ServerWebSocket<WsData>>>()

  function broadcast(sessionId: string, data: unknown): void {
    const clients = wsClients.get(sessionId)
    if (!clients) return
    const msg = JSON.stringify(data)
    for (const ws of clients) {
      try {
        ws.send(msg)
      } catch {
        clients.delete(ws)
      }
    }
  }

  // ── Lazy engine & worker initialization ──────────────────────────────
  // Shared across all sessions — lazily initialized on first prompt.
  const engineCache = new Map<string, QueryEngine>()
  let sharedRegistry: ProviderRegistry | null = null
  let sharedTools: Map<string, ToolDefinition> | null = null
  const DEFAULT_MAX_TOKENS = 200_000

  function getOrCreateEngine(
    sessionId: string,
    cwd: string,
    provider: string,
    model: string,
  ): QueryEngine {
    const existing = engineCache.get(sessionId)
    if (existing) {
      // Ensure the active provider/model matches the session metadata
      existing.switchProvider(provider, model)
      return existing
    }

    // Lazy-init shared provider registry
    if (!sharedRegistry) {
      const config = loadConfig(cwd)
      sharedRegistry = bootstrapProviders(config.providers, provider, model)
    } else {
      sharedRegistry.switchProvider(provider, model)
    }

    // Lazy-init shared tool registry
    if (!sharedTools) {
      sharedTools = createToolRegistry()
    }

    // Create per-session context, restoring previous messages from DB
    const context = new ContextManager({
      maxTokens: DEFAULT_MAX_TOKENS,
      compactionThreshold: 0.9,
      contextWindow: DEFAULT_MAX_TOKENS,
    })

    const dbMessages = db.getMessages(sessionId, 10000)
    for (const msg of dbMessages) {
      try {
        const parsed = JSON.parse(msg.content)
        context.addMessage(parsed)
      } catch {
        context.addMessage({
          role: msg.role as 'user' | 'assistant' | 'system',
          content: msg.content,
        })
      }
    }

    const permission = new PermissionSystem('bypassPermissions')
    const engine = new QueryEngine(sharedRegistry, context, sharedTools, permission)
    engine.setSessionId(sessionId)
    engineCache.set(sessionId, engine)
    return engine
  }

  function getOrCreateWorker(
    sessionId: string,
    ws?: ServerWebSocket<WsData>,
  ): SessionWorker | null {
    try {
      const session = db.getSession(sessionId)
      if (!session || session.status === 'closed') return null

      const engine = getOrCreateEngine(
        sessionId,
        session.cwd,
        session.provider,
        session.model,
      )
      const worker = pool.createWorker(
        sessionId,
        engine,
        engine.getContext(),
        engine.getRegistry(),
      )

      // Register all connected WS clients with the worker so they
      // receive streamed output for this session.
      const clients = wsClients.get(sessionId)
      if (clients) {
        for (const client of clients) {
          worker.addClient(client)
        }
      }

      return worker
    } catch (err) {
      console.error(
        `Server: error creating worker for session ${sessionId}:`,
        err,
      )
      return null
    }
  }

  const server = Bun.serve<WsData>({
    port,
    hostname,
    async fetch(req, server) {
      // Auth check (skipped for localhost and health endpoint)
      const authError = authMiddleware(req, token)
      if (authError) return authError

      const url = new URL(req.url)
      const path = url.pathname
      const method = req.method

      // WebSocket upgrade
      const streamMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/stream$/)
      if (streamMatch && server.upgrade(req, { data: { sessionId: streamMatch[1]! } })) {
        return // upgraded
      }

      // Parse body helper
      async function jsonBody(): Promise<Record<string, unknown>> {
        try {
          return await req.json()
        } catch {
          return {}
        }
      }

      // ── Health ──────────────────────────────────────
      if (method === 'GET' && path === '/api/v1/health') {
        const stats = db.getStats()
        return Response.json({
          ok: true,
          pid: process.pid,
          port,
          uptime: process.uptime(),
          activeSessions: stats.activeSessions,
          totalSessions: stats.totalSessions,
          activeAgents: stats.activeAgents,
          version: PACKAGE_VERSION,
        })
      }

      // ── Stats ───────────────────────────────────────
      if (method === 'GET' && path === '/api/v1/stats') {
        const stats = db.getStats()
        return Response.json({ ok: true, data: stats })
      }

      // ── Sessions CRUD ───────────────────────────────
      if (method === 'POST' && path === '/api/v1/sessions') {
        const body = await jsonBody()
        const session = sm.createSession(
          (body.name as string) || 'unnamed',
          (body.cwd as string) || process.cwd(),
          (body.provider as string) || 'unknown',
          (body.model as string) || 'unknown',
        )
        return Response.json({ ok: true, data: { session } }, { status: 201 })
      }

      if (method === 'GET' && path === '/api/v1/sessions') {
        const status = url.searchParams.get('status') || undefined
        const sessions = sm.listSessions(status)
        return Response.json({ ok: true, data: { sessions } })
      }

      const sessionMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)$/)
      if (sessionMatch && method === 'GET') {
        const session = sm.getSession(sessionMatch[1]!)
        if (!session) {
          return Response.json({ ok: false, error: 'Session not found' }, { status: 404 })
        }
        return Response.json({ ok: true, data: { session } })
      }

      if (sessionMatch && method === 'DELETE') {
        const sessionId = sessionMatch[1]!
        // Stop worker (interrupt, persist, mark idle) before closing session
        pool.stopWorker(sessionId).catch((err: unknown) => {
          console.error(`Server: error stopping worker for session ${sessionId}:`, err)
        })
        // Remove engine from cache
        engineCache.delete(sessionId)
        sm.closeSession(sessionId)
        return Response.json({ ok: true })
      }

      // ── Session messages ────────────────────────────
      const messagesMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/messages$/)
      if (messagesMatch && method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '100')
        const messages = db.getMessages(messagesMatch[1]!, limit)
        return Response.json({ ok: true, data: { messages } })
      }

      // ── Prompt (Phase 2 — engine-backed) ──────────────
      const promptMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/prompt$/)
      if (promptMatch && method === 'POST') {
        const body = await jsonBody()
        const sessionId = promptMatch[1]!
        const prompt = body.prompt as string

        if (!prompt || typeof prompt !== 'string') {
          return Response.json(
            { ok: false, error: '"prompt" field is required' },
            { status: 400 },
          )
        }

        const session = db.getSession(sessionId)
        if (!session) {
          return Response.json(
            { ok: false, error: 'Session not found' },
            { status: 404 },
          )
        }

        if (session.status === 'closed') {
          return Response.json(
            { ok: false, error: 'Session is closed' },
            { status: 400 },
          )
        }

        // Reactivate idle sessions
        if (session.status === 'idle') {
          db.updateSessionStatus(sessionId, 'active')
        }

        // Get or create the worker (lazy engine initialization)
        const worker = getOrCreateWorker(sessionId)
        if (!worker) {
          return Response.json(
            { ok: false, error: 'Failed to initialize engine' },
            { status: 500 },
          )
        }

        // Fire and forget — respond immediately while processing
        // streams results to connected WebSocket clients.
        worker.processPrompt(prompt).catch((err: unknown) => {
          console.error(
            `Server: error processing prompt for session ${sessionId}:`,
            err,
          )
        })

        return Response.json(
          { ok: true, data: { sessionId, status: 'processing' } },
          { status: 202 },
        )
      }

      // ── Agents (stub — Phase 3) ─────────────────────
      if (method === 'GET' && path === '/api/v1/agents') {
        const sessionId = url.searchParams.get('session') || undefined
        const agents = db.listAgents(sessionId)
        return Response.json({ ok: true, data: { agents } })
      }

      // ── Goals (stub — Phase 4) ──────────────────────
      if (method === 'GET' && path === '/api/v1/goals') {
        const sessionId = url.searchParams.get('session')
        if (!sessionId)
          return Response.json({ ok: false, error: '?session= required' }, { status: 400 })
        const goals = db.getGoals(sessionId)
        return Response.json({ ok: true, data: { goals } })
      }

      if (method === 'POST' && path === '/api/v1/goals') {
        const body = await jsonBody()
        const now = new Date().toISOString()
        const goalId = db.createGoal({
          sessionId: body.sessionId as string,
          description: body.description as string,
          status: 'active',
          progress: (body.progress as DaemonGoal['progress']) || null,
          createdAt: now,
          updatedAt: now,
        })
        return Response.json({ ok: true, data: { id: goalId } }, { status: 201 })
      }

      // ── Schedules (stub — Phase 4) ──────────────────
      if (method === 'GET' && path === '/api/v1/schedules') {
        const sessionId = url.searchParams.get('session')
        if (!sessionId)
          return Response.json({ ok: false, error: '?session= required' }, { status: 400 })
        const schedules = db.getSchedules(sessionId)
        return Response.json({ ok: true, data: { schedules } })
      }

      return Response.json({ ok: false, error: 'Not found' }, { status: 404 })
    },

    websocket: {
      open(ws) {
        const sessionId = ws.data.sessionId
        if (!wsClients.has(sessionId)) {
          wsClients.set(sessionId, new Set())
        }
        wsClients.get(sessionId)!.add(ws)

        // Register with worker if already active so the new client
        // receives future streamed output for this session.
        const worker = pool.getWorker(sessionId)
        if (worker) {
          worker.addClient(ws)
        }
      },
      close(ws) {
        const sessionId = ws.data.sessionId
        const clients = wsClients.get(sessionId)
        if (clients) {
          clients.delete(ws)
          if (clients.size === 0) wsClients.delete(sessionId)
        }

        // Remove from worker's broadcast set
        const worker = pool.getWorker(sessionId)
        if (worker) {
          worker.removeClient(ws)
        }
      },
      message(ws, msg) {
        const sessionId = ws.data.sessionId

        let parsed: ClientMessage
        try {
          const raw = typeof msg === 'string' ? msg : new TextDecoder().decode(msg as Uint8Array)
          parsed = JSON.parse(raw) as ClientMessage
        } catch {
          // Ignore malformed messages
          return
        }

        if (!parsed || typeof parsed.type !== 'string') return

        switch (parsed.type) {
          case 'prompt': {
            if (!parsed.prompt || typeof parsed.prompt !== 'string') return

            const worker = getOrCreateWorker(sessionId, ws)
            if (!worker) return

            worker.processPrompt(parsed.prompt).catch((err: unknown) => {
              console.error(
                `Server: error processing WS prompt for session ${sessionId}:`,
                err,
              )
            })
            break
          }

          case 'interrupt': {
            const worker = pool.getWorker(sessionId)
            if (worker) {
              worker.interrupt()
            }
            break
          }

          default:
            // Unknown message type — silently ignored
            break
        }
      },
    },
  })

  return server
}
