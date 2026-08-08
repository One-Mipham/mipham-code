import type { ToolDefinition } from '../../shared/index.ts'
import { discoverSessions } from '../../agent/cross-session/discovery'

export const listAgentsTool: ToolDefinition = {
  name: 'ListAgents',
  description:
    'Discover active Mipham Code sessions running on this machine. ' +
    'Returns session ID, name, machine, working directory, provider, and model for each session. ' +
    'Use with SendMessage to communicate across sessions.',
  category: 'agent',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['local', 'all'],
        default: 'local',
        description: 'Discovery scope. "local" scans this machine only. "all" is reserved for future network discovery.',
      },
    },
  },
  async execute(params) {
    const scope = (params.scope as string) || 'local'

    if (scope === 'all') {
      return {
        success: true,
        content:
          'Network discovery is not yet available. Showing local sessions only.\n\n' +
          formatSessionList(discoverSessions()),
      }
    }

    const sessions = discoverSessions()

    if (sessions.length === 0) {
      return {
        success: true,
        content: 'No active Mipham Code sessions found on this machine.',
      }
    }

    return {
      success: true,
      content: formatSessionList(sessions),
    }
  },
}

function formatSessionList(sessions: import('../../shared/types').SessionInfo[]): string {
  const lines: string[] = [`${sessions.length} active session(s):\n`]

  for (const s of sessions) {
    const modelInfo = s.model ? ` · ${s.model}` : ''
    const providerInfo = s.provider ? ` (${s.provider})` : ''
    lines.push(`  ${s.id}`)
    lines.push(`    Name:    ${s.name}`)
    lines.push(`    Machine: ${s.machine}${modelInfo}${providerInfo}`)
    lines.push(`    PID:     ${s.pid} · Started: ${s.startedAt}`)
    if (s.cwd) lines.push(`    CWD:     ${s.cwd}`)
    lines.push('')
  }

  return lines.join('\n').trim()
}
