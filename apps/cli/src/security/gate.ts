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
  { regex: /\$\(.+\)/, label: 'command-substitution' },
  { regex: /`[^`]+`/, label: 'backtick-substitution' },
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
