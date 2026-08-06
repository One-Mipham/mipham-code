/**
 * Template literal tag that strips leading indentation from multi-line strings.
 * Used by slash command handlers to format help text and status messages.
 */
export function stripIndent(strings: TemplateStringsArray, ...values: unknown[]): string {
  let result = strings.reduce((acc, s, i) => acc + s + (values[i] ?? ''), '')
  // Remove leading newline
  result = result.replace(/^\n/, '')
  // Find minimum indent
  const match = result.match(/^( +)/m)
  if (match?.[1]) {
    const indent = match[1].length
    result = result
      .split('\n')
      .map((line) => line.slice(indent))
      .join('\n')
  }
  return result.trim()
}
