/**
 * Format a model's context window (token count) into a friendly unit string.
 * Decimal K/M: 16384 → "16K", 131072 → "131K", 200000 → "200K", 1000000 → "1M".
 * Used only on the developer-facing `/models` command — the first-run model
 * picker deliberately omits context window (raw token counts make Mipham's own
 * models look small next to 1M-context competitors).
 */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return `${tokens}`
}
