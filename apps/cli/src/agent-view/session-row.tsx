/**
 * SessionRow — a single row in the Agent View dashboard.
 * Shows provider, model, task, and elapsed time for one background agent session.
 */
import React from 'react'
import { Box, Text } from 'ink'
import type { AgentSession } from './agent-view-manager'

interface SessionRowProps {
  session: AgentSession
  isSelected: boolean
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return '<1s'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSecs = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainingSecs}s`
  const hours = Math.floor(minutes / 60)
  const remainingMin = minutes % 60
  return `${hours}h ${remainingMin}m`
}

const STATUS_COLORS: Record<string, string> = {
  'needs-input': 'yellow',
  working: 'cyan',
  completed: 'green',
  failed: 'red',
}

const STATUS_LABELS: Record<string, string> = {
  'needs-input': '[INPUT]',
  working: '[WORK] ',
  completed: '[DONE] ',
  failed: '[FAIL] ',
}

export function SessionRow({ session, isSelected }: SessionRowProps) {
  const color = STATUS_COLORS[session.status] || 'white'
  const label = STATUS_LABELS[session.status] || ''
  const prefix = isSelected ? '❯' : ' '

  const taskPreview = session.task.length > 60 ? session.task.slice(0, 60) + '...' : session.task

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={isSelected ? 'blue' : undefined} bold={isSelected}>
          {prefix}{' '}
        </Text>
        <Text color={color}>{label}</Text>
        <Text> </Text>
        <Text bold={isSelected}>{session.id}</Text>
        <Text dimColor>
          {' '}
          · {session.provider}/{session.model}
        </Text>
        <Text dimColor> · {formatElapsed(session.elapsedMs)}</Text>
      </Box>
      <Box paddingLeft={isSelected ? 4 : 3}>
        <Text dimColor={!isSelected} color={isSelected ? 'white' : undefined}>
          {taskPreview}
        </Text>
        {session.title !== session.task.slice(0, 60) && <Text dimColor> — {session.title}</Text>}
      </Box>
    </Box>
  )
}
