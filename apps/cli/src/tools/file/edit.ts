import { readFileSync, writeFileSync } from 'node:fs'
import type { ToolDefinition } from '../../shared/index.ts'
import { resolveSafe } from '../../security/path'

/**
 * Characters considered part of an identifier in source code.
 * A match is only valid if it sits at identifier boundaries —
 * i.e. not embedded inside a larger identifier word.
 */
function isIdentifierChar(c: string): boolean {
  return /[a-zA-Z0-9_$]/.test(c)
}

/**
 * Find all valid occurrences of `oldStr` in `content`.
 * A match is valid only when it does NOT sit inside a larger identifier:
 * - If oldStr starts with an identifier char, the char before the match
 *   must NOT be an identifier char (or the match must be at position 0).
 * - If oldStr ends with an identifier char, the char after the match
 *   must NOT be an identifier char (or the match must be at end of file).
 */
function findValidMatches(content: string, oldStr: string): number[] {
  const indices: number[] = []
  // oldStr is guaranteed non-empty by the required parameter validation
  const oldFirst = oldStr[0]!
  const oldLast = oldStr[oldStr.length - 1]!
  const checkLeft = isIdentifierChar(oldFirst)
  const checkRight = isIdentifierChar(oldLast)

  let pos = 0
  while (pos < content.length) {
    const idx = content.indexOf(oldStr, pos)
    if (idx === -1) break

    // Left boundary check: if oldStr starts with identifier char,
    // the character before the match must not be an identifier char.
    if (checkLeft && idx > 0 && isIdentifierChar(content[idx - 1]!)) {
      pos = idx + 1
      continue
    }

    // Right boundary check: if oldStr ends with identifier char,
    // the character after the match must not be an identifier char.
    const afterIdx = idx + oldStr.length
    if (checkRight && afterIdx < content.length && isIdentifierChar(content[afterIdx]!)) {
      pos = idx + 1
      continue
    }

    indices.push(idx)
    pos = idx + 1
  }

  return indices
}

export const editTool: ToolDefinition = {
  name: 'Edit',
  description:
    'Perform exact string replacement in a file. ' +
    'old_string must match exactly as a standalone occurrence — it will NOT match inside larger ' +
    'identifiers or words (e.g. "user" will not match inside "username"). ' +
    'Must be unique in the file (unless replace_all is used).',
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

    const MAX_FILE_SIZE = 10_000_000 // 10 MB
    const MAX_STRING_SIZE = 5_000_000 // 5 MB
    if (oldStr.length > MAX_STRING_SIZE || newStr.length > MAX_STRING_SIZE) {
      return {
        success: false,
        content: '',
        error: `String too large. Max: 5 MB per string.`,
      }
    }

    const content = readFileSync(filePath, 'utf-8')

    // ── Read tracking: mark as read before editing ──
    ctx.readFiles?.add(filePath)

    if (content.length > MAX_FILE_SIZE) {
      return {
        success: false,
        content: '',
        error: `File too large (${(content.length / 1e6).toFixed(1)} MB). Max: 10 MB.`,
      }
    }

    const matches = findValidMatches(content, oldStr)

    if (matches.length === 0) {
      return {
        success: false,
        content: '',
        error:
          'old_string not found in file. ' +
          'It may appear only as part of a larger word/identifier — provide more context.',
      }
    }

    if (replaceAll) {
      // Build result by splicing at each match (in reverse so indices stay valid)
      let result = content
      for (let i = matches.length - 1; i >= 0; i--) {
        const idx = matches[i]!
        result = result.slice(0, idx) + newStr + result.slice(idx + oldStr.length)
      }
      writeFileSync(filePath, result, 'utf-8')
      return { success: true, content: `Replaced ${matches.length} occurrences in ${filePath}` }
    }

    if (matches.length > 1) {
      return {
        success: false,
        content: '',
        error: 'old_string is not unique in file. Use replace_all or make it more specific.',
      }
    }

    const idx = matches[0]!
    const updated = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length)
    writeFileSync(filePath, updated, 'utf-8')
    return { success: true, content: `Replaced 1 occurrence in ${filePath}` }
  },
}
