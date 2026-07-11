import type { ToolDefinition } from '../../shared/index.ts'
import { takeScreenshot } from './screenshot'
import { launchApp } from './app-launcher'
import { browserNavigate, browserSnapshot, browserClick } from './browser'

export const computerUseTool: ToolDefinition = {
  name: 'ComputerUse',
  description:
    'Take screenshots, launch apps, or control a browser. Always requires user approval.',
  category: 'system',
  permission: 'ask', // ALWAYS ask — security requirement
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['screenshot', 'launch', 'browser_navigate', 'browser_snapshot', 'browser_click'],
        description: 'The computer-use action to perform',
      },
      target: {
        type: 'string',
        description: 'App name (launch), URL (browser_navigate), or element UID (browser_click)',
      },
      text: {
        type: 'string',
        description: 'Text to type (reserved for future browser_type action)',
      },
    },
    required: ['action'],
  },
  async execute(params, _ctx) {
    const action = params.action as string
    const target = (params.target as string) || ''

    switch (action) {
      case 'screenshot': {
        const result = await takeScreenshot()
        return result.success
          ? { success: true, content: `Screenshot captured: ${result.data!.slice(0, 100)}...` }
          : { success: false, content: '', error: result.error }
      }
      case 'launch': {
        const result = launchApp(target)
        return result.success
          ? { success: true, content: result.message }
          : { success: false, content: '', error: result.message }
      }
      case 'browser_navigate': {
        try {
          const url = await browserNavigate(target)
          return { success: true, content: url }
        } catch (err) {
          return {
            success: false,
            content: '',
            error: `Browser navigation failed: ${String(err)}`,
          }
        }
      }
      case 'browser_snapshot': {
        try {
          const snapshot = await browserSnapshot()
          return { success: true, content: snapshot }
        } catch (err) {
          return {
            success: false,
            content: '',
            error: `Browser snapshot failed: ${String(err)}`,
          }
        }
      }
      case 'browser_click': {
        try {
          const result = await browserClick(target)
          return { success: true, content: result }
        } catch (err) {
          return {
            success: false,
            content: '',
            error: `Browser click failed: ${String(err)}`,
          }
        }
      }
      default:
        return { success: false, content: '', error: `Unknown action: ${action}` }
    }
  },
}
