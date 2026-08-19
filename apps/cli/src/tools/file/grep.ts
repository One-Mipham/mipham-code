import type { ToolDefinition } from '../../shared/index.ts'
import { resolveSafe } from '../../security/path'

/** Grep stall guard: a search over a huge tree (or a pathological regex) must
 *  not hang the session for minutes. Matches the Bash tool's 120s ceiling. */
const GREP_TIMEOUT_MS = 120_000

/** Run a search command with a kill-timer; report whether the timeout fired. */
export async function runSearch(
  cmd: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; timedOut: boolean; exitCode: number | null }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutMs)
  const stdout = await new Response(proc.stdout).text()
  await proc.exited
  clearTimeout(timer)
  return { stdout, timedOut, exitCode: proc.exitCode }
}

/** grep 输出上限：超过则显式截断并附标记（不能静默丢内容——模型会误以为看全了）。 */
const GREP_MAX_OUTPUT_CHARS = 50_000

/** 截断 grep 输出：超限时加 "(truncated)" 标记，避免静默截断。 */
export function truncateGrepOutput(stdout: string): string {
  const out = stdout || '(no matches)'
  if (out.length <= GREP_MAX_OUTPUT_CHARS) return out
  return `${out.slice(0, GREP_MAX_OUTPUT_CHARS)}\n\n... (truncated)`
}

export const grepTool: ToolDefinition = {
  name: 'Grep',
  description:
    'Search file contents using ripgrep (rg) — the recommended code search tool. ' +
    '~10× faster than grep, with automatic fallback to grep if rg is unavailable. ' +
    'Use this for single-shot regex searches across files. ' +
    'Prefer Grep over Bash grep/rg for code search; use Bash only for complex ' +
    'multi-step pipelines (e.g., pipe to sort/uniq/wc, or chained find+xargs). ' +
    'Best practice: narrow scope with `path` (directory/file) and `include` ' +
    '(glob pattern, e.g. "*.ts") before searching. ' +
    'The `pattern` parameter accepts full regex syntax (e.g., "log.*Error", "\\bclass\\s+\\w+").',
  category: 'file',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      path: { type: 'string', description: 'Directory or file to search in' },
      include: { type: 'string', description: 'File pattern to include (e.g., "*.ts")' },
    },
    required: ['pattern'],
  },
  async execute(params, ctx) {
    const pattern = params.pattern as string
    const searchPath = resolveSafe(ctx.cwd, (params.path as string) || '.')
    const include = params.include as string | undefined

    // 1. ripgrep (fast path)
    const rgArgs = ['rg', '-n', '--heading', '--color=never', '-M', '500', pattern]
    if (include) rgArgs.push('--glob', include)
    rgArgs.push(searchPath)
    try {
      const { stdout, timedOut, exitCode } = await runSearch(rgArgs, ctx.cwd, GREP_TIMEOUT_MS)
      if (timedOut) {
        return {
          success: false,
          content: '',
          error: `Grep timed out after ${GREP_TIMEOUT_MS / 1000}s — narrow scope with "path" and "include".`,
        }
      }
      if (exitCode === 1) return { success: true, content: '(no matches)' }
      if (exitCode === 0) return { success: true, content: stdout || '(no matches)' }
      // rg exit 2 (error) or null (killed) → fall through to grep
    } catch {
      // rg not installed → fall through to grep
    }

    // 2. fallback to plain grep
    const grepArgs = ['grep', '-rn', pattern, searchPath]
    try {
      const { stdout, timedOut, exitCode } = await runSearch(grepArgs, ctx.cwd, GREP_TIMEOUT_MS)
      if (timedOut) {
        return {
          success: false,
          content: '',
          error: `Grep timed out after ${GREP_TIMEOUT_MS / 1000}s — narrow scope with "path" and "include".`,
        }
      }
      if (exitCode === 1) return { success: true, content: '(no matches)' }
      if (exitCode === 0) {
        return { success: true, content: truncateGrepOutput(stdout) }
      }
      return {
        success: false,
        content: '',
        error: 'grep failed. Install ripgrep: brew install ripgrep',
      }
    } catch {
      return {
        success: false,
        content: '',
        error: 'grep failed. Install ripgrep: brew install ripgrep',
      }
    }
  },
}
