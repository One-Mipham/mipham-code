import type { ToolDefinition, CredentialMaskingConfig } from '../../shared/index.ts'

// Injected at startup — set via index.tsx
let credentialConfig: CredentialMaskingConfig | undefined

export function setCredentialMaskingConfigForBash(config: CredentialMaskingConfig): void {
  credentialConfig = config
}

// ── Dangerous command patterns ──
const BLOCKED_PATTERNS = [
  // Recursive root deletion without preserve-root safeguard
  /\brm\s+-rf\s+\/(\s|$)/,
  /\brm\s+-rf\s+\/\*\s*$/,
  /\bsudo\s+rm\s+.*\//,
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
  // Shell command substitution (commonly used for obfuscation/evasion)
  /\$\(/,
  // Backtick command substitution
  /`[^`]+`/,
  // Interpreter code execution (bypass vector)
  /\bpython3?\s+-c\b/,
  /\bpython3?\s+-m\b/,
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

function isBlocked(command: string): string | null {
  // Normalize ANSI-C escape sequences for defense-in-depth
  const normalized = normalizeEscapes(command)

  // Check exact blocked commands (on normalized command)
  const firstWord = normalized.trim().split(/\s+/)[0]
  if (firstWord && BLOCKED_COMMANDS.includes(firstWord)) {
    return `Command "${firstWord}" rejected by security policy.`
  }

  // Check dangerous patterns (on both original and normalized)
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command) || pattern.test(normalized)) {
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
      })

      const timer = setTimeout(() => proc.kill(), timeout)
      const rawOutput = await new Response(proc.stdout).text()
      const exitCode = await proc.exited
      clearTimeout(timer)

      // ── Credential masking: scrub output ──
      let output = rawOutput
      if (credentialConfig?.enabled && credentialConfig.output_scrubbing.enabled) {
        const { maskOutput } = await import('../../core/credential-masker')
        output = maskOutput(rawOutput, credentialConfig)
      }

      if (exitCode !== 0) {
        const rawStderr = await new Response(proc.stderr).text()
        const stderr =
          credentialConfig?.enabled && credentialConfig.output_scrubbing.enabled
            ? (await import('../../core/credential-masker')).maskOutput(rawStderr, credentialConfig)
            : rawStderr
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
