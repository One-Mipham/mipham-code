import React from 'react'
import { Box, Text, useInput } from 'ink'
import { useI18n } from '../i18n-context'
import { useKeyState } from './use-key-state'

/**
 * One candidate for `/copy`: a preview line to show, and the full text to put on
 * the clipboard. The preview is deliberately a *summary* — the body can be huge,
 * and the picker is about telling responses apart, not reading them.
 */
export interface CopyPickerItem {
  label: string
  text: string
}

const wrap = (i: number, len: number) => ((i % len) + len) % len

/**
 * `/copy` 无参数时的交互选择器。
 *
 * 此前 `/copy` 只会「复制最近 N 条」—— 想复制第 3 条近的回复，得先数清顺序、再敲
 * `/copy` 一个数字，且看不到任何候选。这里把最近几条助手回复列出来，上下键选、回车复制。
 * 键位与 `ModelPicker` 同源（↑↓ 移动、Enter 确认、Esc 关闭），并且和它一样走
 * `useKeyState` —— 判据读 `read()` 而不是渲染闭包，否则「↓ Enter」会复制到上一行。
 */
export function CopyPicker({
  items,
  onSelect,
  onClose,
}: {
  items: CopyPickerItem[]
  onSelect: (item: CopyPickerItem) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const idx = useKeyState(() => items.length - 1) // 默认停在最近一条

  useInput((_input, key) => {
    if (key.escape) {
      onClose()
      return
    }
    if (key.return) {
      const item = items[idx.read()]
      if (item) onSelect(item)
      return
    }
    if (key.upArrow) idx.set((prev) => wrap(prev - 1, items.length))
    if (key.downArrow) idx.set((prev) => wrap(prev + 1, items.length))
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          {t('ui.copy_picker.title')}
        </Text>
        <Text dimColor> {t('ui.copy_picker.nav_help')}</Text>
      </Box>
      {items.map((item, i) => {
        const isSelected = i === idx.value
        return (
          <Box key={i}>
            <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
              {isSelected ? '▶ ' : '  '}
              {item.label}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
