/**
 * Session-scoped accumulator for graft's token savings. Graft tools emit a
 * "[graft] tokens saved ≈ N" footer on their output; the engine parses that
 * footer after each tool result and adds it here, so the statusline can show
 * "~N tok saved" (mirroring graft's own hooks.js `handleToolSavings`).
 */

/** Sum the "[graft] tokens saved ≈ N" footers in a tool output. */
export function parseGraftSavings(text: string): number {
  let total = 0
  for (const m of text.matchAll(/\[graft\] tokens saved ≈ ([\d,]+)/g)) {
    const digits = m[1]
    if (digits) total += Number(digits.replace(/,/g, '')) || 0
  }
  return total
}

let savings = 0

/** Add a tool result's graft savings to the session running total. */
export function accumulateGraftSavings(text: string): void {
  if (!text) return
  savings += parseGraftSavings(text)
}

/** The session's running graft token savings. */
export function getGraftSavings(): number {
  return savings
}

/** Reset the running total (e.g. on session reset). */
export function resetGraftSavings(): void {
  savings = 0
}
