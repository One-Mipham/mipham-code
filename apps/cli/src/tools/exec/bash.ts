import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import type { ToolDefinition, CredentialMaskingConfig } from '../../shared/index.ts'
import { sanitizeCommand } from '../../shared/sanitize.ts'
import { DANGEROUS_GIT_PATTERNS } from './git.ts'
import { isUncOrDevicePath, isWithin } from '../../security/path.ts'
import { findWorktreeMarker } from '../../core/paths.ts'
import type { Service } from '../../vajra'
import { toolKey } from '../seam'
import { withValidation } from '../validation'

// ── Dangerous command patterns ──
const BLOCKED_PATTERNS = [
  // Recursive root deletion without preserve-root safeguard
  /\brm\s+-rf\s+\/(\s|$)/,
  /\brm\s+-rf\s+\/\*\s*$/,
  /\bsudo\s+rm\s+.*\//,
  // rm -rf on home directory or any absolute path (relative dirs like node_modules stay allowed)
  /\brm\s+-(?:rf|fr)\s+~(?:$|\s|\/)/,
  /\brm\s+-(?:rf|fr)\s+\/(?![\s*])/,
  // rm -rf on dangerous cwd globs
  /\brm\s+-(?:rf|fr)\s+\*\s*$/,
  /\brm\s+-(?:rf|fr)\s+\.\s*$/,
  // Filesystem manipulation
  /\bmkfs\./,
  /\bdd\s+if=/,
  // Fork bomb
  /:\s*\(\s*\)\s*\{\s*:\s*\|/,
  // Recursive root chmod
  /\bchmod\s+.*(?:777|o\+w|a\+w)\s+\//,
  // Direct block device write
  />\s*\/dev\/sd[a-z]/,
  // SSH private key theft
  /\bcat\s+.*\/\.ssh\/id_/,
  // NOTE: command substitution ($( … ) / `…`) is a legitimate Bash feature, so it is
  // NOT blocked wholesale. The dangerous content inside a substitution (curl|sh,
  // base64 -d, python -c, eval, bash -c, source, …) is still caught by the specific
  // patterns below, which test the whole command string including inside $().
  // Interpreter code execution (bypass vector) — covers python, python2, python3
  /\bpython[23]?\s+-c\b/,
  /\bpython[23]?\s+-m\b/,
  /\bperl\s+-[ep]\b/,
  /\bruby\s+-e\b/,
  /\bnode\s+-e\b/,
  // Reverse shell patterns
  /\bnc\s+.*-e\b/,
  /\bncat\s+.*-e\b/,
  /\bexec\s+\d+<>/,
  // Download + pipe to interpreter
  /\bcurl\s+.*\|\s*(?:ba)?sh\b/,
  /\bwget\s+.*\|\s*(?:ba)?sh\b/,
  /\bcurl\s+.*\|\s*python/,
  /\bwget\s+.*\|\s*python/,
  // Download + execute
  /\bcurl\s+.*-O\s+\/tmp\/.*\s*&&/,
  /\bwget\s+.*-O\s+\/tmp\/.*\s*&&/,
  // Data exfiltration via curl file://
  /\bcurl\s+file:\/\//,
  // SCP exfiltration of sensitive files
  /\bscp\s+.*(?:\.ssh|\.aws|\.env)/,
  // Write to system paths
  />\s*\/(?:etc|usr|boot|sys|proc)\//,
  // P0 hardening — ANSI-C quoting bypass (e.g. $'\x72\x6d' = rm)
  /\$'\\x[0-9a-fA-F]{2}/,
  // P0 hardening — nested interpreter invocation
  /\b(?:bash|sh|zsh|dash|ksh)\s+-c\b/,
  // P0 hardening — eval builtin (obfuscation vector)
  /\beval\s+/,
  // P0 hardening — exec redirect bypass (e.g. exec >/dev/sda)
  /\bexec\s+\d*>/,
  // P0 hardening — source/dot builtin (script sourcing)
  /\bsource\s+/,
  // P0 hardening — base64 decode + pipe
  /\bbase64\s+(?:-d|--decode)\b/,
]

const BLOCKED_COMMANDS = [
  'mkfs',
  'mkfs.ext2',
  'mkfs.ext3',
  'mkfs.ext4',
  'mkfs.xfs',
  'mkfs.btrfs',
  'mkfs.fat',
  'mkfs.vfat',
  'mkswap',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'init',
  'telinit',
  'systemctl',
  'eval',
  'exec',
  'source',
  '.',
]

/**
 * Normalize ANSI-C escape sequences ($'...') in a command string.
 * Converts hex escapes (\xHH) back to literal characters so that
 * existing patterns (e.g. rm -rf /) still catch obfuscated payloads.
 */
function normalizeEscapes(command: string): string {
  return command.replace(/\$'([^']*)'/g, (_, inner: string) =>
    inner.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    ),
  )
}

