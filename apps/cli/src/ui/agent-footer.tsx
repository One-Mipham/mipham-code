import React from 'react'
import { Box, Text } from 'ink'

export interface AgentEntry {
  id: string
  name: string
  description: string
  startTime: number
  tokensUsed: number
  status: 'running' | 'completed'
}

interface AgentFooterProps {
  agents: AgentEntry[]
  gitBranch: string
  /** Tick counter for live elapsed-time re-renders. */
  tick: number
}

/** Format elapsed seconds into human-readable string (e.g. "2m 51s", "38s"). */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s}s`
}

/** Format token count: 42400 → "42.4k", 1500000 → "1.5M". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function AgentFooter({ agents, gitBranch, tick: _tick }: AgentFooterProps) {
  const hasAgents = agents.length > 0
  const hasBranch = gitBranch.length > 0

  if (!hasAgents && !hasBranch) return null

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Git branch indicator */}
      {hasBranch && (
        <Box>
          <Text dimColor>
            {'  '}⏺ {gitBranch}
          </Text>
        </Box>
      )}

      {/* Agent status lines */}
      {agents.map((agent) => {
        const elapsed = Math.floor((Date.now() - agent.startTime) / 1000)
        const isRunning = agent.status === 'running'
        const symbol = isRunning ? '◯' : '◼'
        const symbolColor = isRunning ? 'cyan' : undefined

        // Truncate description to keep lines readable
        const desc =
          agent.description.length > 80
            ? agent.description.slice(0, 80) + '...'
            : agent.description

        return (
          <Box key={agent.id}>
            <Text dimColor={!isRunning} color={symbolColor}>
              {'  '}
              {symbol}{' '}
            </Text>
            <Text bold color={isRunning ? 'cyan' : undefined} dimColor={!isRunning}>
              {agent.name}
            </Text>
            <Text dimColor>  {desc}</Text>
            {/* Spacer pushes stats to the right — Ink handles this naturally */}
            <Text dimColor>
              {'  '}
              {isRunning ? formatElapsed(elapsed) : 'finished'}
            </Text>
            {isRunning && agent.tokensUsed > 0 && (
              <Text dimColor>
                {' · ↓ '}
                {formatTokens(agent.tokensUsed)} tokens
              </Text>
            )}
          </Box>
        )
      })}
    </Box>
  )
}
