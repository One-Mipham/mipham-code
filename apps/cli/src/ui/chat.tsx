import React from 'react'
import { Box, Text } from 'ink'
import type { ChatMessage } from './app'

interface ChatPanelProps {
  messages: ChatMessage[]
  focusMode?: boolean
}

export function ChatPanel({ messages, focusMode }: ChatPanelProps) {
  // In focus mode, show only the last user+assistant exchange
  const displayMessages = focusMode
    ? getLastExchange(messages)
    : messages

  return (
    <Box flexDirection="column" marginY={1} flexGrow={1}>
      {focusMode && messages.length > 0 && (
        <Box marginBottom={1}>
          <Text dimColor>
            🔍 Focus mode — showing last exchange only ({displayMessages.length} of {messages.length} messages hidden)
          </Text>
        </Box>
      )}
      {messages.length === 0 && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color="cyan" bold>
              Mipham Code
            </Text>
            <Text dimColor> — AI-Powered Programming Assistant</Text>
          </Box>
          <Text dimColor>
            Multi-model · Multi-provider · Skills & Tools · Open-core
          </Text>
          <Box marginTop={1}>
            <Text dimColor>
              Type a message to start.{' '}
              <Text color="yellow">/help</Text> for commands ·{' '}
              <Text color="yellow">Ctrl+P</Text> pick model ·{' '}
              <Text color="yellow">Esc</Text> to exit
            </Text>
          </Box>
        </Box>
      )}
      {displayMessages.map((msg, i) => (
        <Box key={i} flexDirection="column" marginY={1}>
          <Text
            bold
            color={
              msg.role === 'user'
                ? 'green'
                : msg.role === 'system'
                  ? 'yellow'
                  : 'blue'
            }
          >
            {msg.role === 'user'
              ? '▸ You'
              : msg.role === 'assistant'
                ? 'Mipham Code'
                : '⚠ System'}
            :
          </Text>
          <Text>{msg.content}</Text>
        </Box>
      ))}
    </Box>
  )
}

/**
 * In focus mode, show only the last user→assistant exchange.
 * Walk backwards from the end to find the last user message, then include
 * everything from that point onward.
 */
function getLastExchange(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= 2) return messages

  // Find the last user message index
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      lastUserIdx = i
      break
    }
  }

  if (lastUserIdx === -1) return messages
  return messages.slice(lastUserIdx)
}
