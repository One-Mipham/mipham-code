/**
 * Unicode sanitization for tool inputs.
 * Strips invisible/control characters that could hide command content
 * from visual inspection or enable homoglyph attacks.
 *
 * Protects against hidden command text via tabs/invisible Unicode characters.
 *
 * P0-1 (v2.1.223 alignment): Extended to also strip tab, CR, VT, FF,
 * other control characters, and normalize fullwidth/homoglyph characters
 * to ASCII equivalents for permission checks.
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

// ── P0-1: Extended sanitization for permission checks ──

// Fullwidth Latin letters (U+FF21-FF3A → A-Z, U+FF41-FF5A → a-z)
const FULLWIDTH_UPPER_START = 0xff21 // Ａ
const FULLWIDTH_LOWER_START = 0xff41 // ａ
const ASCII_UPPER_START = 0x41 // A
const ASCII_LOWER_START = 0x61 // a

// Fullwidth digits (U+FF10-FF19 → 0-9)
const FULLWIDTH_DIGIT_START = 0xff10 // ０
const ASCII_DIGIT_START = 0x30 // 0

/** Map of fullwidth/homoglyph punctuation to ASCII equivalents */
const FULLWIDTH_PUNCTUATION: Record<number, number> = {
  0xff0f: 0x2f, // ／ → /
  0xff0d: 0x2d, // － → -
  0xff04: 0x24, // ＄ → $
  0xff08: 0x28, // （ → (
  0xff09: 0x29, // ） → )
  0xff01: 0x21, // ！ → !
  0xff20: 0x40, // ＠ → @
  0xff03: 0x23, // ＃ → #
  0xff1a: 0x3a, // ： → :
  0xff1b: 0x3b, // ； → ;
  0xff1c: 0x3c, // ＜ → <
  0xff1e: 0x3e, // ＞ → >
  0xff3b: 0x5b, // ［ → [
  0xff3d: 0x5d, // ］ → ]
  0xff3e: 0x5e, // ＾ → ^
  0xff40: 0x60, // ｀ → `
  0xff5c: 0x7c, // ｜ → |
  0xff5e: 0x7e, // ～ → ~
  0xff07: 0x27, // ＇ → '
  0xff02: 0x22, // ＂ → "
  0xff06: 0x26, // ＆ → &
  0xff0a: 0x2a, // ＊ → *
  0xff0b: 0x2b, // ＋ → +
  0xff0c: 0x2c, // ， → ,
  0xff0e: 0x2e, // ． → .
  0xff1d: 0x3d, // ＝ → =
  0xff05: 0x25, // ％ → %
  0xff3f: 0x5f, // ＿ → _
  0xff5b: 0x7b, // ｛ → {
  0xff5d: 0x7d, // ｝ → }
  0xff3c: 0x5c, // ＼ → \
}

/** Common Unicode homoglyphs to ASCII (NOT fullwidth — separate Unicode blocks) */
const HOMOGLYPH_MAP: Record<number, number> = {
  // Common bypass homoglyphs
  0x0430: 0x61, // Cyrillic а → Latin a
  0x0435: 0x65, // Cyrillic е → Latin e
  0x043e: 0x6f, // Cyrillic о → Latin o
  0x0440: 0x70, // Cyrillic р → Latin p
  0x0441: 0x63, // Cyrillic с → Latin c
  0x0443: 0x79, // Cyrillic у → Latin y
  0x0445: 0x78, // Cyrillic х → Latin x
  0x0456: 0x69, // Cyrillic і → Latin i
  0x03bf: 0x6f, // Greek ο → Latin o
  0x03c1: 0x70, // Greek ρ → Latin p
  0x03bd: 0x76, // Greek ν → Latin v (looks like v)
}

/**
 * Normalize fullwidth Latin letters, digits, and punctuation to ASCII equivalents.
 * Also handles common homoglyph substitutions used in bypass attacks.
 *
 * Only normalizes characters in Latin-script ranges — does NOT affect
 * CJK ideographs, Arabic, Devanagari, or other scripts.
 */
