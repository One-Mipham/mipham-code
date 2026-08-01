import type { ToolDefinition } from '../../shared/index.ts'

export const scheduleWakeupTool: ToolDefinition = {
  name: 'ScheduleWakeup',
  description: 'Schedule when to resume work for /loop recurring tasks. delaySeconds clamped to [60, 3600].',
  category: 'scheduling',
  permission: 'auto',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute(_params, _ctx) {
    return { success: false, content: '', error: 'not yet implemented' }
  },
}
