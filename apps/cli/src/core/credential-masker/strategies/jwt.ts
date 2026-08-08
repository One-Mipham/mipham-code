import type { MaskingStrategy } from '../types'
import type { CredentialFileRule, JwtMaskingRule } from '../../../shared/index.ts'

export class JwtMaskingStrategy implements MaskingStrategy {
  readonly name = 'jwt'

  canHandle(rule: CredentialFileRule): rule is JwtMaskingRule {
    return 'type' in rule && rule.type === 'jwt'
  }

  mask(content: string, rule: JwtMaskingRule): string {
    return content
      .split('\n')
      .map((line) => this.maskLine(line, rule))
      .join('\n')
  }

  private maskLine(line: string, rule: JwtMaskingRule): string {
    const trimmed = line.trim()

    // Check if this looks like a JWT (three base64url segments separated by dots)
    const segments = trimmed.split('.')
    if (segments.length !== 3) return line

    // Verify each segment is base64url
    const b64urlRegex = /^[A-Za-z0-9_-]+$/
    if (!segments.every((s) => b64urlRegex.test(s))) return line

    try {
      const header = segments[0]!
      const payload = segments[1]!
      const signature = segments[2]!

      // Decode payload
      const decodedPayload = this.decodeBase64Url(payload)
      let payloadObj: Record<string, unknown>
      try {
        payloadObj = JSON.parse(decodedPayload)
      } catch {
        return line // Not valid JSON — not a JWT
      }

      // Mask specified claims
      let modified = false
      for (const claim of rule.maskClaims) {
        if (claim in payloadObj) {
          payloadObj[claim] = '[MASKED]'
          modified = true
        }
      }

      if (!modified) return line

      // Re-encode payload
      const newPayload = this.encodeBase64Url(JSON.stringify(payloadObj))
      return `${header}.${newPayload}.${signature}`
    } catch {
      return line // Decode failure — return unchanged
    }
  }

  private decodeBase64Url(str: string): string {
    // Convert base64url to base64
    const base64 = str.replace(/-/g, '+').replace(/_/g, '/')
    // Pad
    const padded = base64 + '==='.slice(0, (4 - (base64.length % 4)) % 4)
    // Decode
    return Buffer.from(padded, 'base64').toString('utf-8')
  }

  private encodeBase64Url(str: string): string {
    const base64 = Buffer.from(str, 'utf-8').toString('base64')
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
}