export function isBlocked(command: string): string | null {
  // Normalize ANSI-C escape sequences for defense-in-depth
  const normalized = normalizeEscapes(command)
  // P0-1: Also sanitize for permission check (strips invisible chars, normalizes homoglyphs)
  const sanitized = sanitizeCommand(command)

  // Check exact blocked commands (on normalized + sanitized)
  const firstWord = normalized.trim().split(/\s+/)[0]
  if (firstWord && BLOCKED_COMMANDS.includes(firstWord)) {
    return `Command "${firstWord}" rejected by security policy.`
  }
  // Also check sanitized first word (catches fullwidth command names after normalization)
  const sanitizedFirstWord = sanitized.trim().split(/\s+/)[0]
  if (
    sanitizedFirstWord &&
    sanitizedFirstWord !== firstWord &&
    BLOCKED_COMMANDS.includes(sanitizedFirstWord)
  ) {
    return `Command "${sanitizedFirstWord}" rejected by security policy.`
  }

  // Detect dangerous git operations invoked via Bash — anywhere in the command,
  // so `echo ok && git push --force` is still caught (not just `^git`).
  // `gh` is deliberately NOT scanned: DANGEROUS_GIT_PATTERNS are all git
  // subcommands (push/reset/clean/…), and scanning `gh` only produced false
  // positives (e.g. `gh issue create --body "...git config user.name..."`).
  if (/(?:^|[\s;&|])(?:sudo\s+)?git\s+/.test(normalized)) {
    for (const { pattern, description } of DANGEROUS_GIT_PATTERNS) {
      if (pattern.test(normalized)) {
        return `Dangerous git command blocked: "${description}". Run manually if intended.`
      }
    }
  }

  // Reject UNC / device-namespace paths — accessing one triggers SMB negotiation
  // on Windows and silently leaks NTLM credentials (Claude Code 2.1.233 CVE-class fix).
  if (isUncOrDevicePath(command) || isUncOrDevicePath(normalized) || isUncOrDevicePath(sanitized)) {
    return `Command rejected: references a UNC or device-namespace path (blocked to prevent NTLM credential leakage).`
  }

  // Check dangerous patterns (on original, normalized, and sanitized)
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command) || pattern.test(normalized) || pattern.test(sanitized)) {
      return `Command rejected by security policy. Pattern matched: ${pattern.source.slice(0, 40)}...`
    }
  }

  return null // safe
}

/**
 * Detect sandbox violations from stderr output.
 * Parses common OS-level error patterns indicating denied access.
 */
export function detectViolations(stderr: string): string[] {
  const violations: string[] = []

  // File access violations
  const accessPatterns = /(?:Permission denied|EACCES|EPERM|Operation not permitted)/gi
  const accessMatches = stderr.match(accessPatterns)
  if (accessMatches && accessMatches.length > 0) {
    // Extract file paths from error messages
    const pathPattern =
      /(?:Permission denied|EACCES|EPERM|Operation not permitted).*?['"]?(\/[^\s'"]+)['"]?/gi
    const paths: string[] = []
    let match: RegExpExecArray | null
    while ((match = pathPattern.exec(stderr)) !== null) {
      paths.push(match[1]!)
    }

    if (paths.length > 0) {
      violations.push(`  File access denied: ${paths.join(', ')}`)
    } else {
      violations.push(`  File access denied (${accessMatches.length} occurrence(s))`)
    }
  }

  // Network access violations
  const netPatterns =
    /(?:Network is unreachable|Connection refused|ECONNREFUSED|ENETUNREACH|Could not resolve host|Name or service not known|ETIMEDOUT|Connection timed out)/gi
  const netMatches = stderr.match(netPatterns)
  if (netMatches && netMatches.length > 0) {
    // Extract host:port from error messages
    const hostPattern =
      /(?:connect to|Could not resolve host|Failed to connect to)\s+([^\s:]+(?::\d+)?)/gi
    const hosts: string[] = []
    let match: RegExpExecArray | null
    while ((match = hostPattern.exec(stderr)) !== null) {
      hosts.push(match[1]!)
    }

    if (hosts.length > 0) {
      violations.push(`  Network access denied: ${hosts.join(', ')}`)
    } else {
      violations.push(`  Network access denied (${netMatches.length} occurrence(s))`)
    }
  }

  return violations
}

