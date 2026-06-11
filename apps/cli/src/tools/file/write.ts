import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ToolDefinition } from '../../shared/index.ts'
import { resolveSafe } from '../../security/path'

export const writeTool: ToolDefinition = {
  name: 'Write',
  description: 'Write a file to the local filesystem. Creates parent directories if needed.',
  category: 'file',
  permission: 'ask',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to write to' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['file_path', 'content'],
  },
  async execute(params, ctx) {
    const filePath = resolveSafe(ctx.cwd, params.file_path as string)
    const content = params.content as string
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, content, 'utf-8')
    const lines = content.split('\n').length
    return { success: true, content: `Wrote ${lines} lines to ${filePath}` }
  },
}
