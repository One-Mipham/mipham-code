import type { ToolDefinition } from '../../shared/index.ts'
import type { BackgroundAgentRegistry, BackgroundTask } from '../../agent/background-registry'
import { hasSupportedEvidenceSince } from '../../core/working-memory'

export interface Task {
  id: string
  subject: string
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted' | 'failed'
  activeForm?: string
  metadata?: Record<string, unknown>
  blocks: string[]
  blockedBy: string[]
  owner?: string
  createdAt: string
  /** 完成证据：completed 时是否有 supported 决策接地（软门，unverified 只标记不阻断）。 */
  completionEvidence?: 'supported' | 'unverified'
  /** Set by the `stop` action on a running task ("Task stopped by user."). */
  outputError?: string
}

const tasks = new Map<string, Task>()
let taskCounter = 0

/** Read accessor for the session task store — returns all non-deleted tasks. */
export function getTasks(): Task[] {
  return Array.from(tasks.values()).filter((t) => t.status !== 'deleted')
}

function formatTask(t: Task): string {
  const meta = t.metadata ? ` ${JSON.stringify(t.metadata)}` : ''
  const blocks = t.blocks.length ? ` blocks:[${t.blocks.join(',')}]` : ''
  const blocked = t.blockedBy.length ? ` waits:[${t.blockedBy.join(',')}]` : ''
  const owner = t.owner ? ` @${t.owner}` : ''
  return `[${t.status}] #${t.id}: ${t.subject}${owner}${blocks}${blocked}${meta}`
}

/**
 * Render a **background agent** the way the `output` action renders a session task.
 *
 * Background agents are not in the local `tasks` map: BackgroundAgentRegistry mints
 * their ids in a separate space (`bg-<n>-<base36>`) and keeps results on the registry
 * itself. The Agent tool hands those ids to the model with an explicit
 * `Use Task output taskId="bg-…"` line, so this action has to answer for them —
 * without this path the advertised call can only return `Task #bg-… not found`.
 */
function formatBackgroundOutput(bg: BackgroundTask): {
  success: boolean
  content: string
  error?: string
} {
  const head = `Background task ${bg.id}`
  const meta = `Status: ${bg.status}\nAgent type: ${bg.agentType}\nTask: ${bg.description}`

  if (bg.status === 'running') {
    return {
      success: true,
      content: `${head} is still running — output not yet available.\n${meta}\n\nUse Task output again once it completes.`,
    }
  }

  if (bg.status === 'failed') {
    return {
      success: false,
      content: '',
      error: `${head} failed: ${bg.error ?? '(no error recorded)'}`,
    }
  }

  return {
    success: true,
    content: `── ${head} Output ──\n${meta}\n\n${(bg.result ?? '(no output recorded)').slice(0, 5000)}`,
  }
}

/** Stop a running background agent through the registry that owns it. */
function stopBackgroundTask(
  bg: BackgroundTask,
  registry: BackgroundAgentRegistry,
): { success: boolean; content: string; error?: string } {
  if (bg.status !== 'running') {
    return {
      success: true,
      content: `Background task ${bg.id} is already ${bg.status}. Nothing to stop.`,
    }
  }
  // `stop()` also returns false when the task is no longer running (it completed
  // between the lookup above and this call), so the message must not claim why.
  const aborted = registry.stop(bg.id)
  return {
    success: true,
    content: aborted
      ? `Background task ${bg.id} stopped.\nTask: ${bg.description}`
      : `Background task ${bg.id} was not stopped — it is no longer running.`,
  }
}

/** Check if a task is blocked — has unresolved dependencies. */
function isBlocked(task: Task): boolean {
  if (task.blockedBy.length === 0) return false
  return task.blockedBy.some((depId) => {
    const dep = tasks.get(depId)
    return dep && dep.status !== 'completed' && dep.status !== 'deleted'
  })
}