/**
 * Vibe coding: Parse stderr output for error locations (file path + line + column).
 * Supports common tool formats: TypeScript, ESLint, pytest, Rust, Go, Prettier, etc.
 * Returns up to 10 unique locations sorted by file then line.
 */
interface ErrorLocation {
  file: string
  line: number
  col?: number
  message?: string
}

function parseErrorLocations(stderr: string): ErrorLocation[] {
  const locations: ErrorLocation[] = []

  // TypeScript / ESLint / Prettier: path(line,col): message
  // e.g., src/foo.ts(42,10): error TS2304: Cannot find name 'foo'
  const tsPattern = /([^\s(]+)\((\d+),(\d+)\):\s*(.+)/g
  let match: RegExpExecArray | null
  let m: RegExpExecArray | null
  while ((m = tsPattern.exec(stderr)) !== null) {
    locations.push({
      file: m[1]!,
      line: parseInt(m[2]!),
      col: parseInt(m[3]!),
      message: (m[4] || '').slice(0, 120),
    })
  }

  // pytest / Python: path:line: message
  // e.g., tests/test_foo.py:42: AssertionError: ...
  const pyPattern = /([^\s:]+\.py):(\d+):\s*(.+)/g
  while ((match = pyPattern.exec(stderr)) !== null) {
    const pm = match
    locations.push({
      file: pm[1]!,
      line: parseInt(pm[2]!),
      message: (pm[3] || '').slice(0, 120),
    })
  }

  // Rust: --> path:line:col
  // e.g., --> src/main.rs:42:10
  const rustPattern = /-->\s*([^\s:]+):(\d+):(\d+)/g
  while ((match = rustPattern.exec(stderr)) !== null) {
    const rm = match
    locations.push({
      file: rm[1]!,
      line: parseInt(rm[2]!),
      col: parseInt(rm[3]!),
    })
  }

  // Go: path:line:col: message
  // e.g., ./main.go:42:10: undefined: foo
  const goPattern = /([^\s:]+\.go):(\d+):(\d+):\s*(.+)/g
  while ((match = goPattern.exec(stderr)) !== null) {
    const gm2 = match
    locations.push({
      file: gm2[1]!,
      line: parseInt(gm2[2]!),
      col: parseInt(gm2[3]!),
      message: (gm2[4] || '').slice(0, 120),
    })
  }

  // Generic: path:line (any file extension)
  // e.g., src/foo.ts:42
  const genericPattern = /([^\s:]+\.[a-zA-Z]{1,6}):(\d+)\b/g
  while ((match = genericPattern.exec(stderr)) !== null) {
    const gm = match
    const file = gm[1]!
    // Skip if we already have this exact location from a more specific pattern
    const alreadyHave = locations.some((l) => l.file === file && l.line === parseInt(gm[2]!))
    if (!alreadyHave) {
      locations.push({ file, line: parseInt(match[2]!) })
    }
  }

  // Deduplicate and sort: same file+line → keep first
  const seen = new Set<string>()
  const unique: ErrorLocation[] = []
  for (const loc of locations) {
    const key = `${loc.file}:${loc.line}`
    if (!seen.has(key)) {
      seen.add(key)
      unique.push(loc)
    }
  }

  // Sort by file path then line number
  unique.sort((a, b) => {
    const fileCmp = a.file.localeCompare(b.file)
    return fileCmp !== 0 ? fileCmp : a.line - b.line
  })

  return unique.slice(0, 10)
}

/**
 * 找出命令里第一个 `cd` 到工作区之外的**目标原样字符串**（供错误文案用）；
 * 无逃逸返回 null。判定边界是 `worktreeRoot`（项目根），不是 `cwd` ——
 * 既有行为即如此：`cd <项目内其它目录>` 放行（见 test/tools/exec.test.ts
 * 「allows cd inside the project from a .mipham worktree」）。
 *
 * 此前三个缺陷，其中两个是活的绕过：
 *  - 相对路径用字符串拼接而非 `resolve`：`cd ../../../..` 拼出来的串仍以
 *    cwd 开头，于是被当成「在区内」放行 —— **活绕过**；
 *  - `command.match(...)` 非全局，只看第一个 `cd`，`cd sub && cd /etc` 的
 *    后半段完全不检查 —— **活绕过**；
 *  - 归属判定用 `resolved.startsWith(cwd)` 字符串前缀比较，`/proj/w1-evil`
 *    会被判成「在 /proj/w1 里」；它只被 root 那个析取项兜住才没显形，故一并
 *    改成按路径分段比较的 `isWithin`。
 */
export function resolveWorktreeEscape(
  cwd: string,
  worktreeRoot: string,
  command: string,
): string | null {
  const cdRe = /\bcd\s+(?:"([^"]+)"|'([^']+)'|([^\s;|&]+))/g
  for (const m of command.matchAll(cdRe)) {
    const target = m[1] ?? m[2] ?? m[3]
    if (!target) continue
    const resolved = resolve(cwd, target)
    if (!isWithin(resolved, cwd) && !isWithin(resolved, worktreeRoot)) return target
  }
  return null
}

