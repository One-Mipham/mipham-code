/**
 * Template literal tag that strips leading indentation from multi-line strings.
 * Used by slash command handlers to format help text and status messages.
 */
export function stripIndent(strings: TemplateStringsArray, ...values: unknown[]): string {
  let result = strings.reduce((acc, s, i) => acc + s + (values[i] ?? ''), '')
  // Remove leading newline
  result = result.replace(/^\n/, '')
  // Minimum indent across non-empty lines. Taking the FIRST line's indent (the
  // old behaviour) chops characters off every interpolated line that was
  // indented less — `join('\n')` values lost their first letters on lines 2..n.
  const indents = result
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.match(/^ */)![0].length)
  const indent = indents.length > 0 ? Math.min(...indents) : 0
  if (indent > 0) {
    result = result
      .split('\n')
      .map((line) => line.slice(indent))
      .join('\n')
  }
  return result.trim()
}
