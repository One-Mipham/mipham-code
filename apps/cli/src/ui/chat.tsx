import React, { useMemo } from 'react'
import { Box, Text } from 'ink'
import { useI18n } from '../i18n-context'
import type { ChatMessage } from './app'

interface ChatPanelProps {
  messages: ChatMessage[]
  focusMode?: boolean
  /** When false, hide process/system noise (thinking, notices, tool activity) — show only user + assistant. */
  showSystemMessages?: boolean
}

/** Drop process/system noise — keep only user prompts + assistant answers. */
export function filterSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.role !== 'system')
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
    case 'Update':
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
    const { t } = useI18n()
    return (
      <Box
        flexDirection="column"
        marginTop={msg.toolMeta ? 0 : 1}
        marginBottom={msg.toolMeta ? 0 : 1}
      >
        {msg.toolMeta ? (
          <Box flexDirection="column">
            {/* Tool call line: ⏺ ToolName(detail) — Claude Code parity */}
            {msg.toolMeta.name ? (
              <Text color={toolColor(msg.toolMeta.name)}>
                {msg.toolMeta.collapsed ? '⏺' : '⏺ ▼'} {msg.toolMeta.name}
                {msg.toolMeta.input ? ` (${msg.toolMeta.input.slice(0, 120)})` : ''}
              </Text>
            ) : null}
            {/* Tool result line: ⎿  summary text */}
            {msg.toolMeta.output ? (
              <Text dimColor>
                {'  ⎿  '}
                {msg.toolMeta.output.slice(0, 300)}
              </Text>
            ) : msg.content && !msg.toolMeta.collapsed ? (
              <Text dimColor>{msg.content}</Text>
            ) : null}
          </Box>
        ) : (
          <>
            {msg.role === 'user' ? (
              <Text bold color="green">
                ▸ {displayCwd()}:
              </Text>
            ) : msg.role === 'assistant' ? (
              <Text bold color="magenta">
                ◆ {t('ui.assistant.role_label')}:
              </Text>
            ) : msg.role === 'system' ? (
              <Text bold color="yellow">
                ⚠ {t('ui.system.role_label')}:
              </Text>
            ) : null}
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

export function ChatPanel({ messages, focusMode, showSystemMessages = true }: ChatPanelProps) {
  const { t } = useI18n()
  const visibleMessages = useMemo(
    () => (showSystemMessages ? messages : filterSystemMessages(messages)),
    [messages, showSystemMessages],
  )
  // Memoize display message computation to avoid O(n) compact on every render.
  // During streaming, messages changes on every chunk; without memoization,
  // compactToolGroups/compactForFocus re-iterates the full message list on each
  // chunk, saturating the event loop at 20-50 chunks/sec.
  const displayMessages = useMemo(
    () => (focusMode ? compactForFocus(visibleMessages) : compactToolGroups(visibleMessages)),
    [visibleMessages, focusMode],
  )

  return (
    <Box flexDirection="column" marginY={1} flexGrow={1}>
      {focusMode && messages.length > 0 && (
        <Box marginBottom={1}>
          <Text dimColor>
            🔍 {t('ui.chat.focus_hint')} — {countHidden(messages, displayMessages, t)} ·{' '}
            {t('ui.chat.toggle_focus_hint')} · {t('ui.chat.expand_hint')}
          </Text>
        </Box>
      )}
      {messages.length === 0 && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color="cyan" bold>
              {t('ui.banner.title')}
            </Text>
            <Text dimColor> — {t('ui.banner.subtitle')}</Text>
          </Box>
          <Text dimColor>{t('ui.banner.tagline')}</Text>
          <Box marginTop={1}>
            <Text dimColor>
              {t('ui.banner.start_message')} <Text color="yellow">/help</Text>
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>{t('ui.banner.controls_hint')}</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>{t('ui.banner.tip_clear')}</Text>
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
 * Pair each tool_use message with its following tool_result message(s),
 * showing every tool individually with its name, detail, and output.
 *
 * Claude Code parity: each tool renders as:
 *   ⏺ ToolName (detail)        ← colored per tool type
 *     ⎿  output summary          ← dimmed below
 *
 * Only true duplicates (same tool name + same detail) are collapsed
 * into a single entry with a count.
 */
function compactToolGroups(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = []
  let current: ChatMessage | null = null

  for (const msg of messages) {
    // Tool call with a name → flush previous, start a new one
    if (msg.toolMeta?.name && !msg.toolMeta.name.startsWith('tools (')) {
      if (current) result.push(current)
      current = { ...msg }
      continue
    }

    // Tool result (no name, has output) → merge output into current tool
    if (msg.toolMeta && !msg.toolMeta.name && msg.toolMeta.output) {
      if (current) {
        current = {
          ...current,
          content: msg.content,
          toolMeta: {
            ...current.toolMeta!,
            output: msg.toolMeta.output,
          },
        }
      }
      // Orphan tool result (no preceding tool_use) → skip
      continue
    }

    // Already-grouped message (from a previous compact cycle) or non-tool
    if (current) {
      result.push(current)
      current = null
    }
    // Skip orphan tool-result messages without a preceding tool_use
    if (msg.toolMeta && !msg.toolMeta.name && msg.toolMeta.output) {
      continue
    }
    result.push(msg)
  }

  // Flush any remaining tool
  if (current) result.push(current)
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
function countHidden(
  all: ChatMessage[],
  compacted: ChatMessage[],
  t: (key: string, params?: Record<string, string>) => string,
): string {
  const toolCount = all.filter((m) => m.toolMeta).length
  const hidden = all.length - compacted.length
  if (hidden <= 0) return t('ui.chat.showing_all', { count: String(all.length) })
  return t('ui.chat.tool_outputs_folded', { hidden: String(hidden), toolCount: String(toolCount) })
}
