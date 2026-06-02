import React, { useState, useCallback, useEffect } from 'react'
import { Box, Text, useInput } from 'ink'
import type { MiphamConfig, ProviderConfig, ModelInfo } from './shared/index.ts'

interface PickerProps {
  config: MiphamConfig
  currentProvider: string
  currentModel: string
  onSelect: (providerId: string, modelId: string) => void
  onClose: () => void
}

type Panel = 'provider' | 'model'

export function ModelPicker({ config, currentProvider, currentModel, onSelect, onClose }: PickerProps) {
  // Get active providers only
  const providers = config.providers.filter(p => p.status !== 'upcoming')
  const activeModels = (p: ProviderConfig) => p.models.filter(m => m.status === 'active')

  // State
  const [activePanel, setActivePanel] = useState<Panel>('provider')
  const [providerIdx, setProviderIdx] = useState(() => {
    const idx = providers.findIndex(p => p.id === currentProvider)
    return idx >= 0 ? idx : 0
  })
  const [modelIdx, setModelIdx] = useState(0)

  const selectedProvider = providers[providerIdx]
  const models = selectedProvider ? activeModels(selectedProvider) : []

  // Reset model index when provider changes
  const goToProvider = useCallback((idx: number) => {
    const wrapped = ((idx % providers.length) + providers.length) % providers.length
    setProviderIdx(wrapped)
    setModelIdx(0)
    setActivePanel('model') // auto-switch to model panel
  }, [providers.length])

  const selectModel = useCallback((idx: number) => {
    if (!selectedProvider) return
    const wrapped = ((idx % models.length) + models.length) % models.length
    setModelIdx(wrapped)
  }, [selectedProvider, models.length])

  const confirmSelection = useCallback(() => {
    if (!selectedProvider) return
    const model = models[modelIdx]
    if (model) {
      onSelect(selectedProvider.id, model.id)
    }
  }, [selectedProvider, models, modelIdx, onSelect])

  useInput((input, key) => {
    // Global keys
    if (key.escape) {
      onClose()
      return
    }

    if (key.return) {
      if (activePanel === 'provider') {
        goToProvider(providerIdx) // switches to model panel
      } else {
        confirmSelection()
      }
      return
    }

    // Tab or right arrow → switch to model panel
    if (key.tab || (activePanel === 'provider' && input === 'l')) {
      setActivePanel('model')
      return
    }

    // Left arrow → switch to provider panel
    if (key.leftArrow || (activePanel === 'model' && input === 'h')) {
      setActivePanel('provider')
      return
    }

    // Up/Down navigation
    if (key.upArrow) {
      if (activePanel === 'provider') {
        setProviderIdx(((providerIdx - 1 + providers.length) % providers.length))
      } else {
        selectModel(modelIdx - 1)
      }
      return
    }

    if (key.downArrow) {
      if (activePanel === 'provider') {
        setProviderIdx(((providerIdx + 1) % providers.length))
      } else {
        selectModel(modelIdx + 1)
      }
      return
    }
  })

  // Provider labels
  const providerColor = (p: ProviderConfig) =>
    p.id === currentProvider ? 'green' : 'white'

  const modelColor = (m: ModelInfo) =>
    selectedProvider?.id === currentProvider && m.id === currentModel ? 'green' : 'white'

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1}>
      {/* Title */}
      <Box marginBottom={1}>
        <Text bold color="cyan">Select Model</Text>
        <Text dimColor>  ←→ navigate · ↑↓ move · Enter select · Esc close</Text>
      </Box>

      {/* Two-column layout */}
      <Box flexDirection="row" gap={4}>
        {/* ── Provider Panel (一级) ── */}
        <Box flexDirection="column" width={28} borderStyle="single" borderColor={activePanel === 'provider' ? 'cyan' : 'gray'} padding={1}>
          <Text bold underline dimColor>PROVIDER {activePanel === 'provider' ? '◀' : ''}</Text>
          {providers.map((p, i) => {
            const isCurrent = p.id === currentProvider
            const isSelected = i === providerIdx
            const isUpcoming = p.status === 'upcoming'
            return (
              <Box key={p.id}>
                <Text color={isUpcoming ? 'gray' : isSelected ? 'cyan' : providerColor(p)} bold={isSelected}>
                  {isSelected ? '▶ ' : '  '}
                  {isCurrent ? '✓' : ' '}
                  {p.name.padEnd(16)}
                </Text>
                <Text dimColor>{isUpcoming ? '[coming]' : `${activeModels(p).length}m`}</Text>
              </Box>
            )
          })}
        </Box>

        {/* ── Model Panel (二级) ── */}
        <Box flexDirection="column" width={42} borderStyle="single" borderColor={activePanel === 'model' ? 'cyan' : 'gray'} padding={1}>
          <Text bold underline dimColor>
            MODELS {activePanel === 'model' ? '◀' : ''}
            {selectedProvider ? ` — ${selectedProvider.name}` : ''}
          </Text>
          {models.length === 0 && (
            <Text dimColor>  (no active models)</Text>
          )}
          {models.map((m, i) => {
            const isCurrentModel = selectedProvider?.id === currentProvider && m.id === currentModel
            const isSelected = i === modelIdx
            return (
              <Box key={m.id} flexDirection="column">
                <Text color={isCurrentModel ? 'green' : isSelected ? 'cyan' : 'white'} bold={isSelected}>
                  {isSelected ? '▶ ' : '  '}
                  {isCurrentModel ? '✓' : ' '}
                  {m.name}
                </Text>
                <Text dimColor>
                  {'   '}
                  {m.id} · {m.contextWindow.toLocaleString()} ctx
                  {m.vision ? ' · 🖼 vision' : ''}
                </Text>
              </Box>
            )
          })}
        </Box>
      </Box>

      {/* Footer hint */}
      <Box marginTop={1}>
        <Text dimColor>
          {activePanel === 'provider'
            ? 'Select a provider → Enter to see models'
            : 'Select a model → Enter to switch'}
        </Text>
      </Box>
    </Box>
  )
}
