import React, { useState, useMemo, useEffect } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import { getCommandList, type CommandEntry } from './commands.js'

interface CommandPickerProps {
  /** Text already typed (e.g. "/", "/age") — used as initial filter */
  initialFilter: string
  /** Called when user selects a command */
  onSelect: (commandName: string) => void
  /** Called when user presses Esc */
  onClose: () => void
  /** Max visible items before scrolling */
  maxVisible?: number
}

const PAGE_SIZE = 12

/**
 * CommandPicker — interactive slash-command selector.
 *
 * Reuses the ModelPicker's Ink interaction pattern:
 *   ↑/↓ cursor navigation (wrapping), Enter to select, Esc to close.
 * Plus real-time filtering — user types to narrow the command list.
 */
export function CommandPicker({
  initialFilter,
  onSelect,
  onClose,
  maxVisible = PAGE_SIZE,
}: CommandPickerProps) {
  const allCommands = useMemo(() => getCommandList(), [])
  const [filter, setFilter] = useState(initialFilter)
  const [cursorIdx, setCursorIdx] = useState(0)

  // Filter commands based on user input
  const filtered = useMemo(() => {
    const q = filter.startsWith('/') ? filter.slice(1).toLowerCase() : filter.toLowerCase()
    if (!q) return allCommands
    return allCommands.filter(
      (cmd) =>
        cmd.name.toLowerCase().includes(q) || cmd.description.toLowerCase().includes(q),
    )
  }, [filter, allCommands])

  // Reset cursor when filter changes
  useEffect(() => {
    setCursorIdx(0)
  }, [filter])

  // Scroll window: keep cursor in the visible range
  const scrollStart = Math.max(
    0,
    Math.min(cursorIdx - Math.floor(maxVisible / 2), filtered.length - maxVisible),
  )
  const visible = filtered.slice(scrollStart, scrollStart + maxVisible)
  const adjustedCursor = cursorIdx - scrollStart

  // Wrap cursor safely
  const safeCursor = (i: number) =>
    filtered.length === 0 ? 0 : ((i % filtered.length) + filtered.length) % filtered.length

  useInput((_input, key) => {
    if (key.escape) {
      onClose()
      return
    }

    if (key.return) {
      const selected = filtered[cursorIdx]
      if (selected) {
        onSelect(selected.name)
      }
      return
    }

    if (key.upArrow) {
      setCursorIdx((prev) => safeCursor(prev - 1))
      return
    }

    if (key.downArrow) {
      setCursorIdx((prev) => safeCursor(prev + 1))
      return
    }
  })

  const itemColor = (isCursor: boolean) => (isCursor ? 'cyan' : undefined)
  const itemBold = (isCursor: boolean) => isCursor

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1}>
      {/* Title */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Commands
        </Text>
        <Text dimColor> ↑↓ navigate · Enter select · Esc close</Text>
      </Box>

      {/* Command list */}
      <Box flexDirection="column" marginBottom={1}>
        {visible.length === 0 && (
          <Text dimColor>  No commands match "{filter}"</Text>
        )}
        {visible.map((cmd, i) => {
          const globalIdx = i + scrollStart
          const isCursor = globalIdx === cursorIdx
          return (
            <Box key={cmd.name}>
              <Text color={itemColor(isCursor)} bold={itemBold(isCursor)}>
                {isCursor ? '▶ ' : '  '}
                {cmd.name.padEnd(20)}
              </Text>
              <Text dimColor>{cmd.description}</Text>
            </Box>
          )
        })}
      </Box>

      {/* Scroll indicator */}
      {filtered.length > maxVisible && (
        <Box marginBottom={1}>
          <Text dimColor>
            {scrollStart + 1}–{Math.min(scrollStart + maxVisible, filtered.length)} of{' '}
            {filtered.length} commands
          </Text>
        </Box>
      )}

      {/* Filter input */}
      <Box>
        <Text color="cyan">/ </Text>
        <TextInput
          value={filter.startsWith('/') ? filter.slice(1) : filter}
          onChange={(val) => setFilter(`/${val}`)}
          onSubmit={() => {
            const selected = filtered[cursorIdx]
            if (selected) {
              onSelect(selected.name)
            }
          }}
          placeholder="Type to filter commands..."
        />
      </Box>
    </Box>
  )
}
