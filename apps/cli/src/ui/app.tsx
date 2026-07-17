import React, { useState, useCallback, useRef, useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
import type { QueryEngine } from '../core/engine'
import type { MiphamConfig } from '../shared/index.ts'
import type { SkillsLoader } from '../skills/loader'
import { AgentRegistry } from '../agent/agent-registry'
import { ChatPanel } from './chat'
import { InputBar } from './input'
import { ModelPicker } from './picker'
import {
  getCommand,
  looksLikeSlashCommand,
  parseSlashCommand,
  handleSwitch,
  type CommandContext,
} from './commands'

interface AppProps {
  engine: QueryEngine
  config: MiphamConfig
  initialProvider?: string
  initialModel?: string
  lang?: string
  skillsLoader?: SkillsLoader
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
}

import { PACKAGE_VERSION } from '../shared/index.ts'

const VERSION = PACKAGE_VERSION

type PermissionMode = 'auto' | 'ask' | 'bypass'

const PERMISSION_MODES: PermissionMode[] = ['auto', 'ask', 'bypass']
const PERMISSION_LABELS: Record<PermissionMode, string> = {
  auto: 'auto mode on',
  ask: 'ask mode (confirm each action)',
  bypass: 'bypass mode (skip all checks)',
}

export function App({
  engine,
  config,
  initialProvider,
  initialModel,
  lang: _lang,
  skillsLoader,
}: AppProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [providerId, setProviderId] = useState(initialProvider || config.defaultProvider)
  const [modelId, setModelId] = useState(initialModel || config.defaultModel)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [sessionTitle, setSessionTitle] = useState('')
  const [fastMode, setFastMode] = useState(false)
  const [effort, setEffort] = useState('high')
  const [focusMode, setFocusMode] = useState(false)
  const [goalText, setGoalText] = useState('')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('auto')
  const abortRef = useRef<AbortController | null>(null)
  const [agentProgress, setAgentProgress] = useState<AgentProgress | null>(null)
  const [agentElapsed, setAgentElapsed] = useState(0)

  // Agent elapsed timer
  React.useEffect(() => {
    if (!agentProgress) {
      setAgentElapsed(0)
      return
    }
    const interval = setInterval(() => {
      setAgentElapsed(Math.floor((Date.now() - agentProgress.startTime) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [agentProgress])

  // Initialize agent registry (one-time, on mount)
  useMemo(() => {
    const agentRegistry = new AgentRegistry()
    agentRegistry.loadUserAgents()
    agentRegistry.loadProjectAgents(process.cwd())
    engine.setAgentRegistry(agentRegistry)
  }, [])

  const mkCtx = useCallback(
    (): CommandContext => ({
      engine,
      config,
      providerId,
      modelId,
      version: VERSION,
      setSessionTitle: (title: string) => setSessionTitle(title),
      setFastMode: (on: boolean) => setFastMode(on),
      setEffort: (level: string) => setEffort(level),
      setFocusMode: (on: boolean) => setFocusMode(on),
      setGoal: (text: string) => setGoalText(text),
      skillsLoader,
    }),
    [engine, config, providerId, modelId, skillsLoader],
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

        const handler = getCommand(command)
        if (handler) {
          const result = await handler(mkCtx(), args)
          setMessages((prev) => [
            ...prev,
            { role: 'user', content: input },
            { role: 'system', content: result.content },
          ])
          if (result.clearMessages) setMessages([])
          if (result.nextProvider) setProviderId(result.nextProvider)
          if (result.nextModel) setModelId(result.nextModel)
          if (result.exit) process.exit(0)
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
        // Unknown slash command or handler returned: proceed to normal AI processing
        return
      }

      // ── Normal message processing (AI chat) ──
      setMessages((prev) => [...prev, { role: 'user', content: input }])
      setIsLoading(true)

      const controller = new AbortController()
      abortRef.current = controller

      let assistantContent = ''

      try {
        for await (const chunk of engine.process(input, controller.signal)) {
          if (chunk.type === 'text' && chunk.content) {
            assistantContent += chunk.content
            setMessages((prev) => {
              const updated = [...prev]
              const last = updated[updated.length - 1]
              if (last?.role === 'assistant') {
                last.content = assistantContent
              } else {
                updated.push({ role: 'assistant', content: assistantContent })
              }
              return updated
            })
          }

          if (chunk.type === 'tool_use' && chunk.toolUse) {
            const toolName = chunk.toolUse.name
            const inputStr = JSON.stringify(chunk.toolUse.input)
            const isAgent = toolName === 'Agent' || toolName === 'Task'

            if (isAgent) {
              setAgentProgress({
                name: (chunk.toolUse.input.subagent_type as string) || 'General-purpose',
                description:
                  (chunk.toolUse.input.description as string) ||
                  (chunk.toolUse.input.prompt as string) ||
                  '',
                startTime: Date.now(),
              })
            }

            const collapsed = toolName !== 'Agent' // agents always expanded
            setMessages((prev) => [
              ...prev,
              {
                role: 'system',
                content: collapsed
                  ? `⏺ ${toolName} · ${inputStr.slice(0, 50)}${inputStr.length > 50 ? '...' : ''} (Ctrl+O to expand)`
                  : `🔧 ${toolName}: ${inputStr.slice(0, 200)}`,
                toolMeta: { name: toolName, input: inputStr, collapsed },
              },
            ])
          }

          if (chunk.type === 'tool_result') {
            setAgentProgress(null)
            setMessages((prev) => {
              const updated = [...prev]
              for (let i = updated.length - 1; i >= 0; i--) {
                if (updated[i]?.toolMeta && !updated[i]!.toolMeta!.output) {
                  updated[i] = {
                    ...updated[i]!,
                    content: updated[i]!.toolMeta!.collapsed
                      ? updated[i]!.content
                      : `📋 ${updated[i]!.toolMeta!.name} result: ${(chunk.content || '(empty)').slice(0, 200)}`,
                    toolMeta: { ...updated[i]!.toolMeta!, output: chunk.content || '' },
                  }
                  break
                }
              }
              return updated
            })
          }

          if (chunk.type === 'error') {
            setMessages((prev) => [
              ...prev,
              { role: 'system', content: `❌ Error: ${chunk.error}` },
            ])
          }
        }
      } catch (err) {
        setMessages((prev) => [...prev, { role: 'system', content: `Error: ${String(err)}` }])
      } finally {
        setIsLoading(false)
        abortRef.current = null
        // Auto-save checkpoint after each AI response
        if (assistantContent) {
          engine.getContext().saveCheckpoint('post-turn')
        }
      }
    },
    [engine, mkCtx],
  )

  useInput((_input, key) => {
    // Global hotkeys
    if (key.escape) {
      if (pickerOpen) {
        setPickerOpen(false)
        return
      }
      if (isLoading && abortRef.current) {
        abortRef.current.abort()
        return
      }
      process.exit(0)
    }
    // Ctrl+P → open model picker
    if (_input === '\x10') {
      setPickerOpen((prev) => !prev)
      return
    }
    // Ctrl+O → toggle last tool call expand/collapse
    if (_input === '\x0f') {
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
              const short = meta.input.length > 50 ? meta.input.slice(0, 50) + '...' : meta.input
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
      return
    }
    // Shift+Tab → cycle permission mode (auto → ask → bypass → auto)
    if (key.shift && key.tab) {
      setPermissionMode((prev) => {
        const idx = PERMISSION_MODES.indexOf(prev)
        const next = PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length]!
        // Sync to engine
        engine.getPermission().setDefaultLevel(next)
        return next
      })
      return
    }
  })

  return (
    <Box flexDirection="column" padding={1} height="100%">
      {/* Agent progress banner */}
      {agentProgress && (
        <Box flexDirection="column" marginY={1}>
          <Text color="cyan" bold>
            ⏺ {agentProgress.name} <Text color="yellow">{agentElapsed}s</Text>
          </Text>
          <Text dimColor>
            {agentProgress.description.length > 100
              ? `"${agentProgress.description.slice(0, 100)}..."`
              : `"${agentProgress.description}"`}
          </Text>
        </Box>
      )}

      {/* Chat panel */}
      <ChatPanel messages={messages} focusMode={focusMode} />

      {/* Model picker (replaces input when open) */}
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
        <InputBar onSubmit={handleSubmit} isLoading={isLoading} />
      )}

      {/* Footer — brand mark + status line */}
      <Box marginTop={1} flexDirection="column">
        {goalText && (
          <Box>
            <Text color="green">🎯 Goal: {goalText}</Text>
          </Box>
        )}
        <Box flexDirection="row">
          <Text dimColor>
            {modelId} ({providerId}){fastMode && ' ⚡'}
            {effort !== 'high' && ` 🧠${effort}`}
            {focusMode && ' 🔍focus'}
          </Text>
        </Box>
        <Box flexDirection="row">
          <Text
            color={
              permissionMode === 'auto' ? 'green' : permissionMode === 'ask' ? 'yellow' : 'red'
            }
          >
            ● {PERMISSION_LABELS[permissionMode]}
          </Text>
          <Text dimColor> (Shift+Tab to cycle)</Text>
          <Text dimColor> · Ctrl+P pick · /help · Esc cancel</Text>
        </Box>
      </Box>
    </Box>
  )
}
