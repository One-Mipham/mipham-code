import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
import { readFileSync } from 'node:fs'
import type { QueryEngine } from '../core/engine'
import type { MiphamConfig } from '../shared/index.ts'
import type { SkillsLoader } from '../skills/loader'
import type { PluginManager } from '../plugin/plugin-manager'
import { setPreference } from '../config/preferences'
import { AgentRegistry } from '../agent/agent-registry'
import { getBackgroundAgentRegistry } from '../agent/background-registry'
import { ChatPanel } from './chat'
import { InputBar } from './input'
import { ModelPicker } from './picker'
import { AgentFooter, type AgentEntry } from './agent-footer'
import { AgentViewDashboard } from '../agent-view/dashboard'
import type { AgentViewManager } from '../agent-view/agent-view-manager'
import { WorkflowProgress } from './workflow-progress.js'
import {
  getCommand,
  looksLikeSlashCommand,
  parseSlashCommand,
  handleSwitch,
  type CommandContext,
} from './commands'
import { useI18n } from '../i18n-context'
import type { PermissionMode } from '../shared/index.ts'

interface AppProps {
  engine: QueryEngine
  config: MiphamConfig
  initialProvider?: string
  initialModel?: string
  lang?: string
  skillsLoader?: SkillsLoader
  pluginManager?: PluginManager
  version?: string
  sessionId?: string
  agentViewManager?: AgentViewManager
}

export interface ToolMeta {
  name: string
  input: string
  output?: string
  collapsed: boolean
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  toolMeta?: ToolMeta
}

interface AgentProgress {
  name: string
  description: string
  startTime: number
  tokensUsed?: number
  isTask?: boolean
  /** Unique identifier for multi-agent tracking. */
  id?: string
}

// Version is read fresh from package.json at startup via runApp prop
// (bypasses Bun module caching after npm update)

// Cycle order: Claude Code modes first (manual → accept edits → bypass),
// then Mipham-specific modes (plan → auto → dont ask).
const PERMISSION_MODES: PermissionMode[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'auto',
  'dontAsk',
]
// Labels aligned with Claude Code terminology: describe behavior, not capability.
// Claude Code modes: manual mode → accept edits on → bypass
// Mipham extends with 3 extra modes (plan, auto, dontAsk) for finer control.
const PERMISSION_COLORS: Record<PermissionMode, string> = {
  default: 'white',
  acceptEdits: 'blue',
  plan: 'yellow',
  auto: 'green',
  dontAsk: 'cyan',
  bypassPermissions: 'red',
}

/** Format a tool's input parameters into a compact one-line detail string. */
function formatToolDetail(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return (input.command as string) || ''
    case 'Read':
      return (input.file_path as string) || ''
    case 'Write':
      return (input.file_path as string) || ''
    case 'Edit':
      return (input.file_path as string) || ''
    case 'Grep':
      return (input.pattern as string) || ''
    case 'Glob':
      return (input.pattern as string) || ''
    case 'Agent':
      return `${(input.subagent_type as string) || 'general'}, "${((input.description as string) || (input.prompt as string) || '').slice(0, 80)}"`
    case 'WebSearch':
      return (input.query as string) || ''
    case 'WebFetch':
      return (input.url as string) || ''
    case 'Task':
      return `"${(input.subject as string) || ''}"`
    default:
      return JSON.stringify(input).slice(0, 80)
  }
}

