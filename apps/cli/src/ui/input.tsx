import React, { useState, useEffect, useRef } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import { VimMotionEngine, type VimMode } from './vim-motions.js'

interface InputBarProps {
  onSubmit: (input: string) => void
  isLoading: boolean
}

// ── Status verbs — English (Claude Code-aligned) + Chinese (Mipham originals) ──

const STATUS_EN = [
  'Doodling',
  'Forging',
  'Germinating',
  'Mosmosing',
  'Cerebrating',
  'Boogieing',
  'Finagling',
  'Misting',
  'Recombobulating',
  'Slithering',
  'Effecting',
  'Roosting',
  'Crystallizing',
  'Canoodling',
  'Billowing',
  'Warping',
  'Improvising',
  'Metamorphing',
  'Gusting',
  'Whiring',
  'Topsy-turvying',
  'Flibbertigibetting',
  'Wibbling',
  'Thundering',
  'Moseying',
  'Julienning',
  'Evaporating',
  'Ruminating',
  'Whisking',
  'Scampering',
  'Meandering',
  'Concoting',
  'Gesticulating',
  'Flamebeing',
  'Quantumizing',
  'Waddling',
  'Fluttering',
  'Sprouting',
  'Elucidating',
  'Embellishing',
  'Razzmatizing',
  'Pondering',
  'Cogitating',
  'Garnishing',
  'Actualizing',
  'Zigzagging',
  'Mustering',
  'Frolicking',
  'Hullaballooing',
  'Doing',
  'Fermenting',
  'Considering',
  'Skedaddling',
  'Actioning',
  'Orbiting',
  'Perambulating',
  'Drizzling',
  'Schlepping',
  'Ionizing',
  'Scurrying',
]

const STATUS_CN = [
  '思忖中',
  '推演中',
  '凝炼中',
  '熬煮中',
  '锻造中',
  '研磨中',
  '解构中',
  '冥思中',
  '编织中',
  '萃取中',
  '烹制中',
  '淬火中',
  '雕琢中',
  '融汇中',
  '觉照中',
  '运转中',
  '参详中',
  '化合中',
  '浸润中',
  '焙烤中',
]

// Merge both — bilingual status verbs
const STATUS_GERUNDS = [...STATUS_EN, ...STATUS_CN]

const STATUS_PAST = ['Brewed', 'Churned', 'Cooked', 'Sautéed', 'Cogitated', 'Crunched']

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}

export function InputBar({ onSubmit, isLoading }: InputBarProps) {
  const [value, setValue] = useState('')
  const [verb, setVerb] = useState(() => pick(STATUS_GERUNDS))
  const [completionVerb, setCompletionVerb] = useState<string | null>(null)
  const prevLoading = useRef(isLoading)

  // Rotate gerunds while loading
  useEffect(() => {
    if (!isLoading) return
    const interval = setInterval(() => {
      setVerb(pick(STATUS_GERUNDS))
    }, 1200)
    return () => clearInterval(interval)
  }, [isLoading])

  // Pick a fresh gerund when loading starts
  useEffect(() => {
    if (isLoading) {
      setVerb(pick(STATUS_GERUNDS))
      setCompletionVerb(null)
    }
  }, [isLoading])

  // Flash a past participle when loading stops
  useEffect(() => {
    if (prevLoading.current === true && isLoading === false) {
      setCompletionVerb(pick(STATUS_PAST))
      const timer = setTimeout(() => setCompletionVerb(null), 1500)
      return () => clearTimeout(timer)
    }
    prevLoading.current = isLoading
  }, [isLoading])

  const [vimMode, setVimMode] = useState<VimMode>('insert')
  const vimEngine = useRef(new VimMotionEngine())
  const vimPending = useRef<string | null>(null)

  // ── Vim motions: intercept keys in normal mode ──

  useInput((input, key) => {
    // Escape toggles between insert and normal mode
    if (key.escape) {
      setVimMode((prev) => (prev === 'insert' ? 'normal' : 'insert'))
      vimEngine.current.mode = vimEngine.current.mode === 'insert' ? 'normal' : 'insert'
      return
    }

    if (vimEngine.current.mode !== 'normal') return

    // Handle pending two-key sequences (dd, yy)
    if (vimPending.current === 'd' && input === 'd') {
      const action = vimEngine.current.handleDD(value)
      setValue(action.text ?? value)
      vimPending.current = null
      return
    }
    if (vimPending.current === 'y' && input === 'y') {
      vimEngine.current.handleYY(value)
      vimPending.current = null
      return
    }

    // Handle single-key motions
    const action = vimEngine.current.handleNormal(input, value, value.length)
    if (!action) return

    if (action.pending) {
      vimPending.current = action.pending
      return
    }

    if (action.text !== undefined) {
      setValue(action.text)
    }
  })

  const handleSubmit = (val: string) => {
    if (!val.trim() || isLoading) return
    onSubmit(val)
    setValue('')
  }

  return (
    <Box marginTop={1}>
      <Box marginRight={1}>
        <Text color={vimMode === 'normal' ? 'magenta' : isLoading ? 'yellow' : 'cyan'}>
          {vimMode === 'normal' ? ':' : '>'}
        </Text>
      </Box>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        placeholder={
          vimMode === 'normal'
            ? '[NORMAL] h/j/k/l w/b 0/$ dd yy p u /search (Esc to insert)'
            : isLoading
              ? `${verb}...`
              : completionVerb
                ? completionVerb
                : 'Type a message (Esc to cancel)...'
        }
      />
    </Box>
  )
}
