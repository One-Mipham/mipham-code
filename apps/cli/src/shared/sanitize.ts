/**
 * Unicode sanitization for tool inputs.
 * Strips invisible/control characters that could hide command content
 * from visual inspection or enable homoglyph attacks.
 *
 * Protects against hidden command text via tabs/invisible Unicode characters.
 */

const DANGEROUS_UNICODE = /[​‌‍‎‏‪‫‬‭‮⁠⁦⁧⁨⁩﻿]/g

/**
 * Strip dangerous invisible Unicode characters from a string.
 * - Zero-width: U+200B (ZWSP), U+200C (ZWNJ), U+200D (ZWJ), U+200E/F (LTR/RTL marks)
 * - Bidi controls: U+202A-E, U+2066-9
 * - Word joiner: U+2060
 * - BOM: U+FEFF
 */
export function stripDangerousUnicode(input: string): string {
  if (!input) return input
  return input.replace(DANGEROUS_UNICODE, '')
}

/**
 * Recursively sanitize all string values in a params object.
 */
export function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') {
      result[key] = stripDangerousUnicode(value)
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = sanitizeParams(value as Record<string, unknown>)
    } else {
      result[key] = value
    }
  }
  return result
}
