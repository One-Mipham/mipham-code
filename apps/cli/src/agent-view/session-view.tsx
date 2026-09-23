/**
 * AgentSessionView — where Enter ("attach") in the Agent View dashboard lands.
 *
 * Read-only on purpose. The session's work runs inside its own `SubAgent` with
 * its own context; this CLI has no channel back into that loop, so a view that
 * accepted input would be collecting keystrokes it could not deliver. What this
 * shows is the real thing instead: the transcript the session actually
 * accumulated, kept current through the manager's change notifications.
 *
 * Esc returns to the dashboard.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { AgentViewManager, type SessionStatus } from './agent-view-manager'
import { ChatPanel } from '../ui/chat'

interface AgentSessionViewProps {
  manager: AgentViewManager
  sessionId: string
  onDetach: () => void
}

const STATUS_COLORS: Record<SessionStatus, string> = {
  'needs-input': 'yellow',
  working: 'cyan',
  completed: 'green',
  failed: 'red',
}

const STATUS_LABELS: Record<SessionStatus, string> = {
  'needs-input': 'needs input',
  working: 'working',
  completed: 'completed',
  failed: 'failed',
}

export function AgentSessionView({ manager, sessionId, onDetach }: AgentSessionViewProps) {
  const [version, setVersion] = useState(0)

  // The session keeps running while we look at it — follow it rather than
  // photographing it once at mount.
  useEffect(() => manager.onChange(() => setVersion((v) => v + 1)), [manager])

  const session = useMemo(
    () => manager.get(sessionId),
    // `version` is a dependency so the transcript keeps up with a session that
    // reports new messages while the viewer sits on it.
    [manager, sessionId, version],
  )

  useInput((_input, key) => {
    if (key.escape) onDetach()
  })

  // Esc while the agent view is open is the app's "go back" — but the app-level
  // handler lives in `app.tsx` and only knows its own layers, so this component
  // answers for itself.
  const status = session ? STATUS_LABELS[session.status] : 'gone'
  const statusColor = session ? STATUS_COLORS[session.status] : 'red'

  const transcript = session?.messages ?? []
  const emptyState = useCallback(
    () => (
      <Box paddingLeft={2}>
        <Text dimColor>(no messages yet)</Text>
      </Box>
    ),
    [],
  )

  if (!session) {
    return (
      <Box flexDirection="column" padding={1} height="100%">
        <Text bold color="red">
          Session {sessionId} no longer exists.
        </Text>
        <Box marginTop={1}>
          <Text dimColor>Esc back to Agent View</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" padding={1} height="100%">
      {/* Header */}
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text bold color="cyan">
            Attached
          </Text>
          <Text dimColor> — {session.id}</Text>
        </Box>
        <Box>
          <Text>{session.title}</Text>
          <Text dimColor>
            {' '}
            · {session.provider}/{session.model} · <Text color={statusColor}>{status}</Text>
          </Text>
        </Box>
        {session.branch && (
          <Box>
            <Text dimColor>
              branch {session.branch} · worktree {session.worktree}
            </Text>
          </Box>
        )}
        <Box>
          <Text dimColor>
            {transcript.length} message(s) · read-only transcript · Esc back to Agent View
          </Text>
        </Box>
      </Box>

      {/* Divider */}
      <Box marginBottom={1}>
        <Text dimColor>{'─'.repeat(70)}</Text>
      </Box>

      {/* Transcript */}
      {transcript.length === 0 ? (
        emptyState()
      ) : (
        <ChatPanel messages={transcript} focusMode={false} />
      )}
    </Box>
  )
}
