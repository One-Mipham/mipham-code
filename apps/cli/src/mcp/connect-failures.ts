export interface McpConnectFailure {
  name: string
  reason: string
}

/**
 * Format a startup notice for MCP servers that failed to connect, so the model
 * knows their tools are unavailable (instead of concluding the tools don't
 * exist). Empty string when nothing failed.
 */
export function formatMcpConnectFailures(failures: McpConnectFailure[]): string {
  if (failures.length === 0) return ''
  const list = failures.map((f) => `- ${f.name}: ${f.reason}`).join('\n')
  return `[MCP] These MCP servers failed to connect — their tools are unavailable:\n${list}`
}
