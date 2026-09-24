import React, { useState, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'
import { useI18n } from '../i18n-context'
import { useKeyState } from './use-key-state'
import type { MiphamConfig, ProviderConfig } from '../shared/index.ts'

/** 环绕取模 —— 列表两端互为首尾。 */
const wrap = (i: number, len: number) => ((i % len) + len) % len

/** 只列启用中的模型（与 `providerList` 的 `upcoming` 过滤同一条口径）。 */
const activeModels = (p: ProviderConfig) => p.models.filter((m) => m.status === 'active')

interface PickerProps {
  config: MiphamConfig
  currentProvider: string
  currentModel: string
  onSelect: (providerId: string, modelId: string) => void
  onNeedsApiKey?: (providerId: string, modelId: string, providerName: string) => void
  onClose: () => void
}

type Panel = 'provider' | 'model'

export function ModelPicker({
  config,
  currentProvider,
  currentModel,
  onSelect,
  onNeedsApiKey,
  onClose,
}: PickerProps) {
  const { t } = useI18n()
  // Get active providers only
  const providers = config.providers.filter((p) => p.status !== 'upcoming')

  // State
  const [activePanel, setActivePanel] = useState<Panel>('provider')
  // 光标走 `useKeyState`：一组按键可能在同一拍里到达（↓ 之后紧跟 Enter），判据必须
  // 读得到本次按键刚写下的那个索引，而不是上一张闭包里的。
  const providerIdx = useKeyState(() => {
    const idx = providers.findIndex((p) => p.id === currentProvider)
    return idx >= 0 ? idx : 0
  })
  const modelIdx = useKeyState(0)

  const selectedProvider = providers[providerIdx.value]
  const models = selectedProvider ? activeModels(selectedProvider) : []

  // Reset model index when provider changes
  const goToProvider = useCallback(
    (idx: number) => {
      providerIdx.set(wrap(idx, providers.length))
      modelIdx.set(0)
      setActivePanel('model') // auto-switch to model panel
    },
    [providers.length, providerIdx, modelIdx],
  )

  /** 相对移动 —— 按 `read()` 叠加，同一拍里的两次 ↓ 就是两步。 */
  const stepModel = useCallback(
    (delta: number) => {
      if (!selectedProvider) return
      const len = models.length
      if (len === 0) return
      modelIdx.set((prev) => wrap(prev + delta, len))
    },
    [selectedProvider, models.length, modelIdx],
  )

  const confirmSelection = useCallback(() => {
    // 按 `read()` 取当前光标，而不是渲染时那份闭包 —— 否则「↓ Enter」确认的是上一行。
    const provider = providers[providerIdx.read()]
    if (!provider) return
    const model = activeModels(provider)[modelIdx.read()]
    if (model) {
      // Check API key before confirming switch
      const apiKey = provider.apiKey
      if (!apiKey || apiKey.trim() === '' || /^\$\{[A-Z_]+\}$/.test(apiKey.trim())) {
        if (provider.id !== 'ollama' && onNeedsApiKey) {
          onNeedsApiKey(provider.id, model.id, provider.name)
          return
        }
      }
      onSelect(provider.id, model.id)
    }
  }, [providers, providerIdx, modelIdx, onSelect, onNeedsApiKey])

  useInput((input, key) => {
    // Global keys
    if (key.escape) {
      onClose()
      return
    }

    if (key.return) {
      if (activePanel === 'provider') {
        goToProvider(providerIdx.read()) // switches to model panel
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
        providerIdx.set((prev) => wrap(prev - 1, providers.length))
      } else {
        stepModel(-1)
      }
      return
    }

    if (key.downArrow) {
      if (activePanel === 'provider') {
        providerIdx.set((prev) => wrap(prev + 1, providers.length))
      } else {
        stepModel(1)
      }
      return
    }
  })

  // Provider labels
  const providerColor = (p: ProviderConfig) => (p.id === currentProvider ? 'green' : 'white')

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1}>
      {/* Title */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          {t('ui.picker.title')}
        </Text>
        <Text dimColor> {t('ui.picker.nav_help')}</Text>
      </Box>

      {/* Two-column layout */}
      <Box flexDirection="row" gap={4}>
        {/* ── Provider Panel (一级) ── */}
        <Box
          flexDirection="column"
          width={28}
          borderStyle="single"
          borderColor={activePanel === 'provider' ? 'cyan' : 'gray'}
          padding={1}
        >
          <Text bold underline dimColor>
            {t('ui.picker.provider_label')} {activePanel === 'provider' ? '◀' : ''}
          </Text>
          {providers.map((p, i) => {
            const isCurrent = p.id === currentProvider
            const isSelected = i === providerIdx.value
            const isUpcoming = p.status === 'upcoming'
            return (
              <Box key={p.id}>
                <Text
                  color={isUpcoming ? 'gray' : isSelected ? 'cyan' : providerColor(p)}
                  bold={isSelected}
                >
                  {isSelected ? '▶ ' : '  '}
                  {isCurrent ? '✓' : ' '}
                  {p.name.padEnd(16)}
                </Text>
                <Text dimColor>
                  {isUpcoming ? t('ui.picker.coming_soon') : `${activeModels(p).length}m`}
                </Text>
              </Box>
            )
          })}
        </Box>

        {/* ── Model Panel (二级) ── */}
        <Box
          flexDirection="column"
          width={42}
          borderStyle="single"
          borderColor={activePanel === 'model' ? 'cyan' : 'gray'}
          padding={1}
        >
          <Text bold underline dimColor>
            {t('ui.picker.models_label')} {activePanel === 'model' ? '◀' : ''}
            {selectedProvider ? ` — ${selectedProvider.name}` : ''}
          </Text>
          {models.length === 0 && <Text dimColor> {t('ui.picker.no_active_models')}</Text>}
          {models.map((m, i) => {
            const isCurrentModel = selectedProvider?.id === currentProvider && m.id === currentModel
            const isSelected = i === modelIdx.value
            return (
              <Box key={m.id} flexDirection="column">
                <Text
                  color={isCurrentModel ? 'green' : isSelected ? 'cyan' : 'white'}
                  bold={isSelected}
                >
                  {isSelected ? '▶ ' : '  '}
                  {isCurrentModel ? '✓' : ' '}
                  {m.name}
                </Text>
                <Text dimColor>
                  {'   '}
                  {m.id}
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
            ? t('ui.picker.select_provider_hint')
            : t('ui.picker.select_model_hint')}
        </Text>
      </Box>
    </Box>
  )
}
