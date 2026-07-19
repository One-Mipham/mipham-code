import React, { useState, useEffect, useRef, useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import { VimMotionEngine, type VimMode } from './vim-motions.js'
import { getCommandList, type CommandEntry } from './commands.js'
import { CommandPicker } from './command-picker.js'

interface InputBarProps {
  onSubmit: (input: string) => void
  isLoading: boolean
}

// ── Status verbs — English (Claude Code-aligned) + Chinese (Mipham originals) ──

const STATUS_EN = [
  'Doodling',
  'Forging',
  'Germinating',
  'Mosmosing',
  'Cerebrating',
  'Boogieing',
  'Finagling',
  'Misting',
  'Recombobulating',
  'Slithering',
  'Effecting',
  'Roosting',
  'Crystallizing',
  'Canoodling',
  'Billowing',
  'Warping',
  'Improvising',
  'Metamorphing',
  'Gusting',
  'Whiring',
  'Topsy-turvying',
  'Flibbertigibetting',
  'Wibbling',
  'Thundering',
  'Moseying',
  'Julienning',
  'Evaporating',
  'Ruminating',
  'Whisking',
  'Scampering',
  'Meandering',
  'Concoting',
  'Gesticulating',
  'Flamebeing',
  'Quantumizing',
  'Waddling',
  'Fluttering',
  'Sprouting',
  'Elucidating',
  'Embellishing',
  'Razzmatizing',
  'Pondering',
  'Cogitating',
  'Garnishing',
  'Actualizing',
  'Zigzagging',
  'Mustering',
  'Frolicking',
  'Hullaballooing',
  'Doing',
  'Fermenting',
  'Considering',
  'Skedaddling',
  'Actioning',
  'Orbiting',
  'Perambulating',
  'Drizzling',
  'Schlepping',
  'Ionizing',
  'Scurrying',
]

const STATUS_CN = [
  '思忖中',
  '推演中',
  '凝炼中',
  '熬煮中',
  '锻造中',
  '研磨中',
  '解构中',
  '冥思中',
  '编织中',
  '萃取中',
  '烹制中',
  '淬火中',
  '雕琢中',
  '融汇中',
  '觉照中',
  '运转中',
  '参详中',
  '化合中',
  '浸润中',
  '焙烤中',
]

// Merge both — bilingual status verbs
const STATUS_GERUNDS = [...STATUS_EN, ...STATUS_CN]

const STATUS_PAST = ['Brewed', 'Churned', 'Cooked', 'Sautéed', 'Cogitated', 'Crunched']

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}

