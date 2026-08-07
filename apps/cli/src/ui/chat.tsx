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

/** Map tool names to dot colors — Claude Code parity */
function toolColor(name: string): string {
  switch (name) {
    case 'Bash':
    case 'Read':
    case 'Glob':
    case 'Grep':
      return 'white'
    case 'Write':
    case 'Edit':
      return 'red'
    case 'Agent':
    case 'Task':
    case 'Skill':
    case 'Workflow':
      return 'magenta'
    case 'WebSearch':
    case 'WebFetch':
      return 'blue'
    default:
      return 'white'
  }
}

/**
 * Memoized single message row — skips re-render when content hasn't changed.
 * This prevents O(n) re-renders of the entire chat history on every streaming chunk.
 * The custom comparator returns true (skip render) when content, role, and collapse
 * state are identical to the previous render.
 */
const MessageRow = React.memo(
  function MessageRow({ msg }: { msg: ChatMessage; isLast: boolean }) {
    return (
      <Box
        flexDirection="column"
        marginTop={msg.toolMeta ? 0 : 1}
        marginBottom={msg.toolMeta ? 0 : 1}
      >
        {msg.toolMeta ? (
          <Box flexDirection="column">
            <Text color={toolColor(msg.toolMeta.name)}>
              {msg.toolMeta.collapsed ? '⏺' : '⏺ ▼'} {msg.toolMeta.name}
              {msg.toolMeta.input ? `(${msg.toolMeta.input.slice(0, 120)})` : ''}
            </Text>
            {msg.toolMeta.output ? (
              <Text dimColor> ⎿ {msg.toolMeta.output.slice(0, 300)}</Text>
            ) : msg.content && !msg.toolMeta.collapsed ? (
              <Text dimColor>{msg.content}</Text>
            ) : null}
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
    )
  },
  (prev, next) =>
    prev.msg.content === next.msg.content &&
    prev.msg.role === next.msg.role &&
    prev.msg.toolMeta?.collapsed === next.msg.toolMeta?.collapsed,
)

export function ChatPanel({ messages, focusMode }: ChatPanelProps) {
  // Group consecutive tool calls into compact summaries to reduce visual noise.
  // In focus mode, use the more aggressive compactForFocus.
  const displayMessages = focusMode ? compactForFocus(messages) : compactToolGroups(messages)

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
        <MessageRow
          key={`${i}-${msg.role}-${typeof msg.content === 'string' ? msg.content.length : 0}`}
          msg={msg}
          isLast={i === displayMessages.length - 1}
        />
      ))}
    </Box>
  )
}

/**
 * Group consecutive tool calls into compact one-liners for the normal view.
 * Single tools show normally; 2+ consecutive tools get folded:
 *   ⏺ Read · Glob · Bash (3 tools)
 */
function compactToolGroups(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = []
  let toolGroup: ChatMessage[] = []

  const flush = () => {
    if (toolGroup.length === 0) return
    if (toolGroup.length === 1) {
      result.push(toolGroup[0]!)
    } else {
      const names = toolGroup
        .filter((t) => t.toolMeta?.name && !t.toolMeta.name.startsWith('tools ('))
        .map((t) => t.toolMeta!.name)
      const uniqueNames = [...new Set(names)]
      result.push({
        role: 'system',
        content: `⏺ ${uniqueNames.join(' · ')} (${names.length} tools)`,
        toolMeta: {
          name: `tools (${names.length})`,
          input: uniqueNames.join(', '),
          collapsed: true,
        },
      })
    }
    toolGroup = []
  }

  for (const msg of messages) {
    // Tool results (no name, has output) get folded into the preceding tool group
    if (msg.toolMeta && !msg.toolMeta.name && msg.toolMeta.output) {
      toolGroup.push(msg)
      continue
    }
    // Tool calls with a name
    if (msg.toolMeta?.name && !msg.toolMeta.name.startsWith('tools (')) {
      toolGroup.push(msg)
      continue
    }
    // Already-grouped or non-tool message
    flush()
    result.push(msg)
  }
  flush()
  return result
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
