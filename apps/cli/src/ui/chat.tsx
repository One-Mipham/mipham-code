import React from 'react'
import { Box, Text } from 'ink'
import type { ChatMessage } from './app'

interface ChatPanelProps {
  messages: ChatMessage[]
}

export function ChatPanel({ messages }: ChatPanelProps) {
  return (
    <Box flexDirection="column" marginY={1} flexGrow={1}>
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
      {messages.map((msg, i) => (
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
