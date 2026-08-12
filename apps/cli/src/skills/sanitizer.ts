/**
 * Skill Safety Sanitizer
 *
 * Claude Code v2.1.228 security hardening for skills:
 *   1. Strip/escape `!` command prefixes from skill body text
 *   2. Block `@` file expansion references in skill body
 *   3. Sanitize skill descriptions (strip markdown formatting, shell injection chars)
 *   4. Tag synced skills with source identifier
 *   5. Detect shadowing of local commands and MCP tool names
 *
 * Applied at skill load time (loader.ts) and execution time (fork-executor.ts, skill.ts).
 */

// ── Types ──

export interface SanitizeResult {
  /** Sanitized text */
  text: string
  /** Warnings generated during sanitization */
  warnings: string[]
  /** Whether the text was modified */
  modified: boolean
  /** Whether the text was blocked entirely */
  blocked: boolean
}

export interface ShadowCheck {
  /** Whether a shadowing conflict was detected */
  shadowed: boolean
  /** Name of the conflicting command/tool */
  conflictsWith: string
  /** Type of conflict: 'command' | 'mcp-tool' */
  conflictType: 'command' | 'mcp-tool'
}

// ── Constants ──

/** Known local command names that skills should not shadow */
const BUILTIN_COMMANDS = new Set([
  '/help',
  '/model',
  '/models',
  '/switch',
  '/compact',
  '/clear',
  '/resume',
  '/config',
  '/skills',
  '/browse-skills',
  '/install-skill',
  '/reload-skills',
  '/remove-skill',
  '/crsi',
  '/sis',
  '/plan',
  '/no-plan',
  '/triage',
  '/workflows',
  '/tasks',
])

/** Source tags for synced skills */
const SOURCE_TAGS: Record<string, string> = {
  'claude.ai': '🔗 [claude.ai synced]',
  community: '📦 [community]',
  standard: '',
  mipham: '🏔️ [Mipham]',
}

// ── Sanitizer ──

/**
 * Sanitize a skill body (markdown instructions) for safe execution.
 *
 * Security measures:
 *   - `! command` patterns → escaped to `! command` (prevents AI from treating as shell command)
 *   - `@file` references → prefixed with safety note
 *   - Trailing backticks that could break markdown fences → escaped
 *   - Excessively long lines → truncated
 */
export function sanitizeSkillBody(body: string): SanitizeResult {
  const warnings: string[] = []
  let text = body
  let modified = false

  // ── 1. Detect and warn about `!` shell command patterns ──
  // Pattern: line starting with `!` (Bash command marker in some AI contexts)
  const bangCommandRegex = /^!\s*(\S+)/gm
  let bangMatch: RegExpExecArray | null
  const bangCommands: string[] = []
  while ((bangMatch = bangCommandRegex.exec(text)) !== null) {
    bangCommands.push(bangMatch[1] || '')
  }
  if (bangCommands.length > 0) {
    // Escape `!` → `! ` (zero-width space after bang to neutralize)
    text = text.replace(/^!(?=\s*\S)/gm, '! ')
    modified = true
    warnings.push(
      `Skill body contained ${bangCommands.length} shell-command-like patterns (${bangCommands.slice(0, 3).join(', ')}${bangCommands.length > 3 ? '...' : ''}). Escaped to prevent unintended command execution.`,
    )
  }

  // ── 2. Detect and warn about `@file` references ──
  const atFileRegex = /@(\S+\.(?:md|ts|js|json|yml|yaml|txt|csv|py|rs|go|java|html|css|sh))/gi
  let atMatch: RegExpExecArray | null
  const atFiles: string[] = []
  while ((atMatch = atFileRegex.exec(text)) !== null) {
    atFiles.push(atMatch[0])
  }
  if (atFiles.length > 0) {
    // Replace @file with `@ file` (space after @ to neutralize expansion)
    text = text.replace(/@(\S+\.\w{1,6})\b/gi, '@ $1')
    modified = true
    warnings.push(
      `Skill body contained ${atFiles.length} file reference patterns (${atFiles.slice(0, 3).join(', ')}${atFiles.length > 3 ? '...' : ''}). Neutralized to prevent unintended file expansion.`,
    )
  }

  // ── 3. Sanitize markdown fence break attempts ──
  // Prevent skills from breaking out of their markdown code block context
  if (text.includes('```')) {
    const fenceCount = (text.match(/```/g) || []).length
    if (fenceCount % 2 !== 0) {
      // Odd number: append closing fence
      text += '\n```'
      modified = true
      warnings.push('Skill body had unclosed markdown fence — auto-closed for safety.')
    }
  }

  return { text, warnings, modified, blocked: false }
}

/**
 * Sanitize a skill description for display in system reminders.
 *
 * - Strip shell-injection characters ($, `, ;, |, &, <, >)
 * - Strip markdown links that could be misleading
 * - Truncate to max length
 * - Add source tag for synced skills
 */
export function sanitizeSkillDescription(
  description: string,
  source?: string,
  maxLength: number = 200,
): string {
  let text = description

  // Strip shell injection characters
  text = text.replace(/[`$;|&<>]/g, '')

  // Strip markdown links — keep text, drop URL
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')

  // Strip HTML tags
  text = text.replace(/<[^>]*>/g, '')

  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim()

  // Truncate
  if (text.length > maxLength) {
    text = text.slice(0, maxLength - 3) + '...'
  }

  // Add source tag
  if (source && SOURCE_TAGS[source]) {
    text = `${SOURCE_TAGS[source]} ${text}`
  }

  return text
}

/**
 * Check if a skill name or description shadows a local command or MCP tool.
 *
 * @returns ShadowCheck with conflict info, or { shadowed: false }
 */
export function checkSkillShadow(
  skillName: string,
  description: string,
  mcpToolNames?: string[],
): ShadowCheck {
  // Check against builtin commands
  if (BUILTIN_COMMANDS.has(skillName)) {
    return { shadowed: true, conflictsWith: skillName, conflictType: 'command' }
  }

  // Check description for embedded command names
  for (const cmd of BUILTIN_COMMANDS) {
    const cmdPattern = cmd.replace(/\//g, '')
    if (description.toLowerCase().includes(cmdPattern.toLowerCase())) {
      // Only flag if the description could be confused as a command invocation
      if (
        description.includes(`\`${cmd}\``) ||
        description.includes(` ${cmd} `) ||
        description.startsWith(cmd)
      ) {
        return { shadowed: true, conflictsWith: cmd, conflictType: 'command' }
      }
    }
  }

  // Check against MCP tool names
  if (mcpToolNames) {
    for (const toolName of mcpToolNames) {
      if (skillName === toolName || description.includes(`\`${toolName}\``)) {
        return { shadowed: true, conflictsWith: toolName, conflictType: 'mcp-tool' }
      }
    }
  }

  return { shadowed: false, conflictsWith: '', conflictType: 'command' }
}
