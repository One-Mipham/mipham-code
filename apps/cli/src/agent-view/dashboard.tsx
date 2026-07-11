/**
 * AgentViewDashboard — Ink TUI for background agent session management.
 *
 * Displays sessions grouped by status (needs-input / working / completed / failed),
 * with j/k navigation, Space peek, Enter attach, and Esc exit.
 *
 * Usage:
 *   mipham agents          (from CLI)
 *   /agents                (from slash command within a running session)
 */
import React, { useState, useCallback, useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
import { AgentViewManager, type AgentSession, type SessionStatus } from './agent-view-manager'
import { SessionRow } from './session-row'
import { SessionPeek } from './session-peek'

interface DashboardProps {
  manager: AgentViewManager
  onAttach?: (session: AgentSession) => void
  onExit: () => void
}

const STATUS_HEADERS: Record<string, { label: string; color: string }> = {
  'needs-input': { label: 'Needs Input', color: 'yellow' },
  working: { label: 'Working', color: 'cyan' },
  completed: { label: 'Completed', color: 'green' },
  failed: { label: 'Failed', color: 'red' },
}

export function AgentViewDashboard({ manager, onAttach, onExit }: DashboardProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [peekingSessionId, setPeekingSessionId] = useState<string | null>(null)

  // Build a flat list of sessions in group order, with group headers
  const flatList = useMemo(() => {
    const groups = manager.groupByStatus()
    const result: Array<
      | { type: 'header'; status: string; label: string; color: string; count: number }
      | { type: 'session'; session: AgentSession }
    > = []

    const statusOrder: Array<keyof typeof STATUS_HEADERS> = [
      'working',
      'needs-input',
      'completed',
      'failed',
    ]

    for (const _status of statusOrder) {
      const status = _status as SessionStatus
      const sessions = groups[status] ?? []
      result.push({
        type: 'header',
        status,
        label: STATUS_HEADERS[status]!.label,
        color: STATUS_HEADERS[status]!.color,
        count: sessions.length,
      })

      for (const session of sessions) {
        result.push({ type: 'session', session })
      }
    }

    return result
  }, [manager])

  // Flatten sessions only for navigation (skip headers)
  const sessionsOnly = useMemo(
    () =>
      flatList.filter((item) => item.type === 'session') as Array<{
        type: 'session'
        session: AgentSession
      }>,
    [flatList],
  )

  const handleAttach = useCallback(
    (sessionId: string) => {
      const session = manager.attach(sessionId)
      if (session && onAttach) {
        onAttach(session)
      }
    },
    [manager, onAttach],
  )

  useInput((input, key) => {
    if (key.escape) {
      if (peekingSessionId) {
        setPeekingSessionId(null)
        return
      }
      onExit()
      return
    }

    if (input === 'j') {
      setSelectedIndex((prev) => Math.min(prev + 1, sessionsOnly.length - 1))
      setPeekingSessionId(null)
      return
    }

    if (input === 'k') {
      setSelectedIndex((prev) => Math.max(prev - 1, 0))
      setPeekingSessionId(null)
      return
    }

    // Space — toggle peek
    if (input === ' ') {
      if (sessionsOnly.length === 0) return
      const current = sessionsOnly[selectedIndex]
      if (!current) return
      setPeekingSessionId(peekingSessionId === current.session.id ? null : current.session.id)
      return
    }

    // Enter — attach to selected session
    if (key.return) {
      if (sessionsOnly.length === 0) return
      const current = sessionsOnly[selectedIndex]
      if (!current) return
      if (peekingSessionId) {
        handleAttach(current.session.id)
      } else {
        handleAttach(current.session.id)
      }
      return
    }
  })

  // Compute the peek data for the currently peeking session
  const peekData = useMemo(() => {
    if (!peekingSessionId) return null
    return manager.peek(peekingSessionId) ?? null
  }, [manager, peekingSessionId])

  const totalSessions = sessionsOnly.length
  const counts = manager.countByStatus()

  return (
    <Box flexDirection="column" padding={1} height="100%">
      {/* Header */}
      <Box marginBottom={1} flexDirection="column">
        <Box>
          <Text bold color="cyan">
            Agent View
          </Text>
          <Text dimColor> — Background Agent Dashboard</Text>
        </Box>
        <Box>
          <Text dimColor>
            {totalSessions} session{totalSessions !== 1 ? 's' : ''}
            {' · '}
            <Text color="cyan">{counts.working} working</Text>
            {' · '}
            <Text color="yellow">{counts['needs-input']} input</Text>
            {' · '}
            <Text color="green">{counts.completed} done</Text>
            {' · '}
            <Text color="red">{counts.failed} failed</Text>
          </Text>
        </Box>
        <Box>
          <Text dimColor>j/k navigate · Space peek · Enter attach · Esc back</Text>
        </Box>
      </Box>

      {/* Divider */}
      <Box marginBottom={1}>
        <Text dimColor>{'─'.repeat(70)}</Text>
      </Box>

      {/* Empty state */}
      {totalSessions === 0 ? (
        <Box flexDirection="column" paddingY={2} paddingLeft={2}>
          <Text dimColor>No background agents.</Text>
          <Text dimColor>
            Use the Agent tool or type &quot;run this in background&quot; to spawn one.
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {/* Session list with group headers */}
          {flatList.map((item, flatIdx) => {
            if (item.type === 'header') {
              return (
                <Box key={`h-${item.status}`} marginY={1}>
                  <Text bold color={item.color}>
                    {' '}
                    {item.label} ({item.count})
                  </Text>
                </Box>
              )
            }

            // Map this session's position in sessionsOnly to selectedIndex
            const sessionIdx = sessionsOnly.findIndex((s) => s.session.id === item.session.id)

            return (
              <SessionRow
                key={item.session.id}
                session={item.session}
                isSelected={sessionIdx === selectedIndex}
              />
            )
          })}
        </Box>
      )}

      {/* Peek panel (shown below the list when peeking) */}
      {peekData && (
        <SessionPeek session={peekData.session} recentMessages={peekData.recentMessages} />
      )}
    </Box>
  )
}
