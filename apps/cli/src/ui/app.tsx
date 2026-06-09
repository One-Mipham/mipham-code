import React, { useState, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'
import type { QueryEngine } from '../core/engine'
import type { MiphamConfig } from './shared/index.ts'
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
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

const VERSION = '0.1.0'

export function App({ engine, config, initialProvider, initialModel, lang }: AppProps) {
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
    }),
    [engine, config, providerId, modelId],
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
          setMessages(prev => [...prev, { role: 'user', content: input }, { role: 'system', content: result.content }])
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
          setMessages(prev => [
            ...prev,
            { role: 'user', content: input },
            { role: 'system', content: nextFocus
              ? '✓ Focus mode ON — showing only the most recent exchange. Type /focus again to show all.'
              : '✓ Focus mode OFF — showing all messages.' },
          ])
          return
        }

        const handler = getCommand(command)
        if (handler) {
          const result = await handler(mkCtx(), args)
          setMessages(prev => [...prev, { role: 'user', content: input }, { role: 'system', content: result.content }])
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
      setMessages(prev => [...prev, { role: 'user', content: input }])
      setIsLoading(true)

      let assistantContent = ''

      try {
        for await (const chunk of engine.process(input)) {
          if (chunk.type === 'text' && chunk.content) {
            assistantContent += chunk.content
            setMessages(prev => {
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
            setMessages(prev => [
              ...prev,
              { role: 'system', content: `🔧 Using tool: ${chunk.toolUse!.name}(${JSON.stringify(chunk.toolUse!.input)})` },
            ])
          }

          if (chunk.type === 'tool_result') {
            const resultPreview =
              chunk.content && chunk.content.length > 200
                ? chunk.content.slice(0, 200) + '...'
                : chunk.content || '(empty)'
            setMessages(prev => [
              ...prev,
              { role: 'system', content: `📋 Tool result: ${resultPreview}` },
            ])
          }

          if (chunk.type === 'error') {
            setMessages(prev => [
              ...prev,
              { role: 'system', content: `❌ Error: ${chunk.error}` },
            ])
          }
        }
      } catch (err) {
        setMessages(prev => [
          ...prev,
          { role: 'system', content: `Error: ${String(err)}` },
        ])
      } finally {
        setIsLoading(false)
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
      process.exit(0)
    }
    // Ctrl+P → open model picker
    if (_input === '\x10') {
      setPickerOpen(prev => !prev)
      return
    }
  })

  return (
    <Box flexDirection="column" padding={1} height="100%">
      {/* Header — brand mark + status line */}
      <Box marginBottom={1} flexDirection="column">
        <Box flexDirection="row">
          <Text bold color="cyan">Mipham Code</Text>
          <Text dimColor> v0.1.0</Text>
          {sessionTitle ? <Text color="yellow"> — {sessionTitle}</Text> : <Text dimColor> — MiphamAI</Text>}
        </Box>
        <Box flexDirection="row">
          <Text dimColor>
            {modelId} ({providerId})
            {fastMode && ' ⚡'}
            {effort !== 'high' && ` 🧠${effort}`}
            {focusMode && ' 🔍focus'}
            {' · '}Ctrl+P pick · /help · Esc exit
          </Text>
        </Box>
        {goalText && (
          <Box>
            <Text color="green">🎯 Goal: {goalText}</Text>
          </Box>
        )}
      </Box>

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
            setMessages(prev => [
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
    </Box>
  )
}
