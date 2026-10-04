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

/**
 * Invisible/formatting code points that can hide content.
 *
 * Written as `\u{…}` escapes (hence the `u` flag) so the set is *auditable*: the
 * same list spelled as literal characters is unreviewable in a diff, which is how
 * the tag block (U+E0000–E007F) went missing while every neighbouring family was
 * already covered.
 *
 * Deliberately **not** included — variation selectors (U+FE00–FE0F):
 * - they are load-bearing in emoji (e.g. U+2764 U+FE0F), so stripping them
 *   visibly changes text;
 * - `sanitizeParams` feeds `tool.execute` (`tools/validation.ts`), so the strip is
 *   applied to what tools *write to disk*, not only to what gets pattern-matched.
 *   Adding them here would silently rewrite file contents.
 *
 * Deliberately **not** included — the two joiners, ZWNJ (U+200C) and ZWJ (U+200D),
 * for exactly the reason above. This is why the zero-width part of the set is spelled
 * `\u{200B}\u{200E}-\u{200F}` and *not* the closed range `\u{200B}-\u{200F}` it used to be:
 * - both are load-bearing in *visible* text. ZWNJ attaches a Persian/Arabic suffix to a
 *   Latin word or number (the plural of "PDF"), and ZWJ is what holds a family emoji
 *   together (U+1F468 U+200D U+1F469 U+200D U+1F467) rather than three separate people;
 * - they buy nothing on the permission path either, since no shell ignores them —
 *   `bash -c 'ec<ZWJ>ho hi'` is `command not found` (same for ZWNJ and ZWSP). So removing
 *   them from the set costs no matching protection; it only stops the write path from
 *   rewriting what the user asked us to write.
 *
 * The tag block (U+E0000–E007F) *is* included: it is invisible in itself, and the
 * only sequences that use it (subdivision flags, e.g. U+1F3F4 + a tag run) degrade
 * to the bare black flag — which renders the same.
 */
const DANGEROUS_UNICODE =
  /[\u{061C}\u{115F}-\u{1160}\u{180E}\u{200B}\u{200E}-\u{200F}\u{202A}-\u{202E}\u{2060}\u{2066}-\u{2069}\u{3164}\u{FEFF}\u{FFA0}\u{E0000}-\u{E007F}]/gu

/**
 * Strip dangerous invisible Unicode characters from a string.
 * - Zero-width: U+200B (ZWSP), U+200E/F (LTR/RTL marks) — the joiners U+200C/U+200D are
 *   deliberately kept, see `DANGEROUS_UNICODE`
 * - Bidi controls: U+202A-E, U+2066-9, U+061C (Arabic letter mark)
 * - Word joiner: U+2060
 * - BOM: U+FEFF
 * - Invisible fillers: U+115F/1160 (Hangul choseong/jungseong), U+3164 (Hangul),
 *   U+FFA0 (halfwidth Hangul), U+180E (Mongolian vowel separator)
 * - Tag characters: U+E0000-E007F (deprecated, invisible, hide arbitrary text)
 *
 * See `DANGEROUS_UNICODE` for which *adjacent* families are left in place, and why.
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
 * Decode `&nbsp;` in assistant text for terminal display.
 *
 * The terminal has no markdown/entity layer, so a reply that uses `&nbsp;` to indent
 * — row labels in a table, most often — shows the literal characters. Only this one
 * entity is decoded, deliberately: `&lt;`/`&amp;`/`&gt;` appear in code the assistant
 * is *showing*, where decoding would corrupt the sample, whereas a literal `&nbsp;`
 * meant to be read as text is rare enough to accept. This is a narrow fix for the
 * common case, not a general entity decoder.
 */
export function decodeDisplayEntities(input: string): string {
  if (!input.includes('&')) return input
  return input.replace(/&nbsp;/gi, ' ')
}

/**
 * Make an untrusted **single-line** value safe to interpolate into terminal output.
 *
 * Config-sourced strings (an MCP server's name, URL, or command line) are rendered
 * straight into the transcript. `stripDangerousUnicode` covers the invisible
 * characters but **not** C0 controls, and ESC (U+001B) is one of those — a name
 * carrying `\x1b[2J` is read by the terminal as a clear-screen sequence, not shown
 * as text. DEL (U+007F) goes too.
 *
 * Newlines are stripped as well, unlike `stripControlCharsForCheck` (which keeps
 * `\n` for multi-line shell commands): these values sit on one output line, so an
 * embedded newline forges an extra row in the listing.
 */
