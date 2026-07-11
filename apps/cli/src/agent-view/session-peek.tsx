/**
 * SessionPeek — a popup panel that shows the last few messages of
 * a selected agent session. Invoked by pressing Space on a session row.
 */
import React from 'react'
import { Box, Text } from 'ink'
import type { AgentSession, SessionMessage } from './agent-view-manager'

interface SessionPeekProps {
  session: AgentSession
  recentMessages: SessionMessage[]
}

const ROLE_COLORS: Record<string, string> = {
  user: 'green',
  assistant: 'cyan',
  system: 'yellow',
}

export function SessionPeek({ session, recentMessages }: SessionPeekProps) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="blue" padding={1} marginY={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="blue">
          {' '}
          Peek: {session.id}{' '}
        </Text>
        <Text dimColor>
          — {session.title} · {session.provider}/{session.model}
        </Text>
      </Box>

      {/* Divider */}
      <Box marginBottom={1}>
        <Text dimColor>{'─'.repeat(60)}</Text>
      </Box>

      {/* Messages */}
      {recentMessages.length === 0 ? (
        <Box paddingLeft={2}>
          <Text dimColor>(no messages yet)</Text>
        </Box>
      ) : (
        recentMessages.map((msg, i) => (
          <Box key={i} flexDirection="column" marginBottom={1}>
            <Text color={ROLE_COLORS[msg.role] || 'white'} bold>
              [{msg.role}]
            </Text>
            <Box paddingLeft={4}>
              <Text dimColor>
                {msg.content.length > 120 ? msg.content.slice(0, 120) + '...' : msg.content}
              </Text>
            </Box>
          </Box>
        ))
      )}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>{'─'.repeat(60)}</Text>
      </Box>
      <Box>
        <Text dimColor>
          {' '}
          {recentMessages.length} message(s) · Total: {session.messages.length} · Status:{' '}
          {session.status}
        </Text>
      </Box>
    </Box>
  )
}
