import { mkdirSync, existsSync, readFileSync, constants } from 'node:fs'
import { dirname } from 'node:path'
import type { ToolDefinition } from '../../shared/index.ts'
import { resolveSafe } from '../../security/path'
import { writeFileNoFollow, isSymlinkLoop, isValidUtf8 } from '../../security/fd'

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
    const wasRead = ctx.readFiles?.has(filePath) ?? false // fail closed: no tracking = not read
    if (fileExists && !wasRead) {
      return {
        success: false,
        content: '',
        error: `File "${filePath}" already exists but has not been read this session. Read the file first before overwriting it. This prevents accidental data loss.`,
      }
    }

    // ── Whole-file check: a window is not the file ──
    // `offset`/`limit` exist so a huge file can be inspected a slice at a time.
    // Treating that slice as "the file has been read" lets the next Write erase
    // every line outside it without a trace — the model rewrites a file it only
    // half-saw. Only a read that covered the whole file grants overwrite;
    // anything less must go through Edit, which is anchored on content the model
    // actually has.
    const completelyRead = ctx.readFilesComplete?.has(filePath) ?? false
    if (fileExists && wasRead && !completelyRead) {
      return {
        success: false,
        content: '',
        error:
          `File "${filePath}" was only partially read (an offset/limit window). ` +
          'Overwriting it would discard the rest of the file. Use Edit for targeted ' +
          'changes, or Read the whole file first (no offset/limit).',
      }
    }

    // ── Non-UTF-8 guard: refuse to clobber a file we cannot represent ──
    // A Windows-1252 / Shift-JIS / GBK file read into the model came back as
    // U+FFFD garbage; writing UTF-8 content over it would erase the originals
    // with no error. Same-source as the Edit guard (`isValidUtf8`).
    if (fileExists) {
      try {
        if (!isValidUtf8(readFileSync(filePath))) {
          return {
            success: false,
            content: '',
            error:
              `File "${filePath}" is not valid UTF-8 (likely Windows-1252 / Shift-JIS / GBK / Latin-1). ` +
              'Overwriting it would destroy the original bytes. Convert it to UTF-8 or delete it first.',
          }
        }
      } catch {
        // Unreadable for another reason — let the write itself surface that.
      }
    }

    mkdirSync(dirname(filePath), { recursive: true })

    // O_NOFOLLOW: reject a symlink swapped in after resolveSafe (TOCTOU) —
    // writing through it would clobber an out-of-workspace target.
    try {
      writeFileNoFollow(
        filePath,
        content,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
      )
    } catch (err) {
      if (isSymlinkLoop(err)) {
        return {
          success: false,
          content: '',
          error: `Refusing to write through a symbolic link: ${filePath}`,
        }
      }
      throw err
    }

    // Track as read since we just wrote it (future writes allowed). The model
    // authored every byte of the new content, so this is a whole-file read too.
    ctx.readFiles?.add(filePath)
    ctx.readFilesComplete?.add(filePath)

    const lines = content.split('\n').length
    const action = fileExists ? 'Updated' : 'Wrote'
    return { success: true, content: `${action} ${lines} lines to ${filePath}` }
  },
}