/** Get the list of blocking task IDs (unresolved dependencies). */
function getBlockingIds(task: Task): string[] {
  return task.blockedBy.filter((depId) => {
    const dep = tasks.get(depId)
    return dep && dep.status !== 'completed' && dep.status !== 'deleted'
  })
}

export const taskTool: ToolDefinition = {
  name: 'Task',
  description:
    'Create and manage structured task lists for tracking progress. ' +
    'Supports CRUD, dependencies (blocks/blockedBy), metadata, owner assignment, ' +
    'background task output/stop, and status workflow: pending → in_progress → completed. ' +
    'Use for complex multi-step tasks, session tracking, and organizing work.',
  category: 'exec',
  permission: 'self',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'update', 'get', 'delete', 'output', 'stop'],
        description:
          'Action: create a task, list all, update status/fields, get one by ID, delete, view output of background task, or stop a running task.',
      },
      subject: { type: 'string', description: 'A brief, actionable title (for create/update).' },
      description: { type: 'string', description: 'What needs to be done (for create/update).' },
      activeForm: {
        type: 'string',
        description: 'Present continuous form shown during work (for create/update).',
      },
      taskId: { type: 'string', description: 'Task ID (for update/get/delete/output/stop).' },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'deleted', 'failed'],
        description:
          'New status. "deleted" permanently removes the task, "failed" marks as failed.',
      },
      addBlocks: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Task IDs that this task blocks (they depend on this one). Use for create or update.',
      },
      addBlockedBy: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Task IDs that block this task (this one depends on them). Use for create or update.',
      },
      owner: { type: 'string', description: 'Agent or user name assigned to this task.' },
      metadata: {
        type: 'object',
        description: 'Arbitrary key-value metadata to attach to the task.',
      },
    },
    required: ['action'],
  },

  async execute(params, _ctx) {
    const action = params.action as string

    // ── CREATE ──
    if (action === 'create') {
      const id = String(++taskCounter)
      const subject = (params.subject as string) || 'Untitled'
      const task: Task = {
        id,
        subject,
        description: (params.description as string) || '',
        status: 'pending',
        activeForm: (params.activeForm as string) || undefined,
        metadata: (params.metadata as Record<string, unknown>) || undefined,
        blocks: [],
        blockedBy: [],
        owner: (params.owner as string) || undefined,
        createdAt: new Date().toISOString(),
      }

      // Accept initial dependencies at creation time
      if (Array.isArray(params.addBlocks)) {
        for (const bid of params.addBlocks as string[]) {
          if (!task.blocks.includes(bid)) task.blocks.push(bid)
        }
      }
      if (Array.isArray(params.addBlockedBy)) {
        for (const bid of params.addBlockedBy as string[]) {
          if (!task.blockedBy.includes(bid)) task.blockedBy.push(bid)
        }
      }

      tasks.set(id, task)
      const blockedNote = isBlocked(task)
        ? ` (blocked — waiting on: ${getBlockingIds(task).join(', ')})`
        : ''
      return { success: true, content: `Task #${id} created: ${subject}${blockedNote}` }
    }

    // ── LIST ──
    if (action === 'list') {
      const all = Array.from(tasks.values()).filter((t) => t.status !== 'deleted')
      if (all.length === 0) return { success: true, content: '(no tasks)' }

      // Sort by availability: in_progress → pending(available) → pending(blocked) → completed
      const sortOrder: Record<string, number> = {
        in_progress: 0,
        pending: 1,
        completed: 2,
        failed: 3,
      }

      const sorted = [...all].sort((a, b) => {
        const orderA = sortOrder[a.status] ?? 3
        const orderB = sortOrder[b.status] ?? 3
        if (orderA !== orderB) return orderA - orderB
        // Within same status: available before blocked
        if (a.status === 'pending' && b.status === 'pending') {
          const aBlocked = isBlocked(a)
          const bBlocked = isBlocked(b)
          if (aBlocked !== bBlocked) return aBlocked ? 1 : -1
        }
        return 0
      })

      const lines: string[] = []
      const statusLabels: Record<string, { emoji: string; label: string }> = {
        in_progress: { emoji: '🔄', label: 'In Progress' },
        pending: { emoji: '📋', label: 'Pending' },
        completed: { emoji: '✅', label: 'Completed' },
        failed: { emoji: '❌', label: 'Failed' },
      }

      let currentStatus = ''
      for (const t of sorted) {
        const statusInfo = statusLabels[t.status]
        if (!statusInfo) continue

        if (statusInfo.label !== currentStatus) {
          currentStatus = statusInfo.label
          // Count tasks in this status group
          const count = sorted.filter((s) => statusLabels[s.status]?.label === currentStatus).length
          lines.push(`${statusInfo.emoji} ${currentStatus} (${count}):`)
        }

        const blocked = isBlocked(t)
        const prefix = blocked && t.status === 'pending' ? '🚫 ' : '  '
        const blockingNote = blocked ? ` 🚫 阻塞中 (等待: ${getBlockingIds(t).join(', ')})` : ''
        lines.push(`${prefix}${formatTask(t)}${blockingNote}`)
      }

      // Summary footer
      const available = all.filter((t) => t.status === 'pending' && !isBlocked(t)).length
      const blockedCount = all.filter((t) => t.status === 'pending' && isBlocked(t)).length
      if (blockedCount > 0) {
        lines.push('')
        lines.push(
          `📊 ${available} available · ${blockedCount} blocked · ${all.filter((t) => t.status === 'completed').length} done`,
        )
      }

      return { success: true, content: lines.join('\n') }
    }

    // ── GET ──
    if (action === 'get') {
      const taskId = params.taskId as string
      const task = tasks.get(taskId)
      if (!task) return { success: false, content: '', error: `Task #${taskId} not found` }

      const lines = [
        `── Task #${task.id} ──`,
        `Subject: ${task.subject}`,
        `Status: ${task.status}`,
        `Description: ${task.description || '(none)'}`,
      ]
      if (task.completionEvidence) {
        lines.push(`Completion evidence: ${task.completionEvidence}`)
      }
      if (task.activeForm) lines.push(`Active form: ${task.activeForm}`)
      if (task.owner) lines.push(`Owner: ${task.owner}`)
      if (task.blocks.length) lines.push(`Blocks: ${task.blocks.join(', ')}`)
      if (task.blockedBy.length) {
        const blocking = getBlockingIds(task)
        if (blocking.length > 0) {
          lines.push(
            `Blocked by: ${task.blockedBy.join(', ')} (active blockers: ${blocking.join(', ')})`,
          )
        } else {
          lines.push(`Blocked by: ${task.blockedBy.join(', ')} (all resolved ✓)`)
        }
      }
      if (task.metadata) lines.push(`Metadata: ${JSON.stringify(task.metadata)}`)
      if (task.outputError) {
        lines.push('')
        lines.push(`── Error ──`)
        lines.push(task.outputError)
      }

      return { success: true, content: lines.join('\n') }
    }

    // ── UPDATE ──
    if (action === 'update') {
      const taskId = params.taskId as string
      const task = tasks.get(taskId)
      if (!task) return { success: false, content: '', error: `Task #${taskId} not found` }

      if (params.subject !== undefined) task.subject = params.subject as string
      if (params.description !== undefined) task.description = params.description as string
      if (params.activeForm !== undefined) task.activeForm = params.activeForm as string
      if (params.status !== undefined) {
        task.status = params.status as Task['status']
        // 完成证据门（软门）：completed 时按「自任务创建以来是否有 supported 决策」标记。
        // unverified 只标记不阻断（对齐 CRSI「最小干预」）。
        if (params.status === 'completed') {
          task.completionEvidence = hasSupportedEvidenceSince(new Date(task.createdAt).getTime())
            ? 'supported'
            : 'unverified'
        }
      }
      if (params.owner !== undefined) task.owner = params.owner as string

      // Merge dependency arrays
      if (Array.isArray(params.addBlocks)) {
        for (const bid of params.addBlocks as string[]) {
          if (!task.blocks.includes(bid)) task.blocks.push(bid)
        }
      }
      if (Array.isArray(params.addBlockedBy)) {
        for (const bid of params.addBlockedBy as string[]) {
          if (!task.blockedBy.includes(bid)) task.blockedBy.push(bid)
        }
      }

      // Merge metadata
      if (params.metadata && typeof params.metadata === 'object') {
        task.metadata = {
          ...(task.metadata || {}),
          ...(params.metadata as Record<string, unknown>),
        }
      }

      const blockedNote = isBlocked(task)
        ? ` (blocked — waiting on: ${getBlockingIds(task).join(', ')})`
        : ''
      const unverifiedNote =
        task.status === 'completed' && task.completionEvidence === 'unverified'
          ? '\n⚠ completed without verified evidence (no supported tool decision since task start)'
          : ''

      return {
        success: true,
        content: `Task #${taskId} updated.\n${formatTask(task)}${blockedNote}${unverifiedNote}`,
      }
    }

    // ── DELETE ──
    if (action === 'delete') {
      const taskId = params.taskId as string
      const task = tasks.get(taskId)
      if (!task) return { success: false, content: '', error: `Task #${taskId} not found` }
      task.status = 'deleted'
      return { success: true, content: `Task #${taskId} deleted.` }
    }

    // ── OUTPUT ──
    if (action === 'output') {
      const taskId = params.taskId as string
      const task = tasks.get(taskId)
      if (!task) {
        // Not a session task — it may be a background agent id (`bg-…`), which is
        // the id space this action is advertised for. The registry is wired onto
        // the tool context by the engine (`engine.ts` defaultToolContext).
        const bg = _ctx.backgroundAgentRegistry?.get(taskId)
        if (bg) return formatBackgroundOutput(bg)
        return { success: false, content: '', error: `Task #${taskId} not found` }
      }

      if (task.status === 'pending') {
        return {
          success: true,
          content: `Task #${taskId} is still pending — no output yet.\nStatus: ${task.status}\nSubject: ${task.subject}`,
        }
      }

      if (task.status === 'in_progress') {
        return {
          success: true,
          content: `Task #${taskId} is still running — output not yet available.\nStatus: in_progress\nSubject: ${task.subject}\n\nUse Task output again once the task completes.`,
        }
      }

      if (task.status === 'failed' && task.outputError) {
        return {
          success: false,
          content: '',
          error: `Task #${taskId} failed: ${task.outputError}`,
        }
      }

      return {
        success: true,
        content: `Task #${taskId} — Status: ${task.status}\nSubject: ${task.subject}\n\n(no output recorded)`,
      }
    }

    // ── STOP ──
    if (action === 'stop') {
      const taskId = params.taskId as string
      const task = tasks.get(taskId)
      if (!task) {
        // Background agent id (`bg-…`) — the other id space. The local branch
        // below only marks a status; an actual running agent is aborted through
        // the registry that owns it.
        const registry = _ctx.backgroundAgentRegistry
        const bg = registry?.get(taskId)
        if (registry && bg) return stopBackgroundTask(bg, registry)
        return { success: false, content: '', error: `Task #${taskId} not found` }
      }

      if (task.status === 'completed' || task.status === 'deleted') {
        return {
          success: true,
          content: `Task #${taskId} is already ${task.status}. Nothing to stop.`,
        }
      }

      if (task.status === 'pending') {
        // Cancel a pending task
        task.status = 'deleted'
        return { success: true, content: `Task #${taskId} cancelled (was pending).` }
      }

      // For in_progress session tasks: mark as failed. There is no process behind
      // one — a *background agent* is aborted by stopBackgroundTask() above, which
      // the registry owns.
      task.status = 'failed'
      task.outputError = 'Task stopped by user.'

      return { success: true, content: `Task #${taskId} stopped.` }
    }

    return { success: false, content: '', error: `Unknown action: ${action}` }
  },
}
