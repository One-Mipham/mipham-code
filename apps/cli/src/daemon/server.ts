// apps/cli/src/daemon/server.ts
import type { Server, ServerWebSocket } from 'bun'
import type { DaemonDatabase } from './database'
import type { SessionManager } from './session-manager'
import type { AgentManager } from './agent-manager'
import type { MessageBus } from './message-bus'
import type { DaemonGoal, AgentKind } from './types'
import type { GoalManager } from './goal-manager'
import type { ScheduleManager } from './schedule-manager'
import { authMiddleware, rotateToken } from './auth'
import { RateLimiter } from './rate-limiter'
import { corsMiddleware, addCorsHeaders } from './cors'
import { PACKAGE_VERSION } from '../shared/package-info'
import { WorkerPool } from './worker-pool'
import { logger } from './logger'
import type { SessionWorker } from './session-worker'
import type { ClientMessage } from './attach-protocol'
import { QueryEngine } from '../core/engine'
import { ContextManager } from '../core/context'
import { loadConfig } from '../config/loader'
import { bootstrapProviders } from '../providers/bootstrap'
import { createToolRegistry } from '../tools'
import { PermissionSystem } from '../core/permission'
import type { ProviderRegistry } from '../providers/registry'
import type { ToolDefinition, PermissionMode, PermissionRestrictions } from '../shared/types'
import { createFeishuAdapter } from './feishu/adapter.js'
import { createFeishuApi } from './feishu/api.js'
import type { FeishuConfig } from './feishu/types.js'
import { createTelegramAdapter } from './telegram/adapter.js'
import { createTelegramApi } from './telegram/api.js'
import type { TelegramConfig } from './telegram/types.js'
import { startHeartbeat } from './heartbeat'

interface ServerConfig {
  db: DaemonDatabase
  sm: SessionManager
  pool: WorkerPool
  token: string
  tokenPath: string
  port: number
  hostname: string
  agentManager: AgentManager
  messageBus: MessageBus
  goalManager: GoalManager
  scheduleManager: ScheduleManager
  rateLimiter: RateLimiter
  feishu?: { config: FeishuConfig; cwd: string; provider: string; model: string }
  telegram?: { config: TelegramConfig; cwd: string; provider: string; model: string }
}

interface WsData {
  sessionId: string
}

const DAEMON_PERMISSION_MODES: ReadonlySet<PermissionMode> = new Set<PermissionMode>([
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
])

/**
 * Resolve the daemon's permission mode from env, defaulting to least-privilege
 * 'default'. Headless daemon sessions can never prompt, so 'ask'-level tools
 * (Bash/Write/Edit) are blocked rather than auto-approved.
 */
function resolveDaemonPermission(): PermissionMode {
  const fromEnv = process.env.MIPHAM_DAEMON_PERMISSION
  return fromEnv && DAEMON_PERMISSION_MODES.has(fromEnv as PermissionMode)
    ? (fromEnv as PermissionMode)
    : 'default'
}

/**
 * Build the daemon's PermissionSystem, honoring org-level restrictions
 * (permissionRestrictions) and user-defined allow/deny rules. setRestrictions
 * re-clamps the env-derived mode, so a `MIPHAM_DAEMON_PERMISSION=bypassPermissions`
 * is downgraded when the config forbids it — mirroring the CLI's fail-closed behavior.
 */
export function buildDaemonPermission(
  restrictions?: PermissionRestrictions,
  rules?: { allow?: string[]; deny?: string[] },
): PermissionSystem {
  const permission = new PermissionSystem(resolveDaemonPermission())
  if (restrictions) permission.setRestrictions(restrictions)
  if (rules) {
    for (const rule of rules.allow ?? []) permission.allow(rule)
    for (const rule of rules.deny ?? []) permission.deny(rule)
  }
  return permission
}

const DAEMON_DEFAULT_CONTEXT_WINDOW = 200_000

/**
 * Resolve the effective context window (in tokens) for the daemon session's
 * model. Mirrors the CLI's model-aware context sizing so a 1M-context model
 * isn't silently hard-capped at 200K; falls back when the model isn't in the
 * registry.
 */
