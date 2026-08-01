import type { ToolDefinition } from '../../shared/index.ts'

interface Task {
  id: string
  subject: string
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  activeForm?: string
  metadata?: Record<string, unknown>
  blocks: string[]
  blockedBy: string[]
  owner?: string
  createdAt: string
}

const tasks = new Map<string, Task>()
let taskCounter = 0

function formatTask(t: Task): string {
  const meta = t.metadata ? ` ${JSON.stringify(t.metadata)}` : ''
  const blocks = t.blocks.length ? ` blocks:[${t.blocks.join(',')}]` : ''
  const blocked = t.blockedBy.length ? ` waits:[${t.blockedBy.join(',')}]` : ''
  return `[${t.status}] #${t.id}: ${t.subject}${blocks}${blocked}${meta}`
}

export const taskTool: ToolDefinition = {
  name: 'Task',
  description:
    'Create and manage structured task lists for tracking progress. ' +
    'Supports CRUD, dependencies (blocks/blockedBy), metadata, owner assignment, and status workflow: pending → in_progress → completed. ' +
    'Use for complex multi-step tasks, session tracking, and organizing work.',
  category: 'exec',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'update', 'get', 'delete'],
        description:
          'Action: create a task, list all, update status/fields, get one by ID, or delete.',
      },
      subject: { type: 'string', description: 'A brief, actionable title (for create/update).' },
      description: { type: 'string', description: 'What needs to be done (for create/update).' },
      activeForm: {
        type: 'string',
        description: 'Present continuous form shown during work (for create/update).',
      },
      taskId: { type: 'string', description: 'Task ID (for update/get/delete).' },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'deleted'],
        description: 'New status. "deleted" permanently removes the task.',
      },
      addBlocks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that this task blocks (they depend on this one).',
      },
      addBlockedBy: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that block this task (this one depends on them).',
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
      tasks.set(id, task)
      return { success: true, content: `Task #${id} created: ${subject}` }
    }

    // ── LIST ──
    if (action === 'list') {
      const all = Array.from(tasks.values()).filter((t) => t.status !== 'deleted')
      if (all.length === 0) return { success: true, content: '(no tasks)' }

      // Group by status
      const groups: Record<string, Task[]> = { pending: [], in_progress: [], completed: [] }
      for (const t of all) groups[t.status]?.push(t)

      const lines: string[] = []
      for (const status of ['in_progress', 'pending', 'completed'] as const) {
        const group = groups[status]!
        if (group.length === 0) continue
        const emoji = status === 'in_progress' ? '🔄' : status === 'pending' ? '📋' : '✅'
        lines.push(`${emoji} ${status.replace('_', ' ')} (${group.length}):`)
        for (const t of group) lines.push(`  ${formatTask(t)}`)
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
      if (task.blockedBy.length) lines.push(`Blocked by: ${task.blockedBy.join(', ')}`)
      if (task.metadata) lines.push(`Metadata: ${JSON.stringify(task.metadata)}`)

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

      return { success: true, content: `Task #${taskId} updated.\n${formatTask(task)}` }
    }

    // ── DELETE ──
    if (action === 'delete') {
      const taskId = params.taskId as string
      const task = tasks.get(taskId)
      if (!task) return { success: false, content: '', error: `Task #${taskId} not found` }
      task.status = 'deleted'
      return { success: true, content: `Task #${taskId} deleted.` }
    }

    return { success: false, content: '', error: `Unknown action: ${action}` }
  },
}
