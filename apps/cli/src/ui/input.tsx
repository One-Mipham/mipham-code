import React, { useState, useEffect, useRef, useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
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
 * 归一化输入：多行粘贴折叠成单行（CR/LF/Tab → 空格）。
 * ink-text-input 是单行组件，嵌入的 \r 会拉回行首覆盖显示、\n 会 trap 光标。
 */
export function normalizeInput(input: string): string {
  return input.replace(/[\r\n\t]+/g, ' ')
}

/** Cursor-aware edit state — value plus the insertion point (0..value.length). */
export interface EditState {
  value: string
  cursor: number
}

/** A single editing keystroke, normalized away from Ink's key object for testability. */
export type EditAction =
  | { type: 'moveLeft' }
  | { type: 'moveRight' }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'insert'; text: string }

/**
 * Pure cursor-editing transition. Returns a new state (or the same state when
 * the action is a no-op). Cursor is always clamped to [0, value.length].
 */
export function applyEdit(state: EditState, action: EditAction): EditState {
  const { value, cursor } = state
  switch (action.type) {
    case 'moveLeft':
      return { value, cursor: Math.max(0, cursor - 1) }
    case 'moveRight':
      return { value, cursor: Math.min(value.length, cursor + 1) }
    case 'backspace':
      if (cursor === 0) return state
      return {
        value: value.slice(0, cursor - 1) + value.slice(cursor),
        cursor: cursor - 1,
      }
    case 'delete':
      if (cursor >= value.length) return state
      return { value: value.slice(0, cursor) + value.slice(cursor + 1), cursor }
    case 'insert': {
      if (!action.text) return state
      return {
        value: value.slice(0, cursor) + action.text + value.slice(cursor),
        cursor: cursor + action.text.length,
      }
    }
  }
}

/**
 * Map an Ink key object + raw input to a cursor-editing action (null when the key
 * isn't an edit). Extracted from the MiphamTextInput useInput handler so the macOS
 * Backspace quirk is unit-testable.
 *
 * Ink 5.2.1 parses the macOS Backspace key (terminal sends \x7f) as `key.delete`,
 * NOT `key.backspace` (that's \x08). So both must map to a backward delete; the
 * true forward-Delete key (\x1b[3~) is also parsed as `key.delete` by Ink and is
 * rare, so it deliberately stays backward-delete too.
 */
export function keyToEditAction(
  key: { leftArrow?: boolean; rightArrow?: boolean; backspace?: boolean; delete?: boolean },
  input: string,
): EditAction | null {
  if (key.leftArrow) return { type: 'moveLeft' }
  if (key.rightArrow) return { type: 'moveRight' }
  if (key.backspace || key.delete) return { type: 'backspace' }
  const cleaned = normalizeInput(input)
  if (cleaned) return { type: 'insert', text: cleaned }
  return null
}

/** Browsing state for arrow-key history navigation. */
export interface HistoryNavState {
  history: string[]
  index: number // -1 = not browsing
  savedDraft: string // draft saved on first up-arrow
}

/**
 * Pure history-navigation transition. Returns the value to display plus the
 * updated browsing state, or null when the key is a no-op (empty history for up,
 * or not browsing for down).
 */
export function navigateHistory(
  state: HistoryNavState,
  dir: 'up' | 'down',
  draft: string,
): { index: number; savedDraft: string; value: string } | null {
  if (dir === 'up') {
    if (state.history.length === 0) return null
    const savedDraft = state.index === -1 ? draft : state.savedDraft
    const index = Math.min(state.index + 1, state.history.length - 1)
    return { index, savedDraft, value: state.history[state.history.length - 1 - index]! }
  }
  // down
  if (state.index === -1) return null
  const index = state.index - 1
  if (index === -1) {
    return { index, savedDraft: '', value: state.savedDraft }
  }
  return {
    index,
    savedDraft: state.savedDraft,
    value: state.history[state.history.length - 1 - index]!,
  }
}

/** True when typing a leading `/` should auto-open the slash-command picker. */
export function shouldAutoOpenPicker(value: string, prevValue: string, enabled: boolean): boolean {
  return enabled && value.startsWith('/') && !prevValue.startsWith('/')
}

/**
 * Mipham 自有的单行文本输入，替代 ink-text-input。
 *
 * 为什么不用 ink-text-input：它把粘贴按「光标偏移切片插入」逐块处理，而
 * cursorOffset 与受控 value 都来自渲染闭包——Ink 会把长粘贴按 stdin read()
 * 边界拆成多块，同一轮 synchronous flush 里后续块读到的仍是旧值，于是「覆盖
 * 前块 / 插到中段」，表现为粘贴内容乱序、丢失、冻住。
 *
 * 这里用 ref 做同步真值：每块按当前 ref 在光标处原子插入（默认光标在末尾），
 * 不依赖 React 渲染时序，分块粘贴自然累积成完整文本。
 */
