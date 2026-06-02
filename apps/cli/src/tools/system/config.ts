import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml, stringify } from 'yaml'
import type { ToolDefinition } from '@mipham/shared'

const MIPHAM_DIR = join(process.env.HOME || '~', '.mipham')
const USER_CONFIG = join(MIPHAM_DIR, 'config.yml')

export const configTool: ToolDefinition = {
  name: 'Config',
  description: 'Read or update Mipham Code configuration.',
  category: 'system',
  permission: 'ask',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get', 'set', 'list'],
        description: 'Action to perform',
      },
      key: { type: 'string', description: 'Config key (dot notation)' },
      value: { type: 'string', description: 'Value to set' },
    },
    required: ['action'],
  },
  async execute(params, _ctx) {
    mkdirSync(MIPHAM_DIR, { recursive: true })
    const action = params.action as string

    let config: Record<string, unknown> = {}
    if (existsSync(USER_CONFIG)) {
      config = parseYaml(readFileSync(USER_CONFIG, 'utf-8')) as Record<string, unknown>
    }

    if (action === 'list') {
      return { success: true, content: stringify(config) || '(empty config)' }
    }

    const key = params.key as string
    if (!key) return { success: false, content: '', error: 'key is required for get/set' }

    if (action === 'get') {
      const value = key.split('.').reduce((obj: unknown, k) => {
        if (obj && typeof obj === 'object') {
          return (obj as Record<string, unknown>)[k]
        }
        return undefined
      }, config)
      return { success: true, content: JSON.stringify(value) }
    }

    if (action === 'set') {
      const keys = key.split('.')
      let obj: Record<string, unknown> = config
      for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i]!
        if (!obj[k]) obj[k] = {}
        obj = obj[k] as Record<string, unknown>
      }
      obj[keys[keys.length - 1]!] = params.value
      writeFileSync(USER_CONFIG, stringify(config), 'utf-8')
      return { success: true, content: `Set ${key} = ${params.value}` }
    }

    return { success: false, content: '', error: `Unknown action: ${action}` }
  },
}