export function createBashTool(credentialConfig?: CredentialMaskingConfig): ToolDefinition {
  return {
    name: 'Bash',
    description:
      'Execute a bash command. Returns stdout and stderr. Timeout: 120s. Use with caution.',
    category: 'exec',
    permission: 'ask',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
        description: {
          type: 'string',
          description: 'What this command does, in plain words (do not echo the command itself)',
        },
        timeout: {
          type: 'integer',
          description: 'Timeout in milliseconds (max 600000)',
        },
      },
      required: ['command'],
    },
    async execute(params, ctx) {
      const command = params.command as string
      const requestedTimeout = params.timeout as number | undefined
      // A negative timeout is not "no timeout". `Math.min(-1 || 120_000, 600_000)` is `-1`,
      // and `setTimeout(fn, -1)` is clamped to **1 ms** — so the command is group-killed on
      // the spot and reported as a bare `Exit code 137` (measured with real bun). Node does
      // warn, but only on stderr, where the model never sees it. Refuse rather than silently
      // reinterpret; `0`, `NaN` and `undefined` already fall back to the default via `||`.
      if (typeof requestedTimeout === 'number' && requestedTimeout < 0) {
        return {
          success: false,
          content: '',
          error:
            `timeout must not be negative (got ${requestedTimeout}ms). ` +
            `Omit it for the 120000ms default.`,
        }
      }
      const timeout = Math.min(requestedTimeout || 120_000, 600_000)

      // P0-4: Worktree isolation — block cd escape attempts
      // 标记取自 core/paths.ts：新目录与历史 .claude/worktrees/ 都认，
      // 隔离度只增不减（只认新前缀会让旧工作树失去保护）。
      const worktreeMarker = findWorktreeMarker(ctx.cwd)
      if (worktreeMarker) {
        const escapeTarget = resolveWorktreeEscape(ctx.cwd, worktreeMarker.root, command)
        if (escapeTarget !== null) {
          return {
            success: false,
            content: '',
            error:
              `Worktree isolation: cannot cd outside worktree directory. ` +
              `Attempted: ${escapeTarget}. Use tools within the worktree only.`,
          }
        }
      }

      // Security: check command against deny list
      const blockedReason = isBlocked(command)
      if (blockedReason) {
        return { success: false, content: '', error: blockedReason }
      }

      try {
        // ── Credential masking: filter sensitive env vars ──
        let spawnEnv: Record<string, string | undefined> | undefined
        if (credentialConfig?.enabled && credentialConfig.env_filter.enabled) {
          const { filterEnv } = await import('../../core/credential-masker')
          spawnEnv = filterEnv(process.env as Record<string, string | undefined>, credentialConfig)
        }

        const proc = Bun.spawn(['bash', '-c', command], {
          cwd: ctx.cwd,
          stdout: 'pipe',
          stderr: 'pipe',
          env: spawnEnv,
          // Own process group. Required for the group kill below to reach
          // grandchildren — and for it to target *our* group at all: without
          // this the child inherits the parent's pgid, so `kill(-pid)` aims at
          // the wrong group and fails (or, worse, hits the parent's).
          detached: true,
        })

        // Start reading at once — a child that fills the pipe buffer blocks on
        // write and would then never exit — but do **not** await here: if a
        // descendant inherits the pipe and outlives the shell, EOF never comes,
        // and awaiting this before `exited` is what hung the call for good.
        const stdoutRead = new Response(proc.stdout).text()
        const stderrRead = new Response(proc.stderr).text()

        // Remember whether we were the ones who killed it: the exit code is 137 and
        // stderr is empty either way, so the model cannot tell a timeout from the
        // command's own failure (measured with real bun — both are `Exit code 137: `).
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          killProcessGroup(proc.pid)
        }, timeout)
        const exitCode = await proc.exited
        clearTimeout(timer)

        // The shell is gone, so only a pipe-holding descendant can still be
        // holding these up. Released by the group kill, at most once.
        let released = false
        const release = () => {
          if (released) return
          released = true
          killProcessGroup(proc.pid)
        }
        const rawOutput = await settlePipe(stdoutRead, release)
        // Read stderr for violation detection and error reporting
        const rawStderr = await settlePipe(stderrRead, release)

        // ── Credential masking: scrub output ──
        let output = rawOutput
        if (credentialConfig?.enabled && credentialConfig.output_scrubbing.enabled) {
          const { maskOutput } = await import('../../core/credential-masker')
          output = maskOutput(rawOutput, credentialConfig)
        }

        // ── Sandbox violation detection ──
        const violations = detectViolations(rawStderr)

        if (exitCode !== 0) {
          const stderr =
            credentialConfig?.enabled && credentialConfig.output_scrubbing.enabled
              ? (await import('../../core/credential-masker')).maskOutput(
                  rawStderr,
                  credentialConfig,
                )
              : rawStderr
          let errorContent = output.slice(0, 5_000)
          if (violations.length > 0) {
            errorContent += '\n\n── Sandbox Violations ──\n' + violations.join('\n')
          }
          // Vibe coding fix: auto-parse error locations from stderr
          const errorLocations = parseErrorLocations(rawStderr)
          if (errorLocations.length > 0) {
            errorContent +=
              '\n\n── Error Locations (for quick fix) ──\n' +
              errorLocations
                .map(
                  (l) =>
                    `  ${l.file}:${l.line}` +
                    (l.col ? `:${l.col}` : '') +
                    (l.message ? ` — ${l.message}` : ''),
                )
                .join('\n')
          }
          return {
            success: false,
            content: errorContent,
            error: timedOut
              ? `Command timed out after ${timeout}ms (killed): ${stderr.slice(0, 1_000)}`
              : `Exit code ${exitCode}: ${stderr.slice(0, 1_000)}`,
          }
        }

        let successContent = output.slice(0, 100_000) || '(no output)'
        if (violations.length > 0) {
          successContent += '\n\n── Sandbox Violations ──\n' + violations.join('\n')
        }
        return { success: true, content: successContent }
      } catch (err) {
        // A missing `cwd` and a missing `bash` both surface as the *same*
        // `ENOENT: no such file or directory, posix_spawn 'bash'` (measured), which reads
        // as "bash is not installed" and points the model at the wrong root cause. The cwd
        // is the one we can actually check — so check it, and only claim it when it is
        // genuinely absent, or a truly missing bash would get relabelled as a bad cwd.
        const code = (err as NodeJS.ErrnoException | undefined)?.code
        return {
          success: false,
          content: '',
          error:
            code === 'ENOENT' && !existsSync(ctx.cwd)
              ? `Working directory does not exist: ${ctx.cwd}`
              : `Command failed: ${String(err)}`,
        }
      }
    },
  }
}

