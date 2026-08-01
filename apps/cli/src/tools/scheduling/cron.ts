import type { ToolDefinition } from '../../shared/index.ts'

export const cronCreateTool: ToolDefinition = {
  name: 'CronCreate',
  description: 'Schedule a durable cron job (survives restarts). 5-field cron expression.',
  category: 'scheduling',
  permission: 'auto',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute(_params, _ctx) {
    return { success: false, content: '', error: 'not yet implemented' }
  },
}

export const cronDeleteTool: ToolDefinition = {
  name: 'CronDelete',
  description: 'Cancel a cron job previously scheduled with CronCreate.',
  category: 'scheduling',
  permission: 'auto',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute(_params, _ctx) {
    return { success: false, content: '', error: 'not yet implemented' }
  },
}

export const cronListTool: ToolDefinition = {
  name: 'CronList',
  description: 'List all cron jobs scheduled via CronCreate.',
  category: 'scheduling',
  permission: 'auto',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute(_params, _ctx) {
    return { success: false, content: '', error: 'not yet implemented' }
  },
}
