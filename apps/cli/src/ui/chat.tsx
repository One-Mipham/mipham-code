import React from 'react'
import { Box, Text } from 'ink'
import type { ChatMessage } from './app'

interface ChatPanelProps {
  messages: ChatMessage[]
  focusMode?: boolean
}

/** Format cwd for display: replace HOME with ~, truncate if too long */
function displayCwd(): string {
  const cwd = process.cwd()
  const home = process.env.HOME || ''
  if (home && cwd.startsWith(home)) {
    return '~' + cwd.slice(home.length)
  }
  return cwd
}

export function ChatPanel({ messages, focusMode }: ChatPanelProps) {
  // In focus mode, compact tool activity into summary lines
  const displayMessages = focusMode ? compactForFocus(messages) : messages

  return (
    <Box flexDirection="column" marginY={1} flexGrow={1}>
      {focusMode && messages.length > 0 && (
        <Box marginBottom={1}>
          <Text dimColor>
            🔍 Focus — {countHidden(messages, displayMessages)} hidden · /focus to toggle · Ctrl+O
            to expand
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
          <Text dimColor>Multi-model · Multi-provider · Skills & Tools · Open-core</Text>
          <Box marginTop={1}>
            <Text dimColor>
              Type a message to start. <Text color="yellow">/help</Text> for commands ·{' '}
              <Text color="yellow">Ctrl+P</Text> pick model · <Text color="yellow">Esc</Text> to
              exit
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>
              Tip: Use <Text color="yellow">/clear</Text> to start fresh when switching topics and
              free up context
            </Text>
          </Box>
        </Box>
      )}
      {displayMessages.map((msg, i) => (
        <Box
          key={i}
          flexDirection="column"
          marginTop={msg.toolMeta ? 0 : 1}
          marginBottom={msg.toolMeta ? 0 : 1}
        >
          {msg.toolMeta ? (
            <Box flexDirection="column">
              <Text color="yellow">
                {msg.toolMeta.collapsed ? '⏺' : '⏺ ▼'} {msg.toolMeta.name}
              </Text>
              <Text dimColor>{msg.content}</Text>
            </Box>
          ) : (
            <>
              <Text
                bold
                color={msg.role === 'user' ? 'green' : msg.role === 'system' ? 'yellow' : 'blue'}
              >
                {msg.role === 'user'
                  ? `▸ ${displayCwd()}`
                  : msg.role === 'assistant'
                    ? 'Mipham Code'
                    : '⚠ System'}
                :
              </Text>
              <Text>{msg.content}</Text>
            </>
          )}
        </Box>
      ))}
    </Box>
  )
}

/**
 * Compact messages for focus view:
 * - Groups consecutive tool calls into [▶ N tools] ↳ name1 ↳ name2 summary lines
 * - Keeps all user, assistant, and system messages intact
 */
function compactForFocus(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = []
  let toolGroup: ChatMessage[] = []

  for (const msg of messages) {
    if (msg.toolMeta) {
      toolGroup.push(msg)
    } else {
      // Flush pending tool group
      if (toolGroup.length > 0) {
        result.push(summarizeToolGroup(toolGroup))
        toolGroup = []
      }
      result.push(msg)
    }
  }
  // Flush remaining
  if (toolGroup.length > 0) {
    result.push(summarizeToolGroup(toolGroup))
  }

  return result
}

/** Summarize a group of tool calls into a single compact message. */
function summarizeToolGroup(tools: ChatMessage[]): ChatMessage {
  const names = tools.map((t) => t.toolMeta!.name)
  const uniqueNames = [...new Set(names)]
  const toolList = uniqueNames.map((n) => `↳ ${n}`).join('  ')
  return {
    role: 'system',
    content: `[▶ ${tools.length} tool${tools.length > 1 ? 's' : ''}]  ${toolList}`,
    toolMeta: {
      name: `tools (${tools.length})`,
      input: '',
      output: tools.map((t) => t.content).join('\n'),
      collapsed: true,
    },
  }
}

/** Count how many messages are hidden in focus mode. */
function countHidden(all: ChatMessage[], compacted: ChatMessage[]): string {
  const toolCount = all.filter((m) => m.toolMeta).length
  const hidden = all.length - compacted.length
  if (hidden <= 0) return `showing all ${all.length} messages`
  return `${hidden} tool outputs folded (${toolCount} total tool calls)`
}
