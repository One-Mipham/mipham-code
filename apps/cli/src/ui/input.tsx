import React, { useState, useEffect } from 'react'
import { Box, Text } from 'ink'
import TextInput from 'ink-text-input'

interface InputBarProps {
  onSubmit: (input: string) => void
  isLoading: boolean
}

// ── Creative status messages (inspired by Claude Code's whimsical verbs) ──

const STATUS_VERBS = [
  '思忖中', // Pondering
  '推演中', // Deducting
  '凝炼中', // Condensing
  '熬煮中', // Simmering
  '锻造中', // Forging
  '研磨中', // Grinding
  '解构中', // Deconstructing
  '冥思中', // Contemplating
  '编织中', // Weaving
  '萃取中', // Extracting
  '烹制中', // Cooking
  '淬火中', // Quenching
  '雕琢中', // Chiseling
  '融汇中', // Fusing
  '觉照中', // Illuminating
  '运转中', // Operating
  '参详中', // Studying
  '化合中', // Synthesizing
  '浸润中', // Infusing
  '焙烤中', // Baking
]

const STATUS_EMOJI = ['🔮', '⚙️', '💎', '🔥', '🧪', '🌊', '⚡', '🌀', '🎯', '💡']

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}

export function InputBar({ onSubmit, isLoading }: InputBarProps) {
  const [value, setValue] = useState('')
  const [verb, setVerb] = useState(() => pick(STATUS_VERBS))
  const [emoji, setEmoji] = useState(() => pick(STATUS_EMOJI))

  // Rotate status messages while loading
  useEffect(() => {
    if (!isLoading) return
    const interval = setInterval(() => {
      setVerb(pick(STATUS_VERBS))
      setEmoji(pick(STATUS_EMOJI))
    }, 2000)
    return () => clearInterval(interval)
  }, [isLoading])

  // Reset when loading starts
  useEffect(() => {
    if (isLoading) {
      setVerb(pick(STATUS_VERBS))
      setEmoji(pick(STATUS_EMOJI))
    }
  }, [isLoading])

  const handleSubmit = (val: string) => {
    if (!val.trim() || isLoading) return
    onSubmit(val)
    setValue('')
  }

  return (
    <Box marginTop={1}>
      <Box marginRight={1}>
        <Text color={isLoading ? 'yellow' : 'cyan'}>{isLoading ? `${emoji}` : '▸'}</Text>
      </Box>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        placeholder={isLoading ? `${verb}...` : 'Type a message (Esc to exit)...'}
      />
    </Box>
  )
}