export function InputBar({ onSubmit, isLoading }: InputBarProps) {
  const [value, setValue] = useState('')
  const [verb, setVerb] = useState(() => pick(STATUS_GERUNDS))
  const [completionVerb, setCompletionVerb] = useState<string | null>(null)
  const prevLoading = useRef(isLoading)

  // ── Slash command hints ──
  const allCommands = useMemo(() => getCommandList(), [])
  const slashHints = useMemo(() => {
    if (!value.startsWith('/')) return []
    const filter = value.slice(1).toLowerCase()
    if (!filter) return allCommands.slice(0, 12) // show first 12 when just "/"
    return allCommands.filter((c) => c.name.toLowerCase().includes(filter)).slice(0, 8)
  }, [value, allCommands])

  // Rotate gerunds while loading
  useEffect(() => {
    if (!isLoading) return
    const interval = setInterval(() => {
      setVerb(pick(STATUS_GERUNDS))
    }, 1200)
    return () => clearInterval(interval)
  }, [isLoading])

  // Pick a fresh gerund when loading starts
  useEffect(() => {
    if (isLoading) {
      setVerb(pick(STATUS_GERUNDS))
      setCompletionVerb(null)
    }
  }, [isLoading])

  // Flash a past participle when loading stops
  useEffect(() => {
    if (prevLoading.current === true && isLoading === false) {
      setCompletionVerb(pick(STATUS_PAST))
      const timer = setTimeout(() => setCompletionVerb(null), 1500)
      return () => clearTimeout(timer)
    }
    prevLoading.current = isLoading
  }, [isLoading])

  const [vimMode, setVimMode] = useState<VimMode>('insert')
  // NOTE: Dual mode state — React state (vimMode) drives UI re-renders (prompt color,
  // placeholder); engine mode (vimEngine.current.mode) drives logic inside useInput so
  // the handler always reads the authoritative mode without stale-closure risk.
  const vimEngine = useRef(new VimMotionEngine())
  const vimPending = useRef<string | null>(null)
  const [searchMode, setSearchMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // ── Vim motions: intercept keys in normal mode ──

  useInput((input, key) => {
    // Escape toggles between insert and normal mode
    if (key.escape) {
      // Cancel search mode if active
      if (searchMode) {
        setSearchMode(false)
        setSearchQuery('')
        return
      }
      // Clear any pending multi-key sequence
      if (vimPending.current) {
        vimPending.current = null
      }
      setVimMode((prev) => (prev === 'insert' ? 'normal' : 'insert'))
      vimEngine.current.mode = vimEngine.current.mode === 'insert' ? 'normal' : 'insert'
      return
    }

    if (vimEngine.current.mode !== 'normal') return

    // Handle search mode — collect query characters
    if (searchMode) {
      if (key.return) {
        const action = vimEngine.current.handleSearch(value, searchQuery)
        if (action.text !== undefined) setValue(action.text)
        // NOTE: action.cursor is not settable on ink-text-input — user repositions manually
        setSearchMode(false)
        setSearchQuery('')
        return
      }
      if (key.backspace || key.delete) {
        setSearchQuery((q) => q.slice(0, -1))
        return
      }
      // Accumulate printable characters
      if (input && input.length === 1 && !key.escape && !key.return) {
        setSearchQuery((q) => q + input)
      }
      return
    }

    // Handle pending two-key sequences (dd, yy)
    if (vimPending.current !== null) {
      if (vimPending.current === 'd' && input === 'd') {
        const action = vimEngine.current.handleDD(value)
        setValue(action.text ?? value)
      } else if (vimPending.current === 'y' && input === 'y') {
        vimEngine.current.handleYY(value)
      }
      // Always clear pending — even when second key doesn't match
      vimPending.current = null
      return
    }

    // Handle p (paste) — pastes clipboard at cursor position
    if (input === 'p') {
      const action = vimEngine.current.handlePaste(value, value.length)
      if (action.text !== undefined) setValue(action.text)
      return
    }

    // Handle u (undo)
    if (input === 'u') {
      const action = vimEngine.current.handleUndo(value)
      if (action.text !== undefined) setValue(action.text)
      return
    }

    // Handle / (enter search mode)
    if (input === '/') {
      setSearchMode(true)
      setSearchQuery('')
      return
    }

    // Handle single-key motions (h, j, k, l, w, b, 0, $, d, y)
    const action = vimEngine.current.handleNormal(input, value, value.length)
    if (!action) return

    if (action.pending) {
      vimPending.current = action.pending
      return
    }

    if (action.text !== undefined) {
      setValue(action.text)
    }

    // NOTE: action.cursor is returned by motions (h/j/k/l/w/b/0/$) but
    // ink-text-input does not expose a programmatic cursor-position API.
    // The cursor hint is informational only; the user repositions manually.
  })

  // ── Command picker state ──
  const [pickerActive, setPickerActive] = useState(false)
  const prevValueRef = useRef(value)

  // Auto-activate picker when user types "/"
  useEffect(() => {
    if (value.startsWith('/') && !prevValueRef.current.startsWith('/') && vimMode === 'insert') {
      setPickerActive(true)
    }
    // Dismiss picker when user clears the / prefix
    if (!value.startsWith('/') && pickerActive) {
      setPickerActive(false)
    }
    prevValueRef.current = value
  }, [value, vimMode])

  const handleSubmit = (val: string) => {
    if (!val.trim() || isLoading) return
    onSubmit(val)
    setValue('')
    setPickerActive(false)
  }

  // ── Picker mode: CommandPicker overlay ──
  if (pickerActive && vimMode === 'insert') {
    return (
      <Box flexDirection="column" marginTop={1}>
        <CommandPicker
          initialFilter={value}
          onSelect={(cmdName) => {
            // Fill the command name and submit
            onSubmit(cmdName)
            setValue('')
            setPickerActive(false)
          }}
          onClose={() => {
            setPickerActive(false)
            // Keep the current typed text so user can continue
          }}
        />
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Box marginRight={1}>
          <Text color={vimMode === 'normal' ? 'magenta' : isLoading ? 'yellow' : 'cyan'}>
            {vimMode === 'normal' ? ':' : '>'}
          </Text>
        </Box>
        <TextInput
          value={value}
          onChange={(val) => {
            // Block text changes during search mode — keys go to search query
            if (searchMode) return
            setValue(val)
          }}
          onSubmit={handleSubmit}
          placeholder={
            searchMode
              ? `/${searchQuery}`
              : vimMode === 'normal'
                ? '[NORMAL] h/j/k/l w/b 0/$ dd yy p u / (Esc to insert)'
                : isLoading
                  ? `${verb}...`
                  : completionVerb
                    ? completionVerb
                    : 'Type a message (Esc to cancel)...'
          }
        />
      </Box>
      {/* Slash command hints — shown when typing / in INSERT mode (only when picker is NOT active) */}
      {slashHints.length > 0 && vimMode === 'insert' && !pickerActive && (
        <Box marginTop={1} flexDirection="column" gap={1}>
          <Text dimColor>Commands: </Text>
          {slashHints.map((cmd, i) => (
            <Text key={cmd.name} color="cyan">
              {cmd.name}
            </Text>
          ))}
          <Text dimColor>
            (
            {slashHints.length === allCommands.length
              ? 'all'
              : `${slashHints.length} of ${allCommands.length}`}
            )
          </Text>
        </Box>
      )}
    </Box>
  )
}
