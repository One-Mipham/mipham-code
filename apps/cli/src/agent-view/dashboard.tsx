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
import React, { useState, useCallback, useEffect, useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import { AgentViewManager, type AgentSession, type SessionStatus } from './agent-view-manager'
import { SessionRow } from './session-row'
import { SessionPeek } from './session-peek'
import { useCtrlCConfirm } from '../ui/ctrl-c-confirm'
import { getBackgroundAgentRegistry } from '../agent/background-registry'

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
  const [groupBy, setGroupBy] = useState<'status' | 'directory'>('status')
  const [feedback, setFeedback] = useState<string | null>(null)
  // Bump to force flatList recompute after the session set changes.
  const [version, setVersion] = useState(0)
  // Non-null while the rename box is open; holds the row being renamed + the draft.
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null)

  // Ctrl+C 的「再按一次才退」，与主界面同源（见 ui/ctrl-c-confirm.ts）
  const ctrlC = useCtrlCConfirm()

  // Flash a brief feedback message that auto-clears
  const showFeedback = useCallback((msg: string) => {
    setFeedback(msg)
    setTimeout(() => setFeedback(null), 1800)
  }, [])

  // The mutations that matter happen outside this component: `/bg` and `/fork`
  // resolve their executors long after the keystroke that spawned them, so a
  // run that finishes while this panel is open used to leave the row — and the
  // header counts — frozen at whatever they were when the panel mounted.
  useEffect(() => manager.onChange(() => setVersion((v) => v + 1)), [manager])

  // Build a flat list of sessions in group order, with group headers
  const flatList = useMemo(() => {
    const result: Array<
      | { type: 'header'; key: string; label: string; color: string; count: number }
      | { type: 'session'; session: AgentSession }
    > = []

    if (groupBy === 'directory') {
      for (const group of manager.groupByDirectory()) {
        result.push({
          type: 'header',
          key: `dir-${group.directory}`,
          label: group.directory,
          color: 'blue',
          count: group.sessions.length,
        })

        for (const session of group.sessions) {
          result.push({ type: 'session', session })
        }
      }
    } else {
      const groups = manager.groupByStatus()
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
          key: `status-${status}`,
          label: STATUS_HEADERS[status]!.label,
          color: STATUS_HEADERS[status]!.color,
          count: sessions.length,
        })

        for (const session of sessions) {
          result.push({ type: 'session', session })
        }
      }
    }

    return result
  }, [manager, groupBy, version])

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

  // Commit the open rename box. Empty title cancels — a session with no name is
  // indistinguishable in the list, so the box refuses rather than writing ''.
  const handleRenameSubmit = useCallback(
    (value: string) => {
      const id = renaming?.id
      setRenaming(null)
      if (!id) return
      const title = value.trim()
      if (!title) {
        showFeedback('Rename cancelled — title cannot be empty')
        return
      }
      manager.rename(id, title)
      showFeedback(`Renamed to ${title}`)
    },
    [manager, renaming, showFeedback],
  )

  useInput((input, key) => {
    // While the rename box is open it owns the keyboard: the list keys below
    // must not fire on the same keystroke that is being typed into the title
    // (Ink delivers every key to every mounted useInput).
    if (renaming) {
      if (key.escape || (key.ctrl && input === 'c')) {
        setRenaming(null)
        ctrlC.reset()
        showFeedback('Rename cancelled')
      }
      return
    }

    // Ctrl+C 不再一下就退出（Ink 的 `exitOnCtrlC` 已在 render 处关掉，见
    // src/index.tsx）：第一次只提示，再按一次才走。面板里 Esc 已经是退出键，
    // 所以这里只补「误按一次不带走整个面板」。
    if (key.ctrl && input === 'c') {
      if (peekingSessionId) {
        setPeekingSessionId(null)
        ctrlC.reset()
        return
      }
      if (ctrlC.isArmed()) {
        onExit()
        return
      }
      ctrlC.arm()
      showFeedback('Ctrl+C again to exit')
      return
    }

    if (key.escape) {
      if (peekingSessionId) {
        setPeekingSessionId(null)
        return
      }
      onExit()
      return
    }

    // Ctrl+T — toggle group by (status ↔ directory)
    if (key.ctrl && input === 't') {
      setGroupBy((prev) => (prev === 'status' ? 'directory' : 'status'))
      showFeedback(`Grouped by ${groupBy === 'status' ? 'directory' : 'status'}`)
      return
    }

    // Ctrl+R — open the rename box on the selected session
    if (key.ctrl && input === 'r') {
      if (sessionsOnly.length === 0) {
        showFeedback('No sessions to rename')
        return
      }
      const current = sessionsOnly[selectedIndex]
      if (!current) return
      // Seeded with the current title: renaming is usually an edit, and a box
      // that opens blank silently invites the user to retype a whole task name.
      setRenaming({ id: current.session.id, draft: current.session.title })
      return
    }

    // Ctrl+X — stop the selected session's work (if any) and drop its row
    if (key.ctrl && input === 'x') {
      if (sessionsOnly.length === 0) {
        showFeedback('No sessions to remove')
        return
      }
      const current = sessionsOnly[selectedIndex]
      if (!current) return
      const session = current.session
      // Discarding a row whose work is still running would throw away the only
      // handle to it — the manager's own `kill()` flips a status label and
      // stops nothing, and the running sub-agent checks the registry's abort
      // signal. So: stop the task, then remove the row.
      const stopped = session.taskId ? getBackgroundAgentRegistry().stop(session.taskId) : false
      manager.remove(session.id)
      setPeekingSessionId(null)
      setSelectedIndex((prev) => Math.max(0, Math.min(prev, sessionsOnly.length - 2)))
      showFeedback(
        stopped
          ? `Stopped + removed ${session.title || session.id}`
          : `Removed ${session.title || session.id}`,
      )
      return
    }

    if (input === 'j') {
      if (sessionsOnly.length === 0) {
        showFeedback('No sessions to navigate — spawn a background agent first')
        return
      }
      setSelectedIndex((prev) => Math.min(prev + 1, sessionsOnly.length - 1))
      setPeekingSessionId(null)
      return
    }

    if (input === 'k') {
      if (sessionsOnly.length === 0) {
        showFeedback('No sessions to navigate — spawn a background agent first')
        return
      }
      setSelectedIndex((prev) => Math.max(prev - 1, 0))
      setPeekingSessionId(null)
      return
    }

    // Space — toggle peek
    if (input === ' ') {
      if (sessionsOnly.length === 0) {
        showFeedback('No sessions to peek')
        return
      }
      const current = sessionsOnly[selectedIndex]
      if (!current) return
      setPeekingSessionId(peekingSessionId === current.session.id ? null : current.session.id)
      return
    }

    // Enter — attach to selected session
    if (key.return) {
      if (sessionsOnly.length === 0) {
        showFeedback('No sessions to attach — spawn a background agent first')
        return
      }
      const current = sessionsOnly[selectedIndex]
      if (!current) return
      handleAttach(current.session.id)
      return
    }
  })

  // Compute the peek data for the currently peeking session
  const peekData = useMemo(() => {
    if (!peekingSessionId) return null
    return manager.peek(peekingSessionId) ?? null
    // `version` is a dependency so an open peek keeps up with a session that
    // reports new messages while the viewer sits on it.
  }, [manager, peekingSessionId, version])

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
          <Text dimColor>
            j/k navigate · Space peek · Enter attach · Ctrl+T group · Ctrl+R rename · Ctrl+X remove
            · Esc back
          </Text>
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
          {feedback && (
            <Box marginTop={1}>
              <Text color="yellow" dimColor>
                ⚡ {feedback}
              </Text>
            </Box>
          )}
        </Box>
      ) : (
        <Box flexDirection="column">
          {/* Session list with group headers */}
          {flatList.map((item, _flatIdx) => {
            if (item.type === 'header') {
              return (
                <Box key={`h-${item.key}`} marginY={1}>
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

      {/* Rename box — opens on Ctrl+R, owns the keyboard until Enter/Esc */}
      {renaming && (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="single"
          borderColor="cyan"
          padding={1}
        >
          <Text dimColor>Rename session — Enter to save · Esc to cancel</Text>
          <Box>
            <Text color="cyan">{'> '}</Text>
            <TextInput
              value={renaming.draft}
              onChange={(draft) => setRenaming((cur) => (cur ? { ...cur, draft } : cur))}
              onSubmit={handleRenameSubmit}
            />
          </Box>
        </Box>
      )}

      {/* Feedback toast — flashes briefly on action */}
      {feedback && (
        <Box marginTop={1}>
          <Text color="yellow" dimColor>
            ⚡ {feedback}
          </Text>
        </Box>
      )}
    </Box>
  )
}
