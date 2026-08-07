import React, { useState, useEffect, useRef, useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import { VimMotionEngine, type VimMode } from './vim-motions.js'
import { getCommandList } from './commands.js'
import { CommandPicker } from './command-picker.js'
import { useI18n } from '../i18n-context'

interface InputBarProps {
  onSubmit: (input: string) => void
  isLoading: boolean
  /** Ctrl+P → open model picker */
  onTogglePicker?: () => void
  /** Ctrl+F → toggle focus mode */
  onToggleFocus?: () => void
  /** Ctrl+O → expand last tool call */
  onToggleExpand?: () => void
  /** Shift+Tab → cycle permission mode */
  onCyclePermission?: () => void
  /** Escape → cancel loading (when input is empty) */
  onCancel?: () => void
}

// ── Loading verb keys (i18n) ──

const LOADING_KEYS = [
  'ui.loading.doodling',
  'ui.loading.forging',
  'ui.loading.cerebrating',
  'ui.loading.recombobulating',
  'ui.loading.thinking',
  'ui.loading.computing',
  'ui.loading.processing',
  'ui.loading.analyzing',
  'ui.loading.generating',
  'ui.loading.dreaming',
  'ui.loading.pondering',
  'ui.loading.ruminating',
  'ui.loading.deliberating',
  'ui.loading.contemplating',
  'ui.loading.synthesizing',
  'ui.loading.calculating',
  'ui.loading.inferring',
  'ui.loading.optimizing',
  'ui.loading.compiling',
  'ui.loading.orchestrating',
  'ui.loading.harmonizing',
  'ui.loading.galvanizing',
  'ui.loading.illuminating',
  'ui.loading.manifesting',
  'ui.loading.transmogrifying',
  'ui.loading.actualizing',
]

const COMPLETED_KEYS = [
  'ui.loading.completed_brewed',
  'ui.loading.completed_churned',
  'ui.loading.completed_cooked',
  'ui.loading.completed_sauteed',
  'ui.loading.completed_cogitated',
  'ui.loading.completed_crunched',
]

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}

export function InputBar({
  onSubmit,
  isLoading,
  onTogglePicker,
  onToggleFocus,
  onToggleExpand,
  onCyclePermission,
  onCancel,
}: InputBarProps) {
  const { t } = useI18n()
  const [value, setValue] = useState('')
  const [verb, setVerb] = useState(() => t(pick(LOADING_KEYS)))
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
      setVerb(t(pick(LOADING_KEYS)))
    }, 1200)
    return () => clearInterval(interval)
  }, [isLoading, t])

  // Pick a fresh gerund when loading starts
  useEffect(() => {
    if (isLoading) {
      setVerb(t(pick(LOADING_KEYS)))
      setCompletionVerb(null)
    }
  }, [isLoading, t])

  // Flash a past participle when loading stops
  useEffect(() => {
    if (prevLoading.current === true && isLoading === false) {
      setCompletionVerb(t(pick(COMPLETED_KEYS)))
      const timer = setTimeout(() => setCompletionVerb(null), 1500)
      return () => clearTimeout(timer)
    }
    prevLoading.current = isLoading
  }, [isLoading, t])

  const [vimMode, setVimMode] = useState<VimMode>('insert')
  // NOTE: Dual mode state — React state (vimMode) drives UI re-renders (prompt color,
  // placeholder); engine mode (vimEngine.current.mode) drives logic inside useInput so
  // the handler always reads the authoritative mode without stale-closure risk.
  const vimEngine = useRef(new VimMotionEngine())
  const vimPending = useRef<string | null>(null)
  const [searchMode, setSearchMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // Track pre-shortcut value so we can revert ink-text-input's Ctrl-key insertions.
  // ink-text-input inserts 'p'/'f'/'o' for Ctrl+P/F/O (Ink normalizes control chars
  // to their letter names before passing to useInput).
  const valueBeforeShortcut = useRef(value)
  // Keep the ref in sync with state on every change that isn't a Ctrl shortcut revert.
  useEffect(() => {
    valueBeforeShortcut.current = value
  }, [value])

  // ── Vim motions: intercept keys in normal mode ──

  useInput((input, key) => {
    // ── Escape: cancel loading → toggle vim mode ──
    if (key.escape) {
      // Cancel search mode if active
      if (searchMode) {
        setSearchMode(false)
        setSearchQuery('')
        return
      }
      // Escape while loading → abort (priority over vim toggle)
      if (isLoading) {
        onCancel?.()
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

    // ── Global hotkeys (work in both insert and normal modes) ──
    // Shift+Tab → cycle permission mode
    if (key.shift && key.tab) {
      onCyclePermission?.()
      return
    }
    // Ctrl+P → toggle model picker
    // NOTE: Ink passes input=keypress.name (just 'p') when ctrl is true, not raw \x10.
    // ink-text-input inserts 'p' as literal text — revert it.
    if (key.ctrl && input === 'p') {
      setValue(valueBeforeShortcut.current)
      onTogglePicker?.()
      return
    }
    // Ctrl+F → toggle focus mode
    if (key.ctrl && input === 'f') {
      setValue(valueBeforeShortcut.current)
      onToggleFocus?.()
      return
    }
    // Ctrl+O → expand/collapse last tool call
    if (key.ctrl && input === 'o') {
      setValue(valueBeforeShortcut.current)
      onToggleExpand?.()
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
                ? t('ui.input.vim_help')
                : isLoading
                  ? `${verb}...`
                  : completionVerb
                    ? completionVerb
                    : t('ui.input.placeholder')
          }
        />
      </Box>
      {/* Slash command hints — shown when typing / in INSERT mode (only when picker is NOT active) */}
      {slashHints.length > 0 && vimMode === 'insert' && !pickerActive && (
        <Box marginTop={1} flexDirection="column" gap={1}>
          <Text dimColor>{t('ui.slash_hints.label')} </Text>
          {slashHints.map((cmd, _i) => (
            <Text key={cmd.name} color="cyan">
              {cmd.name}
            </Text>
          ))}
          <Text dimColor>
            (
            {slashHints.length === allCommands.length
              ? t('ui.slash_hints.all')
              : t('ui.slash_hints.count', {
                  shown: String(slashHints.length),
                  total: String(allCommands.length),
                })}
            )
          </Text>
        </Box>
      )}
    </Box>
  )
}