function MiphamTextInput({
  value,
  onChange,
  onSubmit,
  placeholder = '',
  focus = true,
}: {
  value: string
  onChange: (next: string) => void
  onSubmit: (value: string) => void
  placeholder?: string
  focus?: boolean
}) {
  // 同步真值：valueRef 永远是最新文本；受控 value 仅在渲染时落后于 ref。
  const valueRef = useRef(value)
  // 光标插入点（0..value.length）：cursorRef 供 useInput 同步读，cursor state 驱动渲染。
  const [cursor, setCursor] = useState(value.length)
  const cursorRef = useRef(cursor)

  // 外部改动（箭头历史回填、提交/Esc 清空）时把真值对齐回受控 prop，光标归位到末尾。
  // 组件自身 edit 在 onChange 前已同步更新 valueRef，故 ref 与 prop 相等时跳过，
  // 避免把「中段插入」后的光标错误拉回末尾。
  useEffect(() => {
    if (valueRef.current !== value) {
      valueRef.current = value
      cursorRef.current = value.length
      setCursor(value.length)
    }
  }, [value])

  useInput(
    (input, key) => {
      if (!focus) return
      // 上行/下行/制表/Ctrl 由 InputBar 自己的 useInput 处理（历史导航、热键）。
      if (key.upArrow || key.downArrow || key.tab || (key.shift && key.tab) || key.ctrl) return

      if (key.return) {
        onSubmit(valueRef.current)
        return
      }

      // 把按键归一化为一次光标编辑：左/右移动，退格/删除，或光标处插入（打字/粘贴）。
      // macOS Backspace 发 \x7f，被 Ink 映射成 key.delete（非 key.backspace），
      // 故 keyToEditAction 里两者都按向后删处理。
      const state: EditState = { value: valueRef.current, cursor: cursorRef.current }
      const action = keyToEditAction(key, input)
      if (!action) return

      const next = applyEdit(state, action)
      valueRef.current = next.value
      cursorRef.current = next.cursor
      setCursor(next.cursor)
      // 纯移动不通知父组件（文本未变），只在文本变化时 onChange。
      if (next.value !== state.value) onChange(next.value)
    },
    { isActive: focus },
  )

  return (
    <Text>
      {value.length === 0 && placeholder ? (
        <Text dimColor>{placeholder}</Text>
      ) : (
        <>
          {value.slice(0, cursor)}
          <Text inverse>{value[cursor] ?? ' '}</Text>
          {value.slice(cursor + 1)}
        </>
      )}
    </Text>
  )
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
  const valueRef = useRef(value)
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

  // 统一清理：清 suggestion + 使在途/待发请求失效 + 取消防抖定时器。
  // Escape / handleSubmit / 翻历史三处共用，避免各自手写漏掉某一环（rule of three）。
  const clearSuggestion = () => {
    setSuggestion(null)
    suggestionReqIdRef.current++
    if (suggestionTimerRef.current) {
      clearTimeout(suggestionTimerRef.current)
      suggestionTimerRef.current = null
    }
  }

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
      clearSuggestion()
      return
    }

    // ── Global hotkeys ──
    // Shift+Tab → cycle permission mode
    if (key.shift && key.tab) {
      onCyclePermission?.()
      return
    }
    // Tab → 接受 ghost-text 建议
    if (key.tab && !key.shift && suggestion) {
      const next = valueRef.current + suggestion
      setValue(next)
      valueRef.current = next
      setSuggestion(null)
      return
    }
    // Ctrl+P → toggle model picker
    // NOTE: Ink passes input=keypress.name (just 'p') when ctrl is true, not raw \x10.
    if (key.ctrl && input === 'p') {
      onTogglePicker?.()
      return
    }
    // Ctrl+F → toggle focus mode
    if (key.ctrl && input === 'f') {
      onToggleFocus?.()
      return
    }
    // Ctrl+O → expand/collapse last tool call
    if (key.ctrl && input === 'o') {
      onToggleExpand?.()
      return
    }
    // Ctrl+G → toggle agent view dashboard
    if (key.ctrl && input === 'g') {
      onToggleAgentView?.()
      return
    }

    // ── Arrow-key history navigation (Claude Code parity) ──
    if (key.upArrow || key.downArrow) {
      // History navigation changes value via setValue (no onChange) — clear any
      // ghost suggestion so a stale one isn't Tab-accepted onto a recalled entry.
      clearSuggestion()
      // Ignore if picker is active (command picker handles its own arrows)
      if (value.startsWith('/')) return

      const result = navigateHistory(
        {
          history: submittedHistory,
          index: historyIndexRef.current,
          savedDraft: savedDraftRef.current,
        },
        key.upArrow ? 'up' : 'down',
        valueRef.current,
      )
      if (result) {
        historyIndexRef.current = result.index
        savedDraftRef.current = result.savedDraft
        setValue(result.value)
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
    // Use the latest value from the ref; `val` is the value passed by MiphamTextInput.
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
    clearSuggestion()
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
        <MiphamTextInput
          value={value}
          onChange={(val) => {
            // Reset history browsing when user starts typing
            if (historyIndexRef.current !== -1) {
              historyIndexRef.current = -1
              savedDraftRef.current = ''
            }
            // ── Ghost-text 自动补全：每次输入清 suggestion + 重排防抖 ──
            setSuggestion(null)
            const suggestionReqId = ++suggestionReqIdRef.current
            if (suggestionTimerRef.current) {
              clearTimeout(suggestionTimerRef.current)
              suggestionTimerRef.current = null
            }
            if (llm && autocompleteEnabled && shouldAutocomplete(val, isLoading, pickerActive)) {
              suggestionTimerRef.current = setTimeout(() => {
                requestSuggestion(
                  llm,
                  recentMessages ?? [],
                  val,
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
            valueRef.current = val
            setValue(val)
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
