import { readFileSync, writeFileSync } from 'node:fs'
import type { ToolDefinition } from '../shared/index.ts'
import { resolveSafe } from '../../security/path'

export const editTool: ToolDefinition = {
  name: 'Edit',
  description:
    'Perform exact string replacement in a file. old_string must match exactly and be unique.',
  category: 'file',
  permission: 'ask',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean', default: false },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  async execute(params, ctx) {
    const filePath = resolveSafe(ctx.cwd, params.file_path as string)
    const oldStr = params.old_string as string
    const newStr = params.new_string as string
    const replaceAll = params.replace_all as boolean

    const content = readFileSync(filePath, 'utf-8')

    if (replaceAll) {
      if (!content.includes(oldStr)) {
        return { success: false, content: '', error: 'old_string not found in file' }
      }
      const updated = content.replaceAll(oldStr, newStr)
      writeFileSync(filePath, updated, 'utf-8')
      const count = content.split(oldStr).length - 1
      return { success: true, content: `Replaced ${count} occurrences in ${filePath}` }
    }

    const firstIndex = content.indexOf(oldStr)
    if (firstIndex === -1) {
      return { success: false, content: '', error: 'old_string not found in file' }
    }
    const secondIndex = content.indexOf(oldStr, firstIndex + 1)
    if (secondIndex !== -1) {
      return {
        success: false,
        content: '',
        error:
          'old_string is not unique in file. Use replace_all or make it more specific.',
      }
    }

    const updated =
      content.slice(0, firstIndex) + newStr + content.slice(firstIndex + oldStr.length)
    writeFileSync(filePath, updated, 'utf-8')
    return { success: true, content: `Replaced 1 occurrence in ${filePath}` }
  },
}
