export type ThinkingMode = 'off' | 'minimal' | 'full'

/**
 * Render the live reasoning/thinking indicator for the given display mode.
 *
 * - `off`     → nothing (hide thinking entirely)
 * - `minimal` → a content-free "💭 <label>…" so long reasoning passes don't
 *               look like a stall, without dumping the model's chain-of-thought
 * - `full`    → the last 200 chars of the actual thinking text (legacy behavior)
 *
 * Returns null when there is no thinking text to show (or mode is `off`).
 */
export function formatThinking(
  mode: ThinkingMode,
  thinkingText: string,
  thinkingLabel: string,
): string | null {
  if (mode === 'off' || !thinkingText) return null
  if (mode === 'minimal') return `💭 ${thinkingLabel}…`
  return `💭 ${thinkingText.slice(-200)}`
}
