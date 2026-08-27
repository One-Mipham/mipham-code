// Simple minute-granularity cron expression parser.
//
// Supports the standard 5-field cron format:
//   minute hour day-of-month month day-of-week
//
// Handles: * (wildcard), star/N (step), N (exact), N-M (range), N,M,O (list).
// Falls back to +1 minute if the expression is invalid or no match is found
// within 366 days.

export function computeNextFire(cronExpr: string, from: Date): string {
  const fields = cronExpr.trim().split(/\s+/)
  if (fields.length !== 5) {
    return new Date(from.getTime() + 60_000).toISOString()
  }

  const minField = fields[0]!
  const hourField = fields[1]!
  const domField = fields[2]!
  const monthField = fields[3]!
  const dowField = fields[4]!

  function matches(value: number, field: string): boolean {
    if (field === '*') return true
    // */N step
    const stepMatch = field.match(/^\*\/(\d+)$/)
    if (stepMatch) {
      return value % parseInt(stepMatch[1]!, 10) === 0
    }
    // Comma-separated list
    if (field.includes(',')) {
      return field.split(',').some((f) => matches(value, f))
    }
    // Range
    const rangeMatch = field.match(/^(\d+)-(\d+)$/)
    if (rangeMatch) {
      const low = parseInt(rangeMatch[1]!, 10)
      const high = parseInt(rangeMatch[2]!, 10)
      return value >= low && value <= high
    }
    // Exact value
    return value === parseInt(field, 10)
  }

  const date = new Date(from)
  date.setSeconds(0, 0)
  // Start from the next minute to avoid matching the current minute
  date.setMinutes(date.getMinutes() + 1)

  // Try up to 366 days forward (safety limit — ~527k iterations)
  const maxIterations = 366 * 24 * 60
  for (let i = 0; i < maxIterations; i++) {
    const minute = date.getMinutes()
    const hour = date.getHours()
    const dom = date.getDate()
    const month = date.getMonth() + 1 // JS months are 0-indexed
    const dow = date.getDay() // 0 = Sunday

    if (
      matches(minute, minField) &&
      matches(hour, hourField) &&
      matches(dom, domField) &&
      matches(month, monthField) &&
      matches(dow, dowField)
    ) {
      return date.toISOString()
    }

    date.setMinutes(date.getMinutes() + 1)
  }

  // Fallback: 1 minute from now
  return new Date(from.getTime() + 60_000).toISOString()
}