/** Grace given to a descendant still holding the output pipe after the shell itself has exited. */
const PIPE_GRACE_MS = 1_000

/**
 * Kill a whole process group. `proc.kill()` reaches only the direct child, so a
 * `bash -c` that spawned its own children leaves them orphaned and unnotified.
 * The negative pid addresses the group led by that pid, which exists only when
 * the child was spawned `detached` — verified on this host: without it the
 * child's pgid is the *parent's* group, and this call fails with ESRCH rather
 * than reaching the grandchildren.
 */
export function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined || pid <= 0) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (err: unknown) {
    // ESRCH: the group is already gone, which is the normal case when the
    // command finished on its own. Anything else means a group kill isn't
    // available here, so fall back to the direct child.
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

/**
 * Await an already-started pipe read, but not forever. A descendant that
 * inherited the pipe keeps EOF from arriving, and that read is what used to
 * hang the call after the command itself had finished. Once the grace expires,
 * take the group down — which closes the pipe — and finish the read.
 */
async function settlePipe<T>(read: Promise<T>, release: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stalled = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), PIPE_GRACE_MS)
  })
  const winner = await Promise.race([read, stalled])
  clearTimeout(timer)
  if (winner !== null) return winner
  release()
  return read
}

export const bashToolService: Service = {
  inject: ['credentials'],
  apply(ctx) {
    const credentialConfig = ctx.get<CredentialMaskingConfig>('credentials')
    ctx.provide(toolKey('Bash'), withValidation(createBashTool(credentialConfig)))
  },
}
