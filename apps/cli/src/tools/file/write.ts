import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ToolDefinition } from '../../shared/index.ts'
import { resolveSafe } from '../../security/path'

export const writeTool: ToolDefinition = {
  name: 'Write',
  description:
    'Write a file to the local filesystem. Overwrites if one exists. You must have Read the file before overwriting it — this prevents accidental data loss.',
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

    const MAX_CONTENT_SIZE = 10_000_000 // 10 MB
    if (content.length > MAX_CONTENT_SIZE) {
      return {
        success: false,
        content: '',
        error: `Content too large (${(content.length / 1e6).toFixed(1)} MB). Max: 10 MB.`,
      }
    }

    // ── Read-before-write safety check ──
    const fileExists = existsSync(filePath)
    const wasRead = ctx.readFiles?.has(filePath) ?? true // if no tracking, allow
    if (fileExists && !wasRead) {
      return {
        success: false,
        content: '',
        error: `File "${filePath}" already exists but has not been read this session. Read the file first before overwriting it. This prevents accidental data loss.`,
      }
    }

    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, content, 'utf-8')

    // Track as read since we just wrote it (future writes allowed)
    ctx.readFiles?.add(filePath)

    const lines = content.split('\n').length
    const action = fileExists ? 'Updated' : 'Wrote'
    return { success: true, content: `${action} ${lines} lines to ${filePath}` }
  },
}