export function sanitizeInlineField(input: string): string {
  if (!input) return input
  return stripDangerousUnicode(input).replace(/[\x00-\x1f\x7f]/g, '')
}

/**
 * Control-character stripping for **multi-line** display text — tool output, tool
 * arguments, model prose.
 *
 * `sanitizeInlineField` covers one-line values, but it drops `\n` with everything
 * else: right for a name in a listing, wrong for a command's output, which is
 * legitimately multi-line. This is the same recipe minus that one character.
 *
 * `\n` is what stays — a line break, whose width is measured line by line. `\t` does
 * **not** stay: Ink lays text out with `string-width`, which scores a tab as **0
 * columns**, then writes the tab through to the frame, while the terminal advances a
 * tab to the next tab stop (up to +8 columns). The row ends up wider than the width
 * Ink budgeted and draws over the row below. That a tab cannot move the cursor
 * *backwards* or open an escape sequence is the wrong test — its danger is advancing
 * *unknowingly*. So `\t` → a single space, the same move `stripControlCharsForCheck`
 * makes, so words do not merge. Everything else goes, ESC and DEL included, so a file
 * name or a `printf` payload cannot reach the terminal as CR (overwrite the line —
 * `printf 'safe.txt\rrm -rf /'` shows the second half), BEL, or a CSI/OSC
 * introducer. C1 (U+0080–U+009F) goes with them: its 8-bit CSI is the same
 * introducer in a different encoding.
 *
 * Ink is not a substitute for this. Measured on ink 7.1.1 (`renderToString`): it
 * drops a bare CSI sequence like `\x1b[2J`, but passes CR, BS, BEL, VT, FF, DEL and
 * NUL straight through — and it *parses* SGR, re-emitting `\x1b[8m` (conceal) as
 * `\x1b[28m`. So the sequences that matter here survive it.
 *
 * The cost is real and accepted: colour escapes in tool output (`ls --color`) are
 * dropped, so that text renders uncoloured rather than as invisible markup. Display
 * integrity — that what is shown is what was produced — outranks it.
 */
export function stripControlCharsForDisplay(input: string): string {
  if (!input) return input
  return (
    stripDangerousUnicode(input)
      // `\t` first (→ space), so it cannot reach the terminal as a tab stop jump.
      .replace(/\t/g, ' ')
      .replace(/[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/g, '')
  )
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

/**
 * Neutralize text that is about to be **injected into the system prompt** inside a
 * tag-delimited block (memory recall, session summaries).
 *
 * Two steps, both load-bearing:
 *
 * 1. `stripDangerousUnicode` — the same invisible set the command path applies.
 *    Without it the text can carry an invisible character that hides part of a
 *    delimiter from anything scanning the text, while the model still reads it.
 * 2. Drop `<…>`-shaped runs. The injection point wraps the text in
 *    `<system-reminder>…</system-reminder>`, so an entry whose own text contains
 *    `</system-reminder>` closes that block early and everything after it reads as
 *    ordinary prompt text instead of as recalled data. Stripping the brackets is
 *    what makes the wrapper unforgeable: the text stays readable, it just stops
 *    being able to *end* the block it was pasted into.
 *
 * Same move as `skills/sanitizer.ts` `sanitizeSkillDescription` (which strips
 * `<[^>]*>` for this exact reason); this one additionally strips the invisible set,
 * which the skill path does not. Both are lossy **on purpose** — an injected entry is
 * prose for a model to read, not markup, so no legitimate entry loses meaning.
 *
 * The run is bounded at 200 characters so a stray `<` in prose cannot swallow the
 * rest of the entry, and a letter must follow `<` (or `</`) immediately — so
 * "a < b and c > d" survives while `</system-reminder>` does not. A forged delimiter
 * with a space inside it (`</ system-reminder>`) is not a form this wrapper emits,
 * and buying that case costs every piece of prose containing `< word >`.
 */
export function neutralizeInjectedMarkup(input: string): string {
  if (!input) return input
  return stripDangerousUnicode(input).replace(/<\/?[A-Za-z][^<>]{0,200}>/g, '')
}
