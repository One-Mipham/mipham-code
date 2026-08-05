import type { ToolDefinition } from '../../shared/index.ts'

interface Task {
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
  /** Background task output content (set when a background agent completes). */
  output?: string
  /** Background task error message (set when a background agent fails). */
  outputError?: string
}

const tasks = new Map<string, Task>()
let taskCounter = 0

function formatTask(t: Task): string {
  const meta = t.metadata ? ` ${JSON.stringify(t.metadata)}` : ''
  const blocks = t.blocks.length ? ` blocks:[${t.blocks.join(',')}]` : ''
  const blocked = t.blockedBy.length ? ` waits:[${t.blockedBy.join(',')}]` : ''
  const owner = t.owner ? ` @${t.owner}` : ''
  return `[${t.status}] #${t.id}: ${t.subject}${owner}${blocks}${blocked}${meta}`
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
  permission: 'auto',
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
        description: 'New status. "deleted" permanently removes the task, "failed" marks as failed.',
      },
      addBlocks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that this task blocks (they depend on this one). Use for create or update.',
      },
      addBlockedBy: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that block this task (this one depends on them). Use for create or update.',
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
      if (task.activeForm) lines.push(`Active form: ${task.activeForm}`)
      if (task.owner) lines.push(`Owner: ${task.owner}`)
      if (task.blocks.length) lines.push(`Blocks: ${task.blocks.join(', ')}`)
      if (task.blockedBy.length) {
        const blocking = getBlockingIds(task)
        if (blocking.length > 0) {
          lines.push(`Blocked by: ${task.blockedBy.join(', ')} (active blockers: ${blocking.join(', ')})`)
        } else {
          lines.push(`Blocked by: ${task.blockedBy.join(', ')} (all resolved ✓)`)
        }
      }
      if (task.metadata) lines.push(`Metadata: ${JSON.stringify(task.metadata)}`)
      if (task.output) {
        lines.push('')
        lines.push('── Output ──')
        lines.push(task.output.slice(0, 2000))
      }
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
      if (params.status !== undefined) task.status = params.status as Task['status']
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

      return { success: true, content: `Task #${taskId} updated.\n${formatTask(task)}${blockedNote}` }
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
      if (!task) return { success: false, content: '', error: `Task #${taskId} not found` }

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

      if (task.status === 'completed' && task.output) {
        return {
          success: true,
          content: `── Task #${taskId} Output ──\nStatus: completed\nSubject: ${task.subject}\n\n${task.output.slice(0, 5000)}`,
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
      if (!task) return { success: false, content: '', error: `Task #${taskId} not found` }

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

      // For in_progress tasks: mark as failed — actual process termination is handled
      // by BackgroundAgentRegistry.stop() when wired via the engine context
      task.status = 'failed'
      task.outputError = 'Task stopped by user.'

      // If BackgroundAgentRegistry is available in context, try to abort
      if (_ctx.registry) {
        // Signal to any background registry that this task should stop
        // The background registry will be injected via the engine context
        const bgRegistry = (_ctx as unknown as Record<string, unknown>).backgroundAgentRegistry as
          | { stop(id: string): boolean }
          | undefined
        if (bgRegistry) {
          bgRegistry.stop(taskId)
        }
      }

      return { success: true, content: `Task #${taskId} stopped.` }
    }

    return { success: false, content: '', error: `Unknown action: ${action}` }
  },
}
