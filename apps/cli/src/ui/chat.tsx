import React, { useMemo } from 'react'
import { Box, Text } from 'ink'
import { useI18n } from '../i18n-context'
import type { ChatMessage } from './app'
import {
  decodeDisplayEntities,
  sanitizeInlineField,
  stripControlCharsForDisplay,
} from '../shared/sanitize'
import { homedir } from 'node:os'

interface ChatPanelProps {
  messages: ChatMessage[]
  focusMode?: boolean
  /** A turn is in flight — the moment the focus tip is worth offering. */
  turnActive?: boolean
}

/**
 * The port untrusted **multi-line** text takes to terminal output.
 *
 * Tool arguments, tool output and model prose pass through here; `\n` is kept
 * because those are legitimately multi-line. Control characters in them are not
 * visible content; they are terminal instructions (CR overwrites the row, ESC
 * starts a sequence), so they are removed rather than shown. See
 * `stripControlCharsForDisplay` for what is kept and why.
 *
 * **One-line fields do not come through here.** A tool *name* is rendered on a row
 * of its own, where the `\n` this function keeps forges an extra row — so names go
 * through `sanitizeInlineField` (the same recipe minus `\n`), the way
 * `agent-footer.tsx` and `input.tsx` already do. The name below used to be
 * interpolated raw, on the theory that this function was the only way in; it is not.
 * The same holds for the `↳ name1 ↳ name2` line `summarizeToolGroup` composes: one
 * line, names straight off the model's `tool_use`, so the single-line gate.
 */
function display(text: string): string {
  return stripControlCharsForDisplay(text)
}

/**
 * Render at most this many lines of a message body.
 *
 * Ink lays out the *whole* string on every render, and a streamed turn re-renders
 * continuously — so a model answer of tens of thousands of lines (a dumped file,
 * a runaway loop) makes every chunk reflow the entire body, at ~16 fps. The tail
 * is dropped with a visible count rather than silently: the model may well have
 * written something worth scrolling to, and a truncated view that says so lets
 * the user ask for the rest instead of believing they saw all of it.
 *
 * Applied to every non-tool body (user pastes hit the same wall).
 */
const MAX_RENDERED_LINES = 50

function capRenderedLines(text: string): string {
  let newlines = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) newlines++
  if (newlines < MAX_RENDERED_LINES) return text
  const lines = text.split('\n')
  const hidden = lines.length - MAX_RENDERED_LINES
  return (
    lines.slice(0, MAX_RENDERED_LINES).join('\n') +
    `\n… ${hidden} more line${hidden === 1 ? '' : 's'}`
  )
}

/** Format cwd for display: replace HOME with ~, truncate if too long */
function displayCwd(): string {
  const cwd = process.cwd()
  const home = homedir()
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
                {msg.toolMeta.collapsed ? '⏺' : '⏺ ▼'} {sanitizeInlineField(msg.toolMeta.name)}
                {msg.toolMeta.input ? ` (${display(msg.toolMeta.input).slice(0, 120)})` : ''}
              </Text>
            ) : null}
            {/* Tool result line: ⎿  summary text */}
            {msg.toolMeta.notRun ? (
              // Held back by the auto-mode classifier: it never ran, so the text
              // below is the *reason*, not output. Labelling it keeps a held-back
              // call from reading as a tool that ran and returned this (296-056).
              <Text dimColor>
                {'  ⎿  '}
                {t('ui.tool.not_run')}
                {msg.toolMeta.output ? ` — ${display(msg.toolMeta.output).slice(0, 300)}` : ''}
              </Text>
            ) : msg.toolMeta.output ? (
              <Text dimColor>
                {'  ⎿  '}
                {display(msg.toolMeta.output).slice(0, 300)}
              </Text>
            ) : msg.content && !msg.toolMeta.collapsed ? (
              <Text dimColor>{display(msg.content)}</Text>
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
            <Text>{capRenderedLines(display(decodeDisplayEntities(msg.content)))}</Text>
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

export function ChatPanel({ messages, focusMode, turnActive }: ChatPanelProps) {
  const { t } = useI18n()
  // Memoize display message computation to avoid O(n) compact on every render.
  // During streaming, messages changes on every chunk; without memoization,
  // compactToolGroups/compactForFocus re-iterates the full message list on each
  // chunk, saturating the event loop at 20-50 chunks/sec.
  const displayMessages = useMemo(
    () => (focusMode ? compactForFocus(messages) : compactToolGroups(messages)),
    [messages, focusMode],
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
      {/*
        Offer focus while a turn is running — that is when the transcript grows
        fastest and when someone is most likely to want it — rather than only
        documenting it in the idle banner, where it is read before there is
        anything to focus on. Shown only outside focus mode, and the text names
        the way back so trying it cannot strand anyone.
      */}
      {turnActive && !focusMode && messages.length > 0 && (
        <Box marginBottom={1}>
          <Text dimColor>{t('ui.chat.try_focus_tip')}</Text>
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
            <Text dimColor>{t('ui.banner.start_message')}</Text>
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
            // 结果行上的标记必须跟着合并走：合并把结果行的 toolMeta 并进工具调用行，
            // 漏掉它，`notRun` 就停在**没人渲染的那一份**上（296-056）。
            ...(msg.toolMeta.notRun ? { notRun: true } : {}),
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

/**
 * Summarize a group of tool calls into a single compact message.
 *
 * Exported for `test/ui/chat-control-chars.test.ts`, which pins the composition
 * itself: names come from the model's `tool_use`, and this line is a **one-line**
 * display string, so each name goes through the single-line gate rather than
 * `display()` — the latter keeps `\n` for legitimately multi-line bodies, and a
 * `\n` in a name forges a row here just as it did on the tool-call row.
 *
 * That line is not rendered by today's `MessageRow` (the `toolMeta` branch is
 * taken, where `output` wins and `collapsed: true` blocks the `content`
 * fallback) — so this is hardening the composed value, not fixing an observed
 * leak. It keeps the string safe under whichever renderer reads it next.
 */
export function summarizeToolGroup(tools: ChatMessage[]): ChatMessage {
  const names = tools.map((t) => t.toolMeta!.name)
  const uniqueNames = [...new Set(names)]
  const toolList = uniqueNames.map((n) => `↳ ${sanitizeInlineField(n)}`).join('  ')
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