export function normalizeFullwidthAndHomoglyphs(input: string): string {
  if (!input) return input
  let result = ''
  for (let i = 0; i < input.length; i++) {
    const cp = input.codePointAt(i)
    if (cp === undefined) {
      result += input[i]
      continue
    }

    // Fullwidth upper: Ａ-Ｚ → A-Z
    if (cp >= FULLWIDTH_UPPER_START && cp <= FULLWIDTH_UPPER_START + 25) {
      result += String.fromCodePoint(ASCII_UPPER_START + (cp - FULLWIDTH_UPPER_START))
    }
    // Fullwidth lower: ａ-ｚ → a-z
    else if (cp >= FULLWIDTH_LOWER_START && cp <= FULLWIDTH_LOWER_START + 25) {
      result += String.fromCodePoint(ASCII_LOWER_START + (cp - FULLWIDTH_LOWER_START))
    }
    // Fullwidth digits: ０-９ → 0-9
    else if (cp >= FULLWIDTH_DIGIT_START && cp <= FULLWIDTH_DIGIT_START + 9) {
      result += String.fromCodePoint(ASCII_DIGIT_START + (cp - FULLWIDTH_DIGIT_START))
    }
    // Fullwidth punctuation
    else if (FULLWIDTH_PUNCTUATION[cp] !== undefined) {
      result += String.fromCodePoint(FULLWIDTH_PUNCTUATION[cp])
    }
    // Homoglyphs
    else if (HOMOGLYPH_MAP[cp] !== undefined) {
      result += String.fromCodePoint(HOMOGLYPH_MAP[cp])
    }
    // Surrogate pairs (code points > U+FFFF) — skip the low surrogate
    else if (cp > 0xffff) {
      result += input[i]
      i++ // skip next char (low surrogate)
    }
    // Keep everything else as-is
    else {
      result += input[i]
    }
  }
  return result
}

// Regex for control characters that should be stripped from permission-check input.
// Strips: tab (\t), CR (\r), VT (\v), FF (\f), and other control chars
// in ranges 0x01-0x08 and 0x0E-0x1F.
// Preserves: newline (\n, 0x0A) — necessary for multi-line shell commands.
const CONTROL_CHARS_FOR_PERMISSION_CHECK = /[\x00-\x09\x0b\x0c\x0d-\x1f]/g

/**
 * Strip control characters from a command string for permission checking.
 * - Tab (\t) → single space (so words don't merge confusingly)
 * - CR (\r), VT (\v), FF (\f) → removed
 * - Other control chars (0x01-0x08, 0x0E-0x1F) → removed
 * - Newline (\n) is PRESERVED for multi-line commands
 */
export function stripControlCharsForCheck(input: string): string {
  if (!input) return input
  // First, replace tabs with spaces
  let result = input.replace(/\t/g, ' ')
  // Then strip other control chars (but preserve \n)
  result = result.replace(CONTROL_CHARS_FOR_PERMISSION_CHECK, '')
  return result
}

/**
 * Full command sanitization pipeline for permission checks.
 * Applies in order:
 * 1. Strip dangerous invisible Unicode (zero-width, bidi, BOM, etc.)
 * 2. Strip control characters (tab→space, CR/VT/FF→removed)
 * 3. Normalize fullwidth/homoglyph characters to ASCII
 * 4. Collapse multiple spaces
 * 5. Trim
 *
 * This is intended for pattern-matching input only — the original
 * command string should still be used for actual execution.
 */
export function sanitizeCommand(input: string): string {
  if (!input) return input
  let result = input
  result = stripDangerousUnicode(result)
  result = stripControlCharsForCheck(result)
  result = normalizeFullwidthAndHomoglyphs(result)
  // Collapse multiple spaces (but preserve newlines)
  result = result.replace(/ {2,}/g, ' ')
  result = result.trim()
  return result
}

/**
 * Sanitize a command string for UI display.
 * Makes invisible/hidden characters visible so users can see
 * what's actually in the command.
 *
 * - Tab → `→` (visible arrow)
 * - CR → `↵` (carriage return symbol)
 * - Zero-width spaces → `⟨ZWSP⟩`
 */
export function sanitizeForDisplay(input: string): string {
  if (!input) return input
  let result = stripDangerousUnicode(input)
  result = result.replace(/\t/g, '→')
  result = result.replace(/\r/g, '↵')
  result = result.replace(/\v/g, '⟨VT⟩')
  result = result.replace(/\f/g, '⟨FF⟩')
  return result
}