export function App({
  engine,
  config,
  initialProvider,
  initialModel,
  lang: _lang,
  skillsLoader,
  pluginManager,
  version,
  sessionId,
  agentViewManager,
}: AppProps) {
  const { t } = useI18n()
  const PERMISSION_LABELS = useMemo<Record<PermissionMode, string>>(
    () => ({
      default: t('ui.permission.manual'),
      acceptEdits: t('ui.permission.accept_edits'),
      plan: t('ui.permission.plan_mode'),
      auto: t('ui.permission.auto'),
      dontAsk: t('ui.permission.dont_ask'),
      bypassPermissions: t('ui.permission.bypass'),
    }),
    [t],
  )
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [providerId, setProviderId] = useState(initialProvider || config.defaultProvider)
  const [modelId, setModelId] = useState(initialModel || config.defaultModel)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [agentViewOpen, setAgentViewOpen] = useState(false)
  const [_sessionTitle, setSessionTitle] = useState('')
  const [_fastMode, setFastMode] = useState(false)
  const [_effort, setEffort] = useState('high')
  const [focusMode, setFocusMode] = useState(false)
  const [_ultracodeMode, setUltracodeMode] = useState(false)
  const [goalText, setGoalText] = useState('')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default')
  const abortRef = useRef<AbortController | null>(null)
  // Stream buffer: accumulate text chunks and throttle state updates to ~16fps.
  // Without this, every SSE chunk triggers setMessages → copies full array →
  // re-renders ChatPanel → re-runs compactToolGroups O(n). At 20-50 chunks/sec
  // with 200+ messages, this saturates the event loop and freezes the UI.
  const streamBufferRef = useRef<{
    turnContent: string
    isFirst: boolean
    timer: ReturnType<typeof setTimeout> | null
  }>({ turnContent: '', isFirst: true, timer: null })
  const [agentProgress, setAgentProgress] = useState<AgentProgress | null>(null)
  // Multi-agent tracking: keyed by agent/task ID, shows all running + recently completed agents
  const [runningAgents, setRunningAgents] = useState<Record<string, AgentEntry>>({})
  const [gitBranch, setGitBranch] = useState('')
  const [agentTick, setAgentTick] = useState(0)

  // Detect git branch on mount
  useEffect(() => {
    try {
      const head = readFileSync('.git/HEAD', 'utf8').trim()
      const m = head.match(/^ref: refs\/heads\/(.+)$/)
      setGitBranch(m ? m[1]! : head.slice(0, 7))
    } catch {
      // Not a git repo — leave empty
    }
  }, [])

  // Tick timer for agent elapsed displays (re-renders every second while agents are running)
  useEffect(() => {
    const hasRunning =
      Object.values(runningAgents).some((a) => a.status === 'running') || agentProgress !== null
    if (!hasRunning) return
    const i = setInterval(() => setAgentTick((t) => t + 1), 1000)
    return () => clearInterval(i)
  }, [runningAgents, agentProgress])

  // Sync running agents from BackgroundAgentRegistry into React state.
  // Called after Agent tool results and task notifications to keep the footer current.
  const syncBgAgents = useCallback(() => {
    const bgRegistry = getBackgroundAgentRegistry()
    const all = bgRegistry.list()
    setRunningAgents((prev) => {
      const next: Record<string, AgentEntry> = {}
      for (const task of all) {
        // Preserve existing entry if it has more data (e.g. tokens accumulated during streaming)
        const existing = prev[task.id]
        next[task.id] = {
          id: task.id,
          name: existing?.name || task.agentType.charAt(0).toUpperCase() + task.agentType.slice(1),
          description: existing?.description || task.description,
          startTime: existing?.startTime || task.startedAt.getTime(),
          tokensUsed: existing?.tokensUsed || 0,
          status: task.status === 'running' ? 'running' : 'completed',
        }
      }
      return next
    })

    // Register onComplete for running tasks to auto-dismiss them
    for (const task of all) {
      if (task.status === 'running') {
        bgRegistry.onComplete(task.id, () => {
          setRunningAgents((prev) => {
            const next = { ...prev }
            if (next[task.id]) {
              next[task.id] = { ...next[task.id], status: 'completed' } as AgentEntry
            }
            return next
          })
          // Auto-dismiss after 5 seconds
          setTimeout(() => {
            setRunningAgents((prev) => {
              const next = { ...prev }
              delete next[task.id]
              return next
            })
          }, 5000)
        })
      }
    }
  }, [])

  // Initialize agent registry (one-time, on mount)
  useMemo(() => {
    // Agent registry may already be initialized in index.tsx (for plugin loading).
    // Only create a fresh one if not already set on the engine.
    if (!engine.getAgentRegistry()) {
      const agentRegistry = new AgentRegistry()
      agentRegistry.loadUserAgents()
      agentRegistry.loadProjectAgents(process.cwd())
      engine.setAgentRegistry(agentRegistry)
    }
  }, [])

  const mkCtx = useCallback(
    (): CommandContext => ({
      engine,
      config,
      providerId,
      modelId,
      version: version || '0.0.0',
      sessionId: sessionId || '',
      setSessionTitle: (title: string) => setSessionTitle(title),
      setFastMode: (on: boolean) => setFastMode(on),
      setEffort: (level: string) => {
        setEffort(level)
        setPreference('lastCodeReviewEffort', level)
      },
      setFocusMode: (on: boolean) => setFocusMode(on),
      setGoal: (text: string) => setGoalText(text),
      setUltracodeMode: (on: boolean) => setUltracodeMode(on),
      skillsLoader,
      pluginManager,
      t,
    }),
    [engine, config, providerId, modelId, skillsLoader, pluginManager, sessionId, t],
  )

  const handleSubmit = useCallback(
    async (input: string) => {
      if (!input.trim()) return

      // ── Slash command dispatch ──
      if (looksLikeSlashCommand(input)) {
        const { command, args } = parseSlashCommand(input)

        // /switch takes args, handled separately
        if (command === '/switch') {
          const result = await handleSwitch(mkCtx(), args)
          setMessages((prev) => [
            ...prev,
            { role: 'user', content: input },
            { role: 'system', content: result.content },
          ])
          if (result.nextProvider) setProviderId(result.nextProvider)
          if (result.nextModel) setModelId(result.nextModel)
          if (result.exit) process.exit(0)
          return
        }

        // /pick → open interactive model picker
        if (command === '/pick' || command === '/model-picker') {
          setPickerOpen(true)
          return
        }

        // /quit and /exit are special
        if (command === '/exit' || command === '/quit') {
          process.exit(0)
        }

        // /focus toggle
        if (command === '/focus') {
          const nextFocus = !focusMode
          setFocusMode(nextFocus)
          setMessages((prev) => [
            ...prev,
            { role: 'user', content: input },
            {
              role: 'system',
              content: nextFocus
                ? '✓ Focus mode ON — showing only the most recent exchange. Type /focus again to show all.'
                : '✓ Focus mode OFF — showing all messages.',
            },
          ])
          return
        }

        let forwardToAI: string | undefined

        const handler = getCommand(command)
        if (handler) {
          const result = await handler(mkCtx(), args)
          forwardToAI = result.forwardToAI
          setMessages((prev) => [
            ...prev,
            { role: 'user', content: input },
            { role: 'system', content: result.content },
          ])
          if (result.clearMessages) setMessages([])
          if (result.nextProvider) setProviderId(result.nextProvider)
          if (result.nextModel) setModelId(result.nextModel)
          if (result.exit) process.exit(0)
          if (result.forwardedMessages && result.forwardedMessages.length > 0) {
            const restored: ChatMessage[] = result.forwardedMessages.map((msg) => ({
              role: msg.role,
              content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            }))
            setMessages((prev) => [...prev, ...restored])
          }
          if (result.copyContent) {
            // Copy to clipboard via pbcopy (macOS) or clip (Windows)
            try {
              const { execSync } = await import('node:child_process')
              if (process.platform === 'darwin') {
                execSync('pbcopy', { input: result.copyContent })
              } else if (process.platform === 'win32') {
                execSync('clip', { input: result.copyContent })
              }
              // Linux: xclip or wl-copy not attempted to avoid dependency issues
            } catch {
              // Silent fail — content is still displayed
            }
          }
        }

        // Bridge: if command set forwardToAI, route the message to AI processing
        if (forwardToAI) {
          input = forwardToAI
          // fall through to normal AI processing below
        } else {
          // No handler matched or handler didn't request AI routing — stop here
          return
        }
      }

      // ── Normal message processing (AI chat) ──
      setMessages((prev) => [...prev, { role: 'user', content: input }])
      setIsLoading(true)

      const controller = new AbortController()
      abortRef.current = controller

      let assistantContent = ''
      // Track whether we've started a new assistant turn — reset accumulator per turn
      let turnContent = ''
      let isNewTurn = true

      // Flush any pending stream buffer to state
      const flushStreamBuffer = () => {
        if (streamBufferRef.current.timer) {
          clearTimeout(streamBufferRef.current.timer)
          streamBufferRef.current.timer = null
        }
        const latest = streamBufferRef.current.turnContent
        if (latest && !streamBufferRef.current.isFirst) {
          setMessages((prev) => {
            const updated = [...prev]
            const last = updated[updated.length - 1]
            if (last?.role === 'assistant') {
              last.content = latest
            }
            return updated
          })
        }
      }

      try {
        for await (const chunk of engine.process(input, controller.signal)) {
          // Reasoning content (DeepSeek V4 thinking mode) — silently consumed,
          // not shown to user to avoid noise.
          if (chunk.reasoning_content) {
            continue
          }

          if (chunk.type === 'text' && chunk.content) {
            // New turn: push fresh assistant message, reset stream buffer
            if (isNewTurn) {
              turnContent = chunk.content
              isNewTurn = false
              streamBufferRef.current = { turnContent: chunk.content, isFirst: false, timer: null }
              setMessages((prev) => [
                ...prev,
                { role: 'assistant' as const, content: chunk.content || '' },
              ])
            } else {
              turnContent += chunk.content
              streamBufferRef.current.turnContent = turnContent
              // Throttle: flush to state at most every 60ms (~16 fps for text).
              // The ref holds the latest text; state update copies the ref value.
              if (!streamBufferRef.current.timer) {
                streamBufferRef.current.timer = setTimeout(() => {
                  streamBufferRef.current.timer = null
                  const latest = streamBufferRef.current.turnContent
                  setMessages((prev) => {
                    const updated = [...prev]
                    const last = updated[updated.length - 1]
                    if (last?.role === 'assistant') {
                      last.content = latest
                    }
                    return updated
                  })
                }, 60)
              }
            }
            assistantContent += chunk.content
          }

          if (chunk.type === 'tool_use' && chunk.toolUse) {
            const toolName = chunk.toolUse.name
            const isAgent = toolName === 'Agent' || toolName === 'Task'
            const detail = formatToolDetail(toolName, chunk.toolUse.input)

            if (isAgent) {
              setAgentProgress({
                name: detail || (chunk.toolUse.input.subagent_type as string) || 'General-purpose',
                description:
                  (chunk.toolUse.input.description as string) ||
                  (chunk.toolUse.input.prompt as string) ||
                  '',
                startTime: Date.now(),
              })
            }

            // Show tool call as a visible, collapsed message
            setMessages((prev) => [
              ...prev,
              {
                role: 'system' as const,
                content: detail,
                toolMeta: { name: toolName, input: detail, collapsed: true },
              },
            ])
            // Flush stream buffer before showing tool card
            flushStreamBuffer()
            // Mark that next text chunk starts a new turn
            isNewTurn = true
          }

          if (chunk.type === 'tool_result') {
            setAgentProgress(null)
            // Sync background agents (e.g. Agent tool may have spawned them)
            syncBgAgents()
            // Only show tool results with meaningful content.
            // Skip empty results, "(no matches)", and other noise.
            const output = chunk.content ? String(chunk.content).trim() : ''
            if (output && output !== '(no matches)' && output.length > 20) {
              const firstLine = output.split('\n')[0]!.slice(0, 200)
              const preview = firstLine.length < output.length ? `${firstLine}...` : firstLine
              setMessages((prev) => [
                ...prev,
                {
                  role: 'system' as const,
                  content: `  ⎿  ${preview}`,
                  toolMeta: { name: '', input: '', output: preview, collapsed: true },
                },
              ])
            }
          }

          if (chunk.type === 'usage' && agentProgress) {
            const totalTokens = (chunk.inputTokens || 0) + (chunk.outputTokens || 0)
            if (totalTokens > 0) {
              setAgentProgress((prev) =>
                prev ? { ...prev, tokensUsed: (prev.tokensUsed || 0) + totalTokens } : null,
              )
            }
          }

          if (chunk.type === 'error') {
            setMessages((prev) => [
              ...prev,
              { role: 'system', content: `❌ Error: ${chunk.error}` },
            ])
          }

          if (chunk.type === 'task_notification' && chunk.taskNotification) {
            const tn = chunk.taskNotification
            const isDone = tn.status === 'completed'
            const symbol = isDone ? '◼' : '✳'
            const preview = tn.content
              ? tn.content.slice(0, 120) + (tn.content.length > 120 ? '...' : '')
              : tn.error
                ? `Error: ${tn.error.slice(0, 120)}`
                : '(no output)'
            setMessages((prev) => [
              ...prev,
              {
                role: 'system',
                content: `${symbol} ${tn.description}${isDone ? ` · finished` : ''}`,
                toolMeta: {
                  name: isDone ? '' : 'task',
                  input: tn.description || '',
                  output: preview,
                  collapsed: isDone,
                },
              },
            ])
            // Sync agent footer — mark completed background agents
            syncBgAgents()
          }
        }
      } catch (err) {
        setMessages((prev) => [...prev, { role: 'system', content: `Error: ${String(err)}` }])
      } finally {
        // Flush any remaining stream buffer before finishing
        flushStreamBuffer()
        setIsLoading(false)
        abortRef.current = null
        // Auto-save checkpoint after each AI response
        if (assistantContent) {
          engine.getContext().saveCheckpoint('post-turn')
        }
        // Final sync of background agents after the turn completes
        syncBgAgents()
      }
    },
    [engine, mkCtx, syncBgAgents],
  )

  useInput((_input, key) => {
    // Escape: close picker → abort loading (does NOT exit app)
    // Vim mode toggle is handled by InputBar
    if (key.escape) {
      if (pickerOpen) {
        setPickerOpen(false)
        return
      }
      if (isLoading && abortRef.current) {
        abortRef.current.abort()
        return
      }
      // When input is empty and not loading, let InputBar handle Escape
      // (it toggles vim mode or clears pending sequences)
      return
    }
    // All other global hotkeys (Shift+Tab, Ctrl+P, Ctrl+F, Ctrl+O)
    // are handled in InputBar to avoid ink-text-input conflicts
  })

  return (
    <Box flexDirection="column" padding={1} height="100%">
      {/* Header — left-aligned */}
      <Box flexDirection="column" marginBottom={1}>
        <Text color="#FFD700" bold>
          Mipham Code
        </Text>
        <Text dimColor>v{version || '0.0.0'}</Text>
        <Text dimColor>{modelId}</Text>
      </Box>

      {/* Workflow progress — auto-detects active workflows, renders nothing when idle */}
      <WorkflowProgress />

      {/* Agent View Dashboard — Ctrl+G overlay (replaces chat + input) */}
      {agentViewOpen && agentViewManager ? (
        <AgentViewDashboard
          manager={agentViewManager}
          onAttach={() => {}}
          onExit={() => setAgentViewOpen(false)}
        />
      ) : (
        <>
          {/* Chat panel */}
          <ChatPanel messages={messages} focusMode={focusMode} />

          {/* Input with separator lines */}
          {pickerOpen ? (
            <ModelPicker
              config={config}
              currentProvider={providerId}
              currentModel={modelId}
              onSelect={(newProvider, newModel) => {
                engine.switchProvider(newProvider, newModel)
                setProviderId(newProvider)
                setModelId(newModel)
                setPickerOpen(false)
                setMessages((prev) => [
                  ...prev,
                  { role: 'system', content: `✓ Switched to ${newProvider}/${newModel}` },
                ])
              }}
              onClose={() => setPickerOpen(false)}
            />
          ) : (
            /* Input bar (hidden when picker is open) */
            <Box flexDirection="column">
              <Text dimColor>──────────────────────────────</Text>
              <InputBar
                onSubmit={handleSubmit}
                isLoading={isLoading}
                onTogglePicker={() => setPickerOpen((prev) => !prev)}
                onToggleFocus={() => setFocusMode((prev) => !prev)}
                onToggleExpand={() => {
                  setMessages((prev) => {
                    const msgs = [...prev]
                    for (let i = msgs.length - 1; i >= 0; i--) {
                      if (msgs[i]?.toolMeta) {
                        const meta = msgs[i]!.toolMeta!
                        if (meta.collapsed) {
                          msgs[i] = {
                            ...msgs[i]!,
                            content: `🔧 ${meta.name}: ${meta.input}\n📋 Result: ${meta.output || '(pending)'}`,
                            toolMeta: { ...meta, collapsed: false },
                          }
                        } else {
                          const short =
                            meta.input.length > 50 ? meta.input.slice(0, 50) + '...' : meta.input
                          msgs[i] = {
                            ...msgs[i]!,
                            content: `⏺ ${meta.name} · ${short} (Ctrl+O to expand)`,
                            toolMeta: { ...meta, collapsed: true },
                          }
                        }
                        break
                      }
                    }
                    return msgs
                  })
                }}
                onCyclePermission={() => {
                  setPermissionMode((prev) => {
                    const idx = PERMISSION_MODES.indexOf(prev)
                    const next = PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length]!
                    engine.getPermission().setMode(next)
                    return next
                  })
                }}
                onCancel={() => {
                  if (abortRef.current) {
                    abortRef.current.abort()
                  }
                }}
                onToggleAgentView={() => setAgentViewOpen((prev) => !prev)}
              />
              <Text dimColor>──────────────────────────────</Text>
            </Box>
          )}

          {/* Agent status footer — shows running background agents */}
          <AgentFooter
            agents={Object.values(runningAgents)}
            gitBranch={gitBranch}
            tick={agentTick}
          />

          {/* Status line — Claude Code style */}
          <Box marginTop={1} flexDirection="column">
            {goalText && (
              <Box>
                <Text color="green">🎯 Goal: {goalText}</Text>
              </Box>
            )}
            <Box flexDirection="row">
              <Text color={PERMISSION_COLORS[permissionMode]}>
                ⏵⏵ {PERMISSION_LABELS[permissionMode]} ({t('ui.status.shift_tab_cycle')})
              </Text>
              <Text dimColor> · {t('ui.status.esc_to_interrupt')}</Text>
              <Text dimColor> · {t('ui.status.left_for_agents')}</Text>
            </Box>
            {/* Mipham-unique modes (extends Claude Code's 3 → 6 modes) */}
            <Box>
              <Text dimColor>
                {t('ui.status.mipham_modes')}: {PERMISSION_LABELS.plan} · {PERMISSION_LABELS.auto} ·{' '}
                {PERMISSION_LABELS.dontAsk}
              </Text>
            </Box>
          </Box>
        </>
      )}
    </Box>
  )
}
