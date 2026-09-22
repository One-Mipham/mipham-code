import { homedir } from 'node:os'
import { parse } from 'node:path'
import type { ToolDefinition, CredentialMaskingConfig } from '../../shared/index.ts'
import { resolveSafe } from '../../security/path'
import type { Service } from '../../vajra'
import { toolKey } from '../seam'
import { withValidation } from '../validation'
import { maskSearchOutput } from '../../core/credential-masker'

/** Grep stall guard: a search over a huge tree (or a pathological regex) must
 *  not hang the session for minutes. Matches the Bash tool's 120s ceiling. */
const GREP_TIMEOUT_MS = 120_000

/** Run a search command with a kill-timer; report whether the timeout fired. */
export async function runSearch(
  cmd: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; timedOut: boolean; exitCode: number | null }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutMs)
  // 两条管道必须**并发**读。先读满 stdout 再读 stderr 会在子进程写满
  // stderr（~64 KB 管道缓冲）时死锁：它阻塞在 write 上不退出，stdout 也就
  // 永远读不到 EOF —— 只能等超时兜底，而超时会把「慢」和「错」说成同一件事。
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  clearTimeout(timer)
  return { stdout, stderr, timedOut, exitCode: proc.exitCode }
}

/** grep 输出上限：超过则显式截断并附标记（不能静默丢内容——模型会误以为看全了）。 */
const GREP_MAX_OUTPUT_CHARS = 50_000

/** 截断 grep 输出：超限时加 "(truncated)" 标记，避免静默截断。 */
export function truncateGrepOutput(stdout: string): string {
  const out = stdout || '(no matches)'
  if (out.length <= GREP_MAX_OUTPUT_CHARS) return out
  return `${out.slice(0, GREP_MAX_OUTPUT_CHARS)}\n\n... (truncated)`
}

/**
 * 判断搜索根是否是「顶层目录」（家目录或文件系统根）。这类范围扫描的是海量
 * 文件树（macOS ~/Library 有数百万受保护文件），会让 rg exit 2、find 回退卡
 * 满 120s。顶层范围应 fail-fast，让模型指定项目目录，而不是静默全盘扫。
 */
export function isTopLevelScope(searchPath: string, home = homedir()): boolean {
  return searchPath === home || searchPath === parse(searchPath).root
}

/** 把未知异常变成一句可读的原因（`code` 才是可操作的部分：ENOENT / EAGAIN）。 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code
    return typeof code === 'string' ? `${code}: ${err.message}` : err.message
  }
  return String(err)
}

/**
 * 只有「rg 不在 PATH」才该回退到 `find`。别的异常（EAGAIN / EPERM / spawn
 * 失败）说明 rg 装了却起不来 —— 那不是回退能解决的问题，再起一个 find 只会
 * 换来第二个失败，而错误信息里的「去装 ripgrep」会把排查方向整条带偏。
 */
function isMissingBinary(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if ((err as { code?: unknown }).code === 'ENOENT') return true
  // 有些抛出方只给句子不给 code。
  return /ENOENT|not found|no such file or directory/i.test(err.message)
}

export function createGrepTool(credentialConfig?: CredentialMaskingConfig): ToolDefinition {
  return {
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
    permission: 'self',
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

      // Scope guard: a top-level search root (home or filesystem root) scans an
      // enormous tree and stalls the find fallback for minutes. Fail fast and
      // ask for a project-scoped path instead of silently scanning everything.
      if (!params.path && isTopLevelScope(searchPath)) {
        return {
          success: false,
          content: '',
          error:
            `Search scope is the home directory / filesystem root (${searchPath}) — too large ` +
            'and contains protected directories. Specify a project directory with "path", ' +
            'or cd into the project first.',
        }
      }

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
        if (exitCode === 0) {
          return {
            success: true,
            content: truncateGrepOutput(
              maskSearchOutput(stdout || '(no matches)', credentialConfig, 'heading'),
            ),
          }
        }
        // rg exit 2 (error, e.g. permission denied on protected dirs) — do NOT
        // fall back to the slow `find -type f` scan (it hits the same unreadable
        // paths and stalls on huge trees). Return partial matches if any, else
        // a clear narrow-scope error.
        if (stdout && stdout.trim()) {
          return {
            success: true,
            // 先截断正文、再拼注解：注解拼在截断之内的话，它自己会被切掉，
            // 模型拿到的就是一句没头没尾的提示。
            content:
              truncateGrepOutput(maskSearchOutput(stdout, credentialConfig, 'heading')) +
              '\n\n(rg exited 2 — some paths unreadable; narrow scope for complete results)',
          }
        }
        return {
          success: false,
          content: '',
          error:
            'rg error (exit 2) — likely permission denied on a large/protected tree. ' +
            'Narrow scope with "path" (project directory) and "include".',
        }
      } catch (err) {
        if (!isMissingBinary(err)) {
          return {
            success: false,
            content: '',
            error: `ripgrep failed: ${describeError(err)}`,
          }
        }
        // rg not installed → fall through to grep (find + grep fallback)
      }

      // 2. fallback: `find -type f -exec grep -Hn {} +`
      //    `-type f` skips symlinks (file and dir) so the fallback can't follow
      //    one out of the workspace — macOS BSD `grep -r` follows symlinks and
      //    would leak target contents, unlike ripgrep's default no-follow.
      const grepArgs = [
        'find',
        searchPath,
        '-type',
        'f',
        '-exec',
        'grep',
        '-Hn',
        pattern,
        '{}',
        '+',
      ]
      try {
        const { stdout, stderr, timedOut, exitCode } = await runSearch(
          grepArgs,
          ctx.cwd,
          GREP_TIMEOUT_MS,
        )
        if (timedOut) {
          return {
            success: false,
            content: '',
            error: `Grep timed out after ${GREP_TIMEOUT_MS / 1000}s — narrow scope with "path" and "include".`,
          }
        }
        // 退出码 1 在 find 这里是**两件事**：真的没搜到，和「根本没搜成」
        // —— 目录不可读、grep 正则非法、grep 不在 PATH，BSD find 全都退 1。
        // 后者一律伴随 stderr，所以用 stderr 而非退出码分辨；不加这一刀，
        // 模型会被告知「没有匹配」，而真相是这次搜索压根没跑起来。
        if (exitCode === 1) {
          const err = stderr.trim()
          if (err) {
            return { success: false, content: '', error: `Search failed: ${err.slice(0, 500)}` }
          }
          return { success: true, content: '(no matches)' }
        }
        if (exitCode === 0) {
          return {
            success: true,
            content: truncateGrepOutput(maskSearchOutput(stdout, credentialConfig, 'filename')),
          }
        }
        return {
          success: false,
          content: '',
          error:
            `grep failed (exit ${exitCode})` +
            (stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : '') +
            '. Install ripgrep: brew install ripgrep',
        }
      } catch (err) {
        // 这里回退自己起不来 —— 报回退的真实原因，别再断言「rg 没装」
        // （走到这一步的路径本来就有「rg 没装」和「装了但起不来」两种）。
        return {
          success: false,
          content: '',
          error: `Search failed to start: ${describeError(err)}`,
        }
      }
    },
  }
}

export const grepToolService: Service = {
  inject: ['credentials'],
  apply(ctx) {
    const credentialConfig = ctx.get<CredentialMaskingConfig>('credentials')
    ctx.provide(toolKey('Grep'), withValidation(createGrepTool(credentialConfig)))
  },
}
