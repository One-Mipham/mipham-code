// apps/cli/src/daemon/server.ts
import type { Server, ServerWebSocket } from 'bun'
import type { DaemonDatabase } from './database'
import type { SessionManager } from './session-manager'
import type { DaemonGoal } from './types'
import { authMiddleware } from './auth'

interface ServerConfig {
  db: DaemonDatabase
  sm: SessionManager
  token: string
  port: number
  hostname: string
}

interface WsData {
  sessionId: string
}

export function createServer(config: ServerConfig): Server<WsData> {
  const { db, sm, token, port, hostname } = config

  const wsClients = new Map<string, Set<ServerWebSocket<WsData>>>()

  function broadcast(sessionId: string, data: unknown): void {
    const clients = wsClients.get(sessionId)
    if (!clients) return
    const msg = JSON.stringify(data)
    for (const ws of clients) {
      try { ws.send(msg) } catch { clients.delete(ws) }
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
        try { return await req.json() } catch { return {} }
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
          version: '0.31.1',
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
        sm.closeSession(sessionMatch[1]!)
        return Response.json({ ok: true })
      }

      // ── Session messages ────────────────────────────
      const messagesMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/messages$/)
      if (messagesMatch && method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '100')
        const messages = db.getMessages(messagesMatch[1]!, limit)
        return Response.json({ ok: true, data: { messages } })
      }

      // ── Prompt (stub — Phase 2) ─────────────────────
      const promptMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/prompt$/)
      if (promptMatch && method === 'POST') {
        const body = await jsonBody()
        const sessionId = promptMatch[1]!
        const prompt = body.prompt as string

        // Phase 1 stub: save the user message, return placeholder
        db.saveMessage(sessionId, 'user', JSON.stringify({ role: 'user', content: prompt }))

        // Broadcast via WebSocket for real-time streaming clients
        broadcast(sessionId, { type: 'prompt_received', sessionId, prompt })

        return Response.json({
          ok: true,
          data: {
            sessionId,
            message: 'Prompt received. Full execution coming in Phase 2.',
          },
        })
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
        if (!sessionId) return Response.json({ ok: false, error: '?session= required' }, { status: 400 })
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
          progress: body.progress as DaemonGoal['progress'] || null,
          createdAt: now,
          updatedAt: now,
        })
        return Response.json({ ok: true, data: { id: goalId } }, { status: 201 })
      }

      // ── Schedules (stub — Phase 4) ──────────────────
      if (method === 'GET' && path === '/api/v1/schedules') {
        const sessionId = url.searchParams.get('session')
        if (!sessionId) return Response.json({ ok: false, error: '?session= required' }, { status: 400 })
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
      },
      close(ws) {
        const sessionId = ws.data.sessionId
        const clients = wsClients.get(sessionId)
        if (clients) {
          clients.delete(ws)
          if (clients.size === 0) wsClients.delete(sessionId)
        }
      },
      message() {
        // Client-to-server WS messages handled in Phase 2
      },
    },
  })

  return server
}
