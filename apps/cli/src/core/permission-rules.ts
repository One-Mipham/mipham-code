import type { PermissionRuleEntry } from '../shared/index.ts'

// Match a tool(parameter) rule against an actual tool call.
//
// Pattern formats:
//   "Bash"              → matches any Bash call
//   "Bash(git:*)"       → matches "git status", "git diff --cached", etc.
//   "Bash(npm test:*)"  → matches "npm test -- --coverage"
//   "Write(/etc/*)"     → matches Write to /etc/passwd, /etc/hosts, etc.
//   "Read(**/.ssh/*)"   → matches Read of any path under .ssh
//   "Grep(**/vendor)"   → matches Grep rooted under a vendor directory
//   "Glob(**/.ssh)"     → matches Glob rooted under a .ssh directory
export function matchBashRule(
  pattern: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): boolean {
  // Check if pattern has a parenthesized sub-pattern
  const parenMatch = pattern.match(/^(\w+)\((.+)\)$/)
  if (!parenMatch) {
    // Plain tool name match: "Bash", "Write"
    return toolName === pattern
  }

  const [, baseTool, subPattern] = parenMatch

  if (toolName !== baseTool!) return false

  // For Bash: match against the command string
  if (baseTool === 'Bash') {
    const cmd = String(toolInput.command || '')
    return wildcardMatch(subPattern!, cmd.trim())
  }

  // For Write/Edit/Read: match against the file_path
  if (baseTool === 'Write' || baseTool === 'Edit' || baseTool === 'Read') {
    const path = String(toolInput.file_path || '')
    return wildcardMatch(subPattern!, path)
  }

  // For Grep/Glob: match against the base search path (a directory)
  if (baseTool === 'Grep' || baseTool === 'Glob') {
    const path = String(toolInput.path || '')
    return wildcardMatch(subPattern!, path)
  }

  return false
}

export function wildcardMatch(pattern: string, input: string): boolean {
  const regexStr =
    '^' +
    pattern
      .replace(/[.+^${}()|[\]\\*?]/g, '\\$&') // escape regex specials (incl. * and ?)
      .replace(/:/g, '[:\\s]') // : → match colon or whitespace
      .replace(/\\\*/g, '.*') // * → .*
      .replace(/\\\?/g, '.') + // ? → .
    '$'
  return new RegExp(regexStr).test(input)
}

/** Compile a rule pattern string into a PermissionRuleEntry. */
export function compileRule(pattern: string, level: 'allow' | 'deny' | 'ask'): PermissionRuleEntry {
  const regexStr =
    '^' +
    pattern
      .replace(/[.+^${}()|[\]\\*?]/g, '\\$&')
      .replace(/:/g, '[:\\s]')
      .replace(/\\\*/g, '.*')
      .replace(/\\\?/g, '.') +
    '$'
  return { pattern, level, compiled: new RegExp(regexStr) }
}
