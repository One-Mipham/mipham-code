import React from 'react'
import { Box, Text } from 'ink'
import { useI18n } from '../i18n-context'

export interface AgentEntry {
  id: string
  name: string
  description: string
  startTime: number
  tokensUsed: number
  status: 'running' | 'completed'
}

export interface AgentProgress {
  name: string
  description: string
  startTime: number
  tokensUsed?: number
  isTask?: boolean
  id?: string
}

interface AgentFooterProps {
  agents: AgentEntry[]
  /** Tick counter for live elapsed-time re-renders. */
  tick: number
  /** Active foreground tool: shown as [ToolName detail...] before agent lines. */
  activeTool?: { name: string; detail: string; startTime: number } | null
  /** Inline agent progress from tool_use streaming: ✻ Gerund… (elapsed · tokens). */
  agentProgress?: AgentProgress | null
}

/** Format elapsed seconds into human-readable string (e.g. "2m 51s", "38s"). */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s}s`
}

/** Format token count: 42400 → "42.4k", 1500000 → "1.5M". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** Map tool name to Ink color for the [Tool ...] indicator. */
function toolIndicatorColor(name: string): string {
  switch (name) {
    case 'Bash':
    case 'Read':
    case 'Glob':
    case 'Grep':
      return 'white'
    case 'Write':
    case 'Edit':
    case 'Update':
      return 'red'
    case 'Agent':
    case 'Task':
    case 'Skill':
    case 'Workflow':
      return 'magenta'
    case 'WebSearch':
    case 'WebFetch':
      return 'blue'
    default:
      return 'white'
  }
}

/** Animate dots for the active tool indicator: cycles 1→2→3→1 dots. */
function animatedDots(tick: number): string {
  const n = (tick % 3) + 1
  return '.'.repeat(n)
}

/** Gerund verbs for agent progress — rotated every 2 seconds for visual liveliness. */
const GERUNDS = [
  'Pondering',
  'Contemplating',
  'Cerebrating',
  'Ruminating',
  'Deliberating',
  'Cogitating',
  'Perambulating',
  'Computing',
  'Processing',
  'Analyzing',
  'Synthesizing',
  'Orchestrating',
  'Forging',
  'Illuminating',
  'Manifesting',
  'Transmogrifying',
]

/** Pick a gerund that changes every 2 seconds (driven by tick). */
function rotatingGerund(tick: number): string {
  return GERUNDS[Math.floor(tick / 2) % GERUNDS.length]!
}

/** Max agent lines to render before collapsing the rest into "↓ N more". */
const MAX_AGENT_LINES = 5

export function AgentFooter({ agents, tick, activeTool, agentProgress }: AgentFooterProps) {
  const { t } = useI18n()
  const hasAgents = agents.length > 0
  const hasTool = !!activeTool
  const hasProgress = !!agentProgress

  if (!hasAgents && !hasTool && !hasProgress) return null

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Active foreground tool indicator — Claude Code style [Bash command...] */}
      {hasTool && (
        <Box>
          <Text color={toolIndicatorColor(activeTool!.name)}>
            {'  '}[{activeTool!.name} {activeTool!.detail.slice(0, 60)}
            {animatedDots(tick)}]
          </Text>
          <Box flexGrow={1} />
          <Text dimColor>
            {' '}
            {formatElapsed(Math.floor((Date.now() - activeTool!.startTime) / 1000))}
          </Text>
        </Box>
      )}

      {/* Inline agent progress — ✻ Gerund… (elapsed · ↓ tokens) in orange */}
      {hasProgress && (
        <Box>
          <Text color="#FFA500">
            {'  '}✻ {rotatingGerund(tick)}…
          </Text>
          <Box flexGrow={1} />
          <Text dimColor>
            {' ('}
            {formatElapsed(Math.floor((Date.now() - agentProgress!.startTime) / 1000))}
            {agentProgress!.tokensUsed && agentProgress!.tokensUsed > 0
              ? ` · ↓ ${formatTokens(agentProgress!.tokensUsed)} tokens`
              : ''}
            {')'}
          </Text>
        </Box>
      )}

      {/* Agent status lines — collapse to MAX_AGENT_LINES + "↓ N more" */}
      {agents.slice(0, MAX_AGENT_LINES).map((agent) => {
        const elapsed = Math.floor((Date.now() - agent.startTime) / 1000)
        const isRunning = agent.status === 'running'
        const symbol = isRunning ? '◯' : '◼'
        const symbolColor = isRunning ? 'cyan' : undefined

        // Truncate description to keep lines readable
        const desc =
          agent.description.length > 80 ? agent.description.slice(0, 80) + '...' : agent.description

        return (
          <Box key={agent.id}>
            <Text dimColor={!isRunning} color={symbolColor}>
              {'  '}
              {symbol}{' '}
            </Text>
            <Text bold color={isRunning ? 'cyan' : undefined} dimColor={!isRunning}>
              {agent.name}
            </Text>
            <Text dimColor> {desc}</Text>
            {/* Spacer pushes elapsed + tokens to the right edge */}
            <Box flexGrow={1} />
            <Text dimColor>
              {'  '}
              {isRunning ? formatElapsed(elapsed) : t('ui.agent.finished')}
            </Text>
            {isRunning && agent.tokensUsed > 0 && (
              <Text dimColor>
                {' · ↓ '}
                {formatTokens(agent.tokensUsed)} tokens
              </Text>
            )}
          </Box>
        )
      })}
      {agents.length > MAX_AGENT_LINES && (
        <Text dimColor>
          {'  '}↓ {agents.length - MAX_AGENT_LINES} more
        </Text>
      )}
    </Box>
  )
}
