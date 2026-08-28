import React, { useState, useEffect, useRef, useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import { getCommandList } from './commands.js'
import { CommandPicker } from './command-picker.js'
import { useI18n } from '../i18n-context'
import { discoverSessions } from '../agent/cross-session/discovery'
import { requestSuggestion, shouldAutocomplete, type RecentMessage } from '../core/autocomplete'
import type { Llm } from '../providers/llm'

interface InputBarProps {
  onSubmit: (input: string) => void
  isLoading: boolean
  /** Ctrl+P → open model picker */
  onTogglePicker?: () => void
  /** Ctrl+F → toggle focus mode */
  onToggleFocus?: () => void
  /** Ctrl+O → expand last tool call */
  onToggleExpand?: () => void
  /** Ctrl+G → toggle agent view dashboard */
  onToggleAgentView?: () => void
  /** Shift+Tab → cycle permission mode */
  onCyclePermission?: () => void
  /** Escape → cancel loading / clear draft */
  onCancel?: () => void
  /** When false, don't auto-open the slash-command picker when typing `/`. */
  showCommandPicker?: boolean
  /** LLM 续写建议所需的模型（app.tsx 传；RemoteEngine 下 undefined → 补全禁用）。 */
  llm?: Llm
  /** 最近对话上下文（供续写贴合）。 */
  recentMessages?: RecentMessage[]
  /** 默认 true；app.tsx 传 config.autocomplete?.enabled ?? true。 */
  autocompleteEnabled?: boolean
  /** 默认 400ms；app.tsx 传 config.autocomplete?.debounceMs ?? 400。 */
  autocompleteDebounceMs?: number
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

/**
 * 判断一次输入是否为「批量」（长度跳变 >1：粘贴 / IME 替换）。
 * 批量输入需节流防渲染风暴；普通单字符输入应立即显示，无节流延迟。
 */
export function isBulkInput(prev: string, next: string): boolean {
  return Math.abs(next.length - prev.length) > 1
}

/** True when typing a leading `/` should auto-open the slash-command picker. */
export function shouldAutoOpenPicker(value: string, prevValue: string, enabled: boolean): boolean {
  return enabled && value.startsWith('/') && !prevValue.startsWith('/')
}

export function InputBar({
  onSubmit,
  isLoading,
  onTogglePicker,
  onToggleFocus,
  onToggleExpand,
  onToggleAgentView,
  onCyclePermission,
  onCancel,
  showCommandPicker = true,
  llm,
  recentMessages,
  autocompleteEnabled = true,
  autocompleteDebounceMs = 400,
}: InputBarProps) {
  const { t } = useI18n()
  const [value, setValue] = useState('')
  // Ref mirror of value — used by useInput to read latest without stale closure.
  // Also used by throttled onChange to hold the latest pending value.
  const valueRef = useRef(value)
  // Throttle timer for onChange — prevents React render floods during paste.
  const onChangeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [verb, setVerb] = useState(() => t(pick(LOADING_KEYS)))
  const [completionVerb, setCompletionVerb] = useState<string | null>(null)
  const prevLoading = useRef(isLoading)

  // ── Message history for arrow-key navigation (Claude Code parity) ──
  const [submittedHistory, setSubmittedHistory] = useState<string[]>([])
  const historyIndexRef = useRef(-1) // -1 = not browsing history
  const savedDraftRef = useRef('') // saved user draft before browsing history

  // ── Ghost-text 自动补全 ──
  const [suggestion, setSuggestion] = useState<string | null>(null)
  const suggestionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suggestionReqIdRef = useRef(0)

  // Stabilize t ref — prevents stale closures in intervals and avoids
  // unnecessary effect re-runs when the i18n context value object changes.
  const tRef = useRef(t)
  tRef.current = t

  // ── Slash command hints ──
  const allCommands = useMemo(() => getCommandList(), [])
  const slashHints = useMemo(() => {
    if (!value.startsWith('/')) return []
    const filter = value.slice(1).toLowerCase()
    if (!filter) return allCommands.slice(0, 12) // show first 12 when just "/"
    return allCommands.filter((c) => c.name.toLowerCase().includes(filter)).slice(0, 8)
  }, [value, allCommands])

  // ── @mention hints (cross-session recipients) ──
  const mentionHints = useMemo(() => {
    if (!value.startsWith('@')) return []
    const filter = value.slice(1).toLowerCase()
    const names = discoverSessions().map((s) => s.name)
    if (!filter) return names.slice(0, 12)
    return names.filter((n) => n.toLowerCase().includes(filter)).slice(0, 8)
  }, [value])

  // Rotate gerunds while loading — use tRef to avoid re-running when i18n context re-renders
  useEffect(() => {
    if (!isLoading) return
    const interval = setInterval(() => {
      setVerb(tRef.current(pick(LOADING_KEYS)))
    }, 2000)
    return () => clearInterval(interval)
  }, [isLoading])

  // Pick a fresh gerund when loading starts
  useEffect(() => {
    if (isLoading) {
      setVerb(tRef.current(pick(LOADING_KEYS)))
      setCompletionVerb(null)
    }
  }, [isLoading])

  // Flash a past participle when loading stops
  useEffect(() => {
    if (prevLoading.current === true && isLoading === false) {
      setCompletionVerb(tRef.current(pick(COMPLETED_KEYS)))
      const timer = setTimeout(() => setCompletionVerb(null), 1500)
      prevLoading.current = isLoading
      return () => clearTimeout(timer)
    }
    prevLoading.current = isLoading
  }, [isLoading])

  // Track pre-shortcut value so we can revert ink-text-input's Ctrl-key insertions.
  // ink-text-input inserts 'p'/'f'/'o' for Ctrl+P/F/O (Ink normalizes control chars
  // to their letter names before passing to useInput).
  const valueBeforeShortcut = useRef(value)
  // Keep the ref in sync with state on every change that isn't a Ctrl shortcut revert.
  useEffect(() => {
    valueBeforeShortcut.current = value
  }, [value])

  useInput((input, key) => {
    // ── Escape: cancel loading → clear draft ──
    if (key.escape) {
      // Escape while loading → abort
      if (isLoading) {
        onCancel?.()
        return
      }
      // Idle → clear the draft (the intuitive "cancel")
      setValue('')
      valueRef.current = ''
      setSuggestion(null)
      if (suggestionTimerRef.current) {
        clearTimeout(suggestionTimerRef.current)
        suggestionTimerRef.current = null
      }
      return
    }

    // ── Global hotkeys ──
    // Shift+Tab → cycle permission mode
    if (key.shift && key.tab) {
      onCyclePermission?.()
      return
    }
    // Tab → 接受 ghost-text 建议（复用 Ctrl-key 的 revert 手法）
    if (key.tab && !key.shift && suggestion) {
      const next = valueBeforeShortcut.current + suggestion
      setValue(next)
      valueRef.current = next
      setSuggestion(null)
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
    // Ctrl+G → toggle agent view dashboard
    if (key.ctrl && input === 'g') {
      setValue(valueBeforeShortcut.current)
      onToggleAgentView?.()
      return
    }

    // ── Arrow-key history navigation (Claude Code parity) ──
    if (key.upArrow || key.downArrow) {
      // Ignore if picker is active (command picker handles its own arrows)
      if (value.startsWith('/')) return

      if (key.upArrow) {
        if (submittedHistory.length === 0) return
        // Save current draft the first time we enter history browsing
        if (historyIndexRef.current === -1) {
          // Flush any pending throttle so its deferred setValue doesn't overwrite
          // history navigation (paste → immediate ↑ race). Save the latest value
          // from the ref — state `value` is stale inside the throttle window.
          if (onChangeTimerRef.current) {
            clearTimeout(onChangeTimerRef.current)
            onChangeTimerRef.current = null
          }
          savedDraftRef.current = valueRef.current
        }
        const newIndex = Math.min(historyIndexRef.current + 1, submittedHistory.length - 1)
        historyIndexRef.current = newIndex
        setValue(submittedHistory[submittedHistory.length - 1 - newIndex]!)
        return
      }
      if (key.downArrow) {
        if (historyIndexRef.current === -1) return
        const newIndex = historyIndexRef.current - 1
        historyIndexRef.current = newIndex
        if (newIndex === -1) {
          // Back to the original draft
          setValue(savedDraftRef.current)
          savedDraftRef.current = ''
        } else {
          setValue(submittedHistory[submittedHistory.length - 1 - newIndex]!)
        }
        return
      }
    }
  })

  // ── Command picker state ──
  const [pickerActive, setPickerActive] = useState(false)
  const prevValueRef = useRef(value)

  // Auto-activate picker when user types "/" (unless disabled via showCommandPicker)
  useEffect(() => {
    if (shouldAutoOpenPicker(value, prevValueRef.current, showCommandPicker)) {
      setPickerActive(true)
    }
    // Dismiss picker when user clears the / prefix
    if (!value.startsWith('/') && pickerActive) {
      setPickerActive(false)
    }
    prevValueRef.current = value
  }, [value, showCommandPicker])

  // Keep valueRef in sync with state (so useInput handlers read latest value)
  useEffect(() => {
    valueRef.current = value
  }, [value])

  const handleSubmit = (val: string) => {
    // Flush any pending throttled onChange before submitting
    if (onChangeTimerRef.current) {
      clearTimeout(onChangeTimerRef.current)
      onChangeTimerRef.current = null
    }
    // Use the latest value from the ref — state lags behind during throttle, and
    // the onSubmit `val` is the stale controlled prop in that window.
    const finalValue = valueRef.current || val
    if (!finalValue.trim()) return
    // Submitting while a response streams interrupts it (Claude Code parity)
    // instead of silently dropping the input.
    if (isLoading) {
      onCancel?.()
    }
    // Save to message history for arrow-key navigation
    setSubmittedHistory((prev) => [...prev, finalValue])
    historyIndexRef.current = -1
    savedDraftRef.current = ''
    onSubmit(finalValue)
    setValue('')
    valueRef.current = ''
    setPickerActive(false)
    setSuggestion(null)
  }

  // ── Picker mode: CommandPicker overlay ──
  if (pickerActive) {
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
          <Text color={isLoading ? 'yellow' : 'cyan'}>{'>'}</Text>
        </Box>
        <TextInput
          value={value}
          onChange={(val) => {
            // Reset history browsing when user starts typing
            if (historyIndexRef.current !== -1) {
              historyIndexRef.current = -1
              savedDraftRef.current = ''
            }
            // Normalize newlines → spaces. ink-text-input is single-line; multi-line
            // paste would trap arrow-key navigation on the first line.
            const normalized = val.replace(/\n/g, ' ')
            // ── Ghost-text 自动补全：每次输入清 suggestion + 重排防抖 ──
            setSuggestion(null)
            const suggestionReqId = ++suggestionReqIdRef.current
            if (suggestionTimerRef.current) {
              clearTimeout(suggestionTimerRef.current)
              suggestionTimerRef.current = null
            }
            if (
              llm &&
              autocompleteEnabled &&
              shouldAutocomplete(normalized, isLoading, pickerActive)
            ) {
              suggestionTimerRef.current = setTimeout(() => {
                requestSuggestion(
                  llm,
                  recentMessages ?? [],
                  normalized,
                  () => suggestionReqId !== suggestionReqIdRef.current,
                )
                  .then((completion) => {
                    if (completion) setSuggestion(completion)
                  })
                  .catch(() => {
                    // 补全失败非关键——静默忽略
                  })
              }, autocompleteDebounceMs)
            }
            // 批量输入（paste/IME 替换）节流防渲染风暴；普通单字符输入立即显示，
            // 避免 33ms trailing 的「慢半拍」尾巴。
            const bulk = isBulkInput(valueRef.current, normalized)
            valueRef.current = normalized
            if (!bulk) {
              if (onChangeTimerRef.current) {
                clearTimeout(onChangeTimerRef.current)
                onChangeTimerRef.current = null
              }
              setValue(normalized)
              return
            }
            if (onChangeTimerRef.current) return // timer pending, latest value in ref
            setValue(normalized)
            onChangeTimerRef.current = setTimeout(() => {
              onChangeTimerRef.current = null
              setValue(valueRef.current)
            }, 33) // ~30fps
          }}
          onSubmit={handleSubmit}
          placeholder={
            isLoading ? `${verb}...` : completionVerb ? completionVerb : t('ui.input.placeholder')
          }
        />
        {suggestion && <Text dimColor>{suggestion}</Text>}
      </Box>
      {/* Slash command hints — shown when typing / (only when picker is NOT active) */}
      {slashHints.length > 0 && !pickerActive && (
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
      {/* @mention hints — active sessions (cross-session messaging) */}
      {mentionHints.length > 0 && !pickerActive && (
        <Box marginTop={1} flexDirection="column" gap={1}>
          <Text dimColor>{t('ui.mention_hints.label')} </Text>
          {mentionHints.map((name) => (
            <Text key={name} color="green">
              {name}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}
