import type { ToolDefinition } from '../../shared/index.ts'

interface Task {
  id: string
  subject: string
  description: string
  status: 'pending' | 'in_progress' | 'completed'
}

const tasks = new Map<string, Task>()
let taskCounter = 0

export const taskTool: ToolDefinition = {
  name: 'Task',
  description: 'Create and manage structured task lists for tracking progress.',
  category: 'exec',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'update'],
        description: 'Action to perform',
      },
      subject: { type: 'string', description: 'Task subject (for create)' },
      description: { type: 'string', description: 'Task description (for create)' },
      taskId: { type: 'string', description: 'Task ID (for update)' },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed'],
        description: 'New status (for update)',
      },
    },
    required: ['action'],
  },
  async execute(params, _ctx) {
    const action = params.action as string

    if (action === 'create') {
      const id = String(++taskCounter)
      const subject = (params.subject as string) || 'Untitled'
      tasks.set(id, {
        id,
        subject,
        description: (params.description as string) || '',
        status: 'pending',
      })
      return { success: true, content: `Task #${id} created: ${subject}` }
    }

    if (action === 'list') {
      const list = Array.from(tasks.values())
        .map((t) => `[${t.status}] #${t.id}: ${t.subject}`)
        .join('\n')
      return { success: true, content: list || '(no tasks)' }
    }

    if (action === 'update') {
      const taskId = params.taskId as string
      const task = tasks.get(taskId)
      if (!task) return { success: false, content: '', error: `Task #${taskId} not found` }
      if (params.status) task.status = params.status as Task['status']
      return { success: true, content: `Task #${taskId} updated: ${task.status}` }
    }

    return { success: false, content: '', error: `Unknown action: ${action}` }
  },
}
