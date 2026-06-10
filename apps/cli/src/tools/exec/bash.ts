import type { ToolDefinition } from '../shared/index.ts'

// ── Dangerous command patterns ──
const BLOCKED_PATTERNS = [
  // Recursive root deletion without preserve-root safeguard
  /\brm\s+-rf\s+\/(\s|$)/,
  /\brm\s+-rf\s+\/\*\s*$/,
  // Filesystem manipulation
  /\bmkfs\./,
  /\bdd\s+if=/,
  // Fork bomb
  /:\s*\(\s*\)\s*\{\s*:\s*\|/,
  // Recursive root chmod
  /\bchmod\s+.*777\s+\//,
  // Direct block device write
  />\s*\/dev\/sd[a-z]/,
  // SSH private key theft
  /\bcat\s+.*\/\.ssh\/id_/,
]

const BLOCKED_COMMANDS = [
  'mkfs',
  'mkfs.ext2', 'mkfs.ext3', 'mkfs.ext4',
  'mkfs.xfs', 'mkfs.btrfs', 'mkfs.fat', 'mkfs.vfat',
  'mkswap',
]

function isBlocked(command: string): string | null {
  // Check exact blocked commands
  const firstWord = command.trim().split(/\s+/)[0]
  if (firstWord && BLOCKED_COMMANDS.includes(firstWord)) {
    return `Command "${firstWord}" is blocked (destructive filesystem operation).`
  }

  // Check dangerous patterns
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return `Command rejected by security policy. Pattern matched: ${pattern.source.slice(0, 40)}...`
    }
  }

  return null // safe
}

export const bashTool: ToolDefinition = {
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
        description: 'What this command does (for audit log)',
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
    const timeout = Math.min((params.timeout as number) || 120_000, 600_000)

    // Security: check command against deny list
    const blockedReason = isBlocked(command)
    if (blockedReason) {
      return { success: false, content: '', error: blockedReason }
    }

    try {
      const proc = Bun.spawn(['bash', '-c', command], {
        cwd: ctx.cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      })

      const timer = setTimeout(() => proc.kill(), timeout)
      const output = await new Response(proc.stdout).text()
      const exitCode = await proc.exited
      clearTimeout(timer)

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text()
        return {
          success: false,
          content: output.slice(0, 5_000),
          error: `Exit code ${exitCode}: ${stderr.slice(0, 1_000)}`,
        }
      }

      return { success: true, content: output.slice(0, 100_000) || '(no output)' }
    } catch (err) {
      return {
        success: false,
        content: '',
        error: `Command failed: ${String(err)}`,
      }
    }
  },
}
