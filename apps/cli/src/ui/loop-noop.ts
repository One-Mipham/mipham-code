/**
 * /loop idle-wakeup folding — collapse consecutive noop ticks into a single
 * "💤 idle ×N" line so repeated "nothing to report" wakeups don't spam the UI.
 */
export function collapseNoopTicks(ticks: Array<{ noop: boolean }>): string {
  const lines: string[] = []
  let i = 0
  while (i < ticks.length) {
    const tick = ticks[i]!
    if (tick.noop) {
      let count = 0
      while (i < ticks.length && ticks[i]!.noop) {
        count++
        i++
      }
      lines.push(`💤 idle ×${count}`)
    } else {
      lines.push('● active')
      i++
    }
  }
  return lines.join('\n')
}