export function resolveContextWindow(
  registry: ProviderRegistry,
  modelId: string,
  fallback = DAEMON_DEFAULT_CONTEXT_WINDOW,
): number {
  return registry.findModel(modelId)?.contextWindow ?? fallback
}

export function createServer(config: ServerConfig): Server<WsData> {
  const {
    db,
    sm,
    pool,
    token,
    tokenPath,
    port,
    hostname,
    agentManager,
    messageBus,
    goalManager,
    scheduleManager,
    rateLimiter,
    feishu,
    telegram,
  } = config

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

  // ── Agent lifecycle → WebSocket broadcast + MessageBus registration ──
  agentManager.onLifecycleEvent((event) => {
    // Register / unregister in the message bus for broadcastToSession routing
    if (event.type === 'created') {
      messageBus.registerAgent(event.agent.sessionId, event.agent.id)
    } else if (event.type === 'completed' || event.type === 'failed') {
      messageBus.unregisterAgent(event.agent.id)
    }

    // Broadcast lifecycle events to all WebSocket clients in the agent's session
    broadcast(event.agent.sessionId, {
      type: 'agent_lifecycle',
      event: { type: event.type, agent: event.agent },
    })
  })

  // ── Lazy engine & worker initialization ──────────────────────────────
  // Shared across all sessions — lazily initialized on first prompt.
  const engineCache = new Map<string, QueryEngine>()
  let sharedRegistry: ProviderRegistry | null = null
  let sharedTools: Map<string, ToolDefinition> | null = null

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

    // Create per-session context, restoring previous messages from DB.
    // Size it to the active model's context window (1M-capable models get 1M).
    const contextWindow = resolveContextWindow(sharedRegistry!, model)
    const context = new ContextManager({
      maxTokens: contextWindow,
      compactionThreshold: 0.9,
      contextWindow,
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

    const daemonConfig = loadConfig(cwd)
    const permission = buildDaemonPermission(
      daemonConfig.permissionRestrictions,
      daemonConfig.permissionRules,
    )
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

      const engine = getOrCreateEngine(sessionId, session.cwd, session.provider, session.model)
      const worker = pool.createWorker(sessionId, engine, engine.getContext(), engine.getRegistry())

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
      logger.error('error creating worker', { sessionId, error: err })
      return null
    }
  }

  // ── Feishu remote-control adapter（独立签名验证，复用同一 worker 池）──
  const feishuAdapter = feishu
    ? createFeishuAdapter(feishu.config, {
        sm,
        getOrCreateWorker,
        rateLimiter,
        cwd: feishu.cwd,
        provider: feishu.provider,
        model: feishu.model,
      })
    : undefined

  // ── Telegram remote-control adapter（长轮询，无需 webhook 路由）──
  const telegramAdapter = telegram
    ? createTelegramAdapter(telegram.config, createTelegramApi(telegram.config), {
        sm,
        getOrCreateWorker,
        rateLimiter,
        cwd: telegram.cwd,
        provider: telegram.provider,
        model: telegram.model,
      })
    : undefined
  telegramAdapter?.start()

  // ── 心跳式通知：定时扫 pending（goal/schedule），只通知、不自主行动 ──
  const heartbeatSource = {
    listGoals: () => sm.listSessions().flatMap((s) => goalManager.getGoals(s.id)),
    listSchedules: () => sm.listSessions().flatMap((s) => scheduleManager.getSchedules(s.id)),
  }
  if (feishu) {
    const feishuApi = createFeishuApi(feishu.config)
    startHeartbeat({
      source: heartbeatSource,
      push: (message) => {
        for (const openId of feishu.config.allowedOpenIds) {
          void feishuApi.sendText(openId, message).catch(() => {
            /* 推送失败静默，不打断心跳 */
          })
        }
      },
    })
  }
  if (telegram) {
    const telegramApi = createTelegramApi(telegram.config)
    startHeartbeat({
      source: heartbeatSource,
      push: (message) => {
        for (const chatId of telegram.config.allowedChatIds) {
          void telegramApi.sendText(chatId, message).catch(() => {
            /* 推送失败静默，不打断心跳 */
          })
        }
      },
    })
  }

  const server = Bun.serve<WsData>({
    port,
    hostname,
    async fetch(req, server) {
      // ── CORS preflight ──────────────────────────────
      const corsResponse = corsMiddleware(req)
      if (corsResponse) return corsResponse

      const url = new URL(req.url)
      const path = url.pathname
      const method = req.method
      logger.info('request', { method, path })

      // ── Feishu event callback（独立签名验证，不经过 daemon Bearer 鉴权）──
      if (feishuAdapter && method === 'POST' && path === '/feishu/event') {
        return await feishuAdapter.handleEvent(req)
      }

      // ── Rate limiting (skip health endpoint) ──────────
      if (path !== '/api/v1/health') {
        const ip = server.requestIP(req)?.address || 'unknown'
        const rl = rateLimiter.check(ip)
        if (!rl.allowed) {
          return addCorsHeaders(
            Response.json({ ok: false, error: 'Rate limit exceeded' }, { status: 429 }),
            req,
          )
        }
      }

      // ── Auth check ──────────────────────────────────
      const authError = authMiddleware(req, token, server.requestIP(req)?.address)
      if (authError) return addCorsHeaders(authError, req)

      // Helper: create JSON response with CORS headers for external origins
      const json = (data: unknown, init?: ResponseInit) =>
        addCorsHeaders(Response.json(data, init), req)

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
        return json({
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
        return json({ ok: true, data: stats })
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
        return json({ ok: true, data: { session } }, { status: 201 })
      }

      if (method === 'GET' && path === '/api/v1/sessions') {
        const status = url.searchParams.get('status') || undefined
        const sessions = sm.listSessions(status)
        return json({ ok: true, data: { sessions } })
      }

      const sessionMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)$/)
      if (sessionMatch && method === 'GET') {
        const session = sm.getSession(sessionMatch[1]!)
        if (!session) {
          return json({ ok: false, error: 'Session not found' }, { status: 404 })
        }
        return json({ ok: true, data: { session } })
      }

      if (sessionMatch && method === 'DELETE') {
        const sessionId = sessionMatch[1]!
        // Stop worker (interrupt, persist, mark idle) before closing session
        pool.stopWorker(sessionId).catch((err: unknown) => {
          logger.error('error stopping worker', { sessionId, error: err })
        })
        // Remove engine from cache
        engineCache.delete(sessionId)
        sm.closeSession(sessionId)
        return json({ ok: true })
      }

      // ── Session messages ────────────────────────────
      const messagesMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/messages$/)
      if (messagesMatch && method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '100')
        const messages = db.getMessages(messagesMatch[1]!, limit)
        return json({ ok: true, data: { messages } })
      }

      // ── Prompt (Phase 2 — engine-backed) ──────────────
      const promptMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/prompt$/)
      if (promptMatch && method === 'POST') {
        const body = await jsonBody()
        const sessionId = promptMatch[1]!
        const prompt = body.prompt as string

        if (!prompt || typeof prompt !== 'string') {
          return json({ ok: false, error: '"prompt" field is required' }, { status: 400 })
        }

        const session = db.getSession(sessionId)
        if (!session) {
          return json({ ok: false, error: 'Session not found' }, { status: 404 })
        }

        if (session.status === 'closed') {
          return json({ ok: false, error: 'Session is closed' }, { status: 400 })
        }

        // Reactivate idle sessions
        if (session.status === 'idle') {
          db.updateSessionStatus(sessionId, 'active')
        }

        // Get or create the worker (lazy engine initialization)
        const worker = getOrCreateWorker(sessionId)
        if (!worker) {
          return json({ ok: false, error: 'Failed to initialize engine' }, { status: 500 })
        }

        // Fire and forget — respond immediately while processing
        // streams results to connected WebSocket clients.
        worker.processPrompt(prompt).catch((err: unknown) => {
          logger.error('error processing prompt', { sessionId, error: err })
        })

        return json({ ok: true, data: { sessionId, status: 'processing' } }, { status: 202 })
      }

      // ── Agents CRUD ──────────────────────────────────
      if (method === 'POST' && path === '/api/v1/agents') {
        const body = await jsonBody()
        const sessionId = body.sessionId as string
        const agentType = body.agentType as string
        const description = body.description as string

        if (!sessionId || !agentType || !description) {
          return json(
            { ok: false, error: 'sessionId, agentType, and description are required' },
            { status: 400 },
          )
        }

        // Validate session exists
        const session = db.getSession(sessionId)
        if (!session) {
          return json({ ok: false, error: 'Session not found' }, { status: 404 })
        }

        const kind = (body.kind as AgentKind) || undefined
        const agent = agentManager.createAgent(sessionId, agentType, description, kind)
        return json({ ok: true, data: { agent } }, { status: 201 })
      }

      if (method === 'GET' && path === '/api/v1/agents') {
        const sessionId = url.searchParams.get('session') || undefined
        const agents = agentManager.listAgents(sessionId)
        return json({ ok: true, data: { agents } })
      }

      const agentMatch = path.match(/^\/api\/v1\/agents\/([^/]+)$/)
      if (agentMatch && method === 'GET') {
        const agent = agentManager.getAgent(agentMatch[1]!)
        if (!agent) {
          return json({ ok: false, error: 'Agent not found' }, { status: 404 })
        }
        return json({ ok: true, data: { agent } })
      }

      if (agentMatch && method === 'DELETE') {
        const id = agentMatch[1]!
        const stopped = agentManager.stopAgent(id)
        if (!stopped) {
          return json({ ok: false, error: 'Agent not found' }, { status: 404 })
        }
        return json({ ok: true, data: { agent: stopped } })
      }

      const agentMessageMatch = path.match(/^\/api\/v1\/agents\/([^/]+)\/message$/)
      if (agentMessageMatch && method === 'POST') {
        const body = await jsonBody()
        const agentId = agentMessageMatch[1]!
        const content = body.content as string

        if (!content || typeof content !== 'string') {
          return json({ ok: false, error: '"content" field is required' }, { status: 400 })
        }

        // Verify agent exists
        const agent = agentManager.getAgent(agentId)
        if (!agent) {
          return json({ ok: false, error: 'Agent not found' }, { status: 404 })
        }

        messageBus.send('user', agentId, content)
        return json({ ok: true }, { status: 202 })
      }

      // ── Goals (Phase 4 — service-backed) ────────────
      if (method === 'GET' && path === '/api/v1/goals') {
        const sessionId = url.searchParams.get('session')
        if (!sessionId) return json({ ok: false, error: '?session= required' }, { status: 400 })
        const goals = goalManager.getGoals(sessionId)
        return json({ ok: true, data: { goals } })
      }

      if (method === 'POST' && path === '/api/v1/goals') {
        const body = await jsonBody()
        const sessionId = body.sessionId as string
        const description = body.description as string

        if (!sessionId || !description) {
          return json(
            { ok: false, error: 'sessionId and description are required' },
            { status: 400 },
          )
        }

        // Validate session exists
        const session = db.getSession(sessionId)
        if (!session) {
          return json({ ok: false, error: 'Session not found' }, { status: 404 })
        }

        const progress = body.progress as { current: number; total: number } | undefined
        const goalId = goalManager.createGoal(sessionId, description, progress)
        return json({ ok: true, data: { id: goalId } }, { status: 201 })
      }

      const goalMatch = path.match(/^\/api\/v1\/goals\/(\d+)$/)
      if (goalMatch && method === 'PATCH') {
        const id = parseInt(goalMatch[1]!, 10)
        const body = await jsonBody()
        goalManager.updateGoal(
          id,
          body as Partial<Pick<DaemonGoal, 'status' | 'description' | 'progress'>>,
        )
        return json({ ok: true })
      }

      // ── Schedules (Phase 4 — service-backed) ─────────
      if (method === 'GET' && path === '/api/v1/schedules') {
        const sessionId = url.searchParams.get('session')
        if (!sessionId) return json({ ok: false, error: '?session= required' }, { status: 400 })
        const schedules = scheduleManager.getSchedules(sessionId)
        return json({ ok: true, data: { schedules } })
      }

      if (method === 'POST' && path === '/api/v1/schedules') {
        const body = await jsonBody()
        const sessionId = body.sessionId as string
        const cronExpr = body.cronExpr as string
        const prompt = body.prompt as string

        if (!sessionId || !cronExpr || !prompt) {
          return json(
            { ok: false, error: 'sessionId, cronExpr, and prompt are required' },
            { status: 400 },
          )
        }

        // Validate session exists
        const session = db.getSession(sessionId)
        if (!session) {
          return json({ ok: false, error: 'Session not found' }, { status: 404 })
        }

        const scheduleId = scheduleManager.createSchedule(sessionId, cronExpr, prompt)
        return json({ ok: true, data: { id: scheduleId } }, { status: 201 })
      }

      const scheduleMatch = path.match(/^\/api\/v1\/schedules\/(\d+)$/)
      if (scheduleMatch && method === 'DELETE') {
        const id = parseInt(scheduleMatch[1]!, 10)
        scheduleManager.deleteSchedule(id)
        return json({ ok: true })
      }

      // ── Auth: rotate token ───────────────────────────
      if (method === 'POST' && path === '/api/v1/auth/rotate') {
        const newToken = rotateToken(tokenPath)
        return json({ ok: true, data: { token: newToken } })
      }

      // ── API Docs ─────────────────────────────────────
      if (method === 'GET' && path === '/api/v1/docs') {
        return json({
          ok: true,
          data: {
            openapi: '3.0.3',
            info: { title: 'Mipham Code Daemon API', version: PACKAGE_VERSION },
            endpoints: [
              {
                method: 'GET',
                path: '/api/v1/health',
                description: 'Health check and daemon stats',
              },
              { method: 'GET', path: '/api/v1/stats', description: 'Database statistics' },
              { method: 'POST', path: '/api/v1/sessions', description: 'Create a new session' },
              { method: 'GET', path: '/api/v1/sessions', description: 'List sessions' },
              { method: 'GET', path: '/api/v1/sessions/:id', description: 'Get session details' },
              { method: 'DELETE', path: '/api/v1/sessions/:id', description: 'Close a session' },
              {
                method: 'GET',
                path: '/api/v1/sessions/:id/messages',
                description: 'Get session messages',
              },
              {
                method: 'WS',
                path: '/api/v1/sessions/:id/stream',
                description: 'WebSocket stream for session',
              },
              {
                method: 'POST',
                path: '/api/v1/sessions/:id/prompt',
                description: 'Send a prompt to a session',
              },
              { method: 'POST', path: '/api/v1/agents', description: 'Create a background agent' },
              { method: 'GET', path: '/api/v1/agents', description: 'List agents' },
              { method: 'GET', path: '/api/v1/agents/:id', description: 'Get agent details' },
              { method: 'DELETE', path: '/api/v1/agents/:id', description: 'Stop an agent' },
              {
                method: 'POST',
                path: '/api/v1/agents/:id/message',
                description: 'Send message to an agent',
              },
              { method: 'GET', path: '/api/v1/goals', description: 'List goals for a session' },
              { method: 'POST', path: '/api/v1/goals', description: 'Create a goal' },
              { method: 'PATCH', path: '/api/v1/goals/:id', description: 'Update a goal' },
              {
                method: 'GET',
                path: '/api/v1/schedules',
                description: 'List schedules for a session',
              },
              { method: 'POST', path: '/api/v1/schedules', description: 'Create a schedule' },
              { method: 'DELETE', path: '/api/v1/schedules/:id', description: 'Delete a schedule' },
              {
                method: 'POST',
                path: '/api/v1/auth/rotate',
                description: 'Rotate API token (requires auth)',
              },
              {
                method: 'GET',
                path: '/api/v1/docs',
                description: 'API documentation (this endpoint)',
              },
            ],
          },
        })
      }

      return json({ ok: false, error: 'Not found' }, { status: 404 })
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
              logger.error('error processing WS prompt', { sessionId, error: err })
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
