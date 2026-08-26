/** Extract the command-name token from a slash filter: "/loop 60s echo hello" → "loop". */
export function commandToken(filter: string): string {
  const withoutSlash = filter.startsWith('/') ? filter.slice(1) : filter
  return withoutSlash.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
}

/** True when the filter carries inline args beyond the command name: "/loop auto" → true, "/loop" → false. */
export function hasInlineArgs(filter: string): boolean {
  return filter.trim().includes(' ')
}
