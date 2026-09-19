/**
 * SecurityGate — 判定函数集合。
 *
 * ⚠️ **本文件不是一个已生效的安全门。** 它是一个**判定函数的库**，其中只有一部分
 * 被接进生产路径。别把「文件被 import」读成「这些检查在生产里跑」：
 *
 * - `redactCredentialLeak` — **已接线**（`core/behavior-tasks.ts`、
 *   `core/credential-masker/output-scrub.ts`）。
 * - 其余三个 `check*` 方法 — **生产零调用点**，唯一消费者是
 *   `test/security/penetration/`。因此 CI 的 `penetration-test` job 全绿只说明
 *   **这些判定函数被自己测过**，不说明生产有这三道防线。三条各自的去路（为什么不接、
 *   生产另有哪条防线）登记在
 *   `test/integrity/unwired-disposition.test.ts` 的 `KEPT_UNWIRED_METHODS` 里，
 *   由机器两向强制（存在 + 生产零引用）。
 *
 * 想让某条真正生效时：先读那条登记的理由，再决定是接线还是改判据 —— 直接 `import`
 * 进来调是最容易的一步，也是最容易多出一道更弱、更难维护、判据还与被取代者不一致的门。
 */
export interface GateResult {
  blocked: boolean
  reason?: string
}

const PROMPT_INJECTION_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  {
    regex: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)/i,
    label: 'ignore-previous-instructions',
  },
  {
    regex: /^system\s*:\s*(now\s+)?(act|pretend|you\s+are)/im,
    label: 'role-impersonation',
  },
  {
    regex: /(^|\n)(---\s*BEGIN|<\|\w+\|>)/,
    label: 'delimiter-injection',
  },
  {
    regex: /you\s+are\s+now\s+(dan|jailbroken|unrestricted)/i,
    label: 'dan-jailbreak',
  },
  {
    regex:
      /(disregard|override|supersede)\s+(all\s+)?(previous|prior|above|system)\s+(instructions?|rules?|prompts?)/i,
    label: 'override-instructions',
  },
]

const DANGEROUS_BASH_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  // NOTE: command substitution ($( … ) / `…`) is legitimate Bash syntax and is NOT
  // blocked here — its dangerous content (a pipe to sh/bash, a chained rm/cat/sh,
  // …) is still caught by the pipe/chain patterns below.
  { regex: /;\s*(rm|cat|sh|bash)\b/, label: 'command-chain-injection' },
  { regex: /curl.+\|\s*(sh|bash)\b/, label: 'curl-pipe-shell' },
  { regex: /\|\s*(sh|bash)\b/, label: 'pipe-to-shell' },
  { regex: />\s*\/dev\//, label: 'redirect-to-dev' },
]

const API_KEY_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /sk-ant-[a-zA-Z0-9_-]{20,}/, label: 'anthropic-key' },
  { regex: /sk-[a-zA-Z0-9]{32,}/, label: 'openai-key' },
  { regex: /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}/, label: 'jwt-token' },
  { regex: /x-api-key:\s*[a-zA-Z0-9_-]{20,}/i, label: 'api-key-header' },
]

export class SecurityGate {
  static checkPromptInjection(input: string): GateResult {
    if (!input || input.length < 10) return { blocked: false }
    for (const pattern of PROMPT_INJECTION_PATTERNS) {
      if (pattern.regex.test(input)) {
        return { blocked: true, reason: `prompt injection detected: ${pattern.label}` }
      }
    }
    return { blocked: false }
  }

  static checkPathTraversal(path: string, _cwd: string): GateResult {
    if (!path) return { blocked: false }
    if (/\0/.test(path)) {
      return { blocked: true, reason: 'null byte in path' }
    }
    if (/%25|%2e%2e/i.test(path)) {
      return { blocked: true, reason: 'double-encoded path traversal' }
    }
    const segments = path.replace(/\\/g, '/').split('/')
    for (const seg of segments) {
      if (seg === '..') {
        return { blocked: true, reason: 'path traversal attempt (..)' }
      }
    }
    return { blocked: false }
  }

  static checkBashCommand(command: string): GateResult {
    if (!command) return { blocked: false }
    for (const pattern of DANGEROUS_BASH_PATTERNS) {
      if (pattern.regex.test(command)) {
        return { blocked: true, reason: `dangerous bash pattern: ${pattern.label}` }
      }
    }
    return { blocked: false }
  }

  static checkCredentialLeak(output: string): GateResult {
    if (!output || output.length < 10) return { blocked: false }
    for (const pattern of API_KEY_PATTERNS) {
      if (pattern.regex.test(output)) {
        return { blocked: true, reason: `credential leak detected: ${pattern.label}` }
      }
    }
    return { blocked: false }
  }

  /** Redact known API-key-shaped tokens from output (defense-in-depth beyond config patterns). */
  static redactCredentialLeak(output: string): string {
    if (!this.checkCredentialLeak(output).blocked) return output
    let out = output
    for (const { regex } of API_KEY_PATTERNS) {
      out = out.replace(new RegExp(regex.source, 'gi'), '[REDACTED]')
    }
    return out
  }
}
