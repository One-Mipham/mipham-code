import { readFileSync, readSync, fstatSync, closeSync, constants } from 'node:fs'
import type { ToolDefinition, CredentialMaskingConfig } from '../../shared/index.ts'
import { resolveSafe } from '../../security/path'
import { openNoFollow, isSymlinkLoop } from '../../security/fd'
import type { Service } from '../../vajra'
import { toolKey } from '../seam'
import { withValidation } from '../validation'

/** Lines returned when the caller passes no `limit`. */
const DEFAULT_LIMIT = 2000

/** Bytes per syscall while scanning for newlines. */
const CHUNK_BYTES = 64 * 1024

/**
 * How far a single Read may scan to locate the requested lines. Lines are
 * addressed by index, so finding line N means scanning everything before it;
 * this is what keeps that scan from turning a request for two lines of a 2 GB
 * file into a 2 GB read.
 */
const MAX_SCAN_BYTES = 50_000_000

/** Render a line window the way the tool reports it: `   123\ttext`. */
function formatLines(lines: string[], offset: number): string {
  return lines.map((l, i) => `${String(offset + i + 1).padStart(6, ' ')}\t${l}`).join('\n')
}

/**
 * Lines `[offset, offset + limit)` of an already-decoded string.
 *
 * Scans newlines instead of `content.split('\n')`, which materializes one JS
 * string for *every* line of the file in order to return `limit` of them. On a
 * 20 MB source, returning 2000 lines that way cost +34 MB of heap for 60-char
 * lines and +100 MB for 3-char lines (333k vs 10M lines — it tracks line count,
 * not bytes); scanning costs ~0 on top of the string it is handed.
 */
function windowFromString(content: string, offset: number, limit: number): string[] {
  const out: string[] = []
  let lineNo = 0
  let start = 0
  while (out.length < limit) {
    const nl = content.indexOf('\n', start)
    const end = nl === -1 ? content.length : nl
    if (lineNo >= offset) out.push(content.slice(start, end))
    lineNo++
    if (nl === -1) break
    start = nl + 1
  }
  return out
}

/**
 * Lines `[offset, offset + limit)` read from `fd` — only those lines are ever
 * materialized, so cost tracks the window rather than the file: a 2000-line
 * window of a 20 MB file leaves RSS at the process baseline (~38 MB), where
 * reading the file whole and slicing it cost 142–255 MB.
 *
 * Two passes over the same bytes: the first only *looks* for newline bytes to
 * learn where the window starts and ends, the second reads exactly that byte
 * range and decodes it once. Scanning raw bytes is safe because `0x0a` never
 * occurs inside a multi-byte UTF-8 sequence (continuation bytes are >= 0x80),
 * and the decoded range starts and ends on a newline — so neither pass can split
 * a character. Returns null when the window cannot be located within
 * `MAX_SCAN_BYTES`.
 */
function windowFromFd(fd: number, offset: number, limit: number): string[] | null {
  if (limit <= 0) return []

  const buf = Buffer.allocUnsafe(CHUNK_BYTES)
  let scanned = 0 // bytes consumed by the scan
  let lineNo = 0
  let windowStart = offset <= 0 ? 0 : -1
  let windowEnd = -1
  let eof = false

  while (windowEnd === -1 && scanned < MAX_SCAN_BYTES) {
    const n = readSync(fd, buf, 0, buf.length, scanned)
    if (n <= 0) {
      eof = true
      break
    }
    const lastNl = buf.lastIndexOf(0x0a, n - 1)
    if (lastNl !== -1) {
      let from = 0
      for (;;) {
        const nl = buf.indexOf(0x0a, from)
        if (nl === -1 || nl > lastNl) break
        lineNo++ // line `lineNo - 1` ends at this newline
        if (lineNo === offset) windowStart = scanned + nl + 1
        if (lineNo === offset + limit) {
          windowEnd = scanned + nl
          break
        }
        from = nl + 1
      }
    }
    scanned += n
  }

  if (windowEnd === -1) {
    // Either the file ended (the window is everything that is left) or the scan
    // budget ran out before the window's last line was reached.
    if (!eof) return null
    windowEnd = scanned
  }
  if (windowStart === -1) return [] // `offset` is past the end of the file

  const out = Buffer.allocUnsafe(windowEnd - windowStart)
  let got = 0
  while (got < out.length) {
    const n = readSync(fd, out, got, out.length - got, windowStart + got)
    if (n <= 0) break
    got += n
  }
  return out.toString('utf-8', 0, got).split('\n')
}

export function createReadTool(credentialConfig?: CredentialMaskingConfig): ToolDefinition {
  return {
    name: 'Read',
    description:
      'Read a file from the local filesystem. Supports offset and limit for large files.',
    category: 'file',
    permission: 'self',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to read' },
        offset: { type: 'integer', description: 'Line number to start reading from' },
        limit: { type: 'integer', description: 'Number of lines to read' },
      },
      required: ['file_path'],
    },
    async execute(params, ctx) {
      const filePath = resolveSafe(ctx.cwd, params.file_path as string)

      // O_NOFOLLOW: fail closed if the path was swapped to a symlink after
      // resolveSafe (TOCTOU) — never follow it to read outside the workspace.
      let fd: number
      try {
        fd = openNoFollow(filePath, constants.O_RDONLY)
      } catch (err) {
        if (isSymlinkLoop(err)) {
          return { success: false, content: '', error: `Path is a symbolic link: ${filePath}` }
        }
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return { success: false, content: '', error: `File not found: ${filePath}` }
        }
        throw err
      }

      try {
        if (fstatSync(fd).isDirectory()) {
          return { success: false, content: '', error: `Path is a directory: ${filePath}` }
        }

        const offset = (params.offset as number) || 0
        const limit = (params.limit as number) || DEFAULT_LIMIT

        // ── Credential masking ──
        // The rule matches on path alone, so this is decided before any read: a
        // masked file needs its whole content (the mask is content-shaped), while
        // every other file is served straight from the fd. Reading the file
        // *first* is what used to make `offset`/`limit` useless on large files —
        // the size check ran before the window was ever applied.
        let result: string | null = null
        if (credentialConfig) {
          const { matchCredentialFile, maskContent, CREDENTIAL_SENTINEL } =
            await import('../../core/credential-masker')
          const rule = matchCredentialFile(filePath, credentialConfig)
          if (rule) {
            const masked = maskContent(readFileSync(fd, 'utf-8'), rule)
            // Full-file mask: return the sentinel immediately (offset/limit don't apply)
            result =
              masked === CREDENTIAL_SENTINEL
                ? masked
                : formatLines(windowFromString(masked, offset, limit), offset)
          }
        }

        if (result === null) {
          const lines = windowFromFd(fd, offset, limit)
          if (lines === null) {
            return {
              success: false,
              content: '',
              error:
                `File too large: scanned ${MAX_SCAN_BYTES / 1e6} MB without reaching the end of lines ` +
                `${offset}–${offset + limit - 1}. Narrow the range (smaller offset or limit), or use a ` +
                `shell tool to slice the file.`,
            }
          }
          result = formatLines(lines, offset)
        }

        // ── Read tracking: mark file as read for Write tool safety ──
        ctx.readFiles?.add(filePath)
        return { success: true, content: result }
      } finally {
        closeSync(fd)
      }
    },
  }
}

export const readToolService: Service = {
  inject: ['credentials'],
  apply(ctx) {
    const credentialConfig = ctx.get<CredentialMaskingConfig>('credentials')
    ctx.provide(toolKey('Read'), withValidation(createReadTool(credentialConfig)))
  },
}
