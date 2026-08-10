// apps/cli/src/daemon/types.ts

export type SessionStatus = 'active' | 'idle' | 'compacting' | 'closed'
export type AgentStatus = 'running' | 'completed' | 'failed'
export type AgentKind = 'interactive' | 'forked' | 'attached' | 'unattended'
export type GoalStatus = 'active' | 'completed' | 'paused' | 'cleared'

export interface DaemonSession {
  id: string
  name: string
  cwd: string
  provider: string
  model: string
  status: SessionStatus
  createdAt: string
  updatedAt: string
  closedAt: string | null
  turnCount: number
  tokenIn: number
  tokenOut: number
}

export interface CreateSessionInput {
  name: string
  cwd: string
  provider: string
  model: string
}

export interface DaemonAgent {
  id: string
  sessionId: string
  parentId: string | null
  agentType: string
  description: string
  status: AgentStatus
  kind: AgentKind
  worktree: string | null
  branch: string | null
  prUrl: string | null
  createdAt: string
  completedAt: string | null
  result: string | null
  error: string | null
}

export interface DaemonGoal {
  id: number
  sessionId: string
  description: string
  status: GoalStatus
  progress: { current: number; total: number; note?: string } | null
  createdAt: string
  updatedAt: string
}

export interface DaemonSchedule {
  id: number
  sessionId: string
  cronExpr: string
  prompt: string
  enabled: boolean
  lastFired: string | null
  nextFire: string
}

export interface DaemonStatus {
  pid: number
  port: number
  uptime: number // seconds since start
  activeSessions: number
  totalSessions: number
  activeAgents: number
  version: string
}

export interface MessageRecord {
  id: number
  sessionId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string // JSON-serialized Message object
  createdAt: string
}

// HTTP API types
export interface ApiResponse<T> {
  ok: boolean
  data?: T
  error?: string
}

export interface CreateSessionResponse {
  session: DaemonSession
}

export interface ListSessionsResponse {
  sessions: DaemonSession[]
}
