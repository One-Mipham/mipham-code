import React, { useState, useEffect, useMemo } from 'react'
import { Box, Text } from 'ink'
import { getEventBus } from '../workflow/event-bus.js'
import type { WorkflowEvent } from '../workflow/event-bus.js'

interface AgentState {
  label: string
  phase: string
  status: 'running' | 'done' | 'failed'
  durationMs: number
}

interface WorkflowProgressProps {
  /** If provided, only show progress for this runId. Otherwise auto-detect. */
  runId?: string
}

export function WorkflowProgress({ runId }: WorkflowProgressProps) {
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [phases, setPhases] = useState<Array<{ name: string; done: boolean }>>([])
  const [agents, setAgents] = useState<Map<string, AgentState>>(new Map())
  const [elapsed, setElapsed] = useState(0)
  const [done, setDone] = useState(false)
  const [_totalAgents, setTotalAgents] = useState(0)
  const [cacheHits, setCacheHits] = useState(0)

  useEffect(() => {
    const bus = getEventBus()

    const handleEvent = (event: WorkflowEvent) => {
      switch (event.type) {
        case 'phase:start':
          setPhases((prev) => [...prev, { name: event.phase, done: false }])
          setActiveRunId(bus.getActiveRunId())
          break

        case 'agent:start':
          setAgents((prev) => {
            const next = new Map(prev)
            next.set(event.agentId, {
              label: event.label,
              phase: event.phase,
              status: 'running',
              durationMs: 0,
            })
            return next
          })
          break

        case 'agent:end':
          setAgents((prev) => {
            const next = new Map(prev)
            const existing = next.get(event.agentId)
            if (existing) {
              next.set(event.agentId, {
                ...existing,
                status: event.success ? 'done' : 'failed',
                durationMs: event.durationMs,
              })
              // Mark phase as done if all agents in it are done
              const phaseName = existing.phase
              const allInPhase = Array.from(next.values()).filter((a) => a.phase === phaseName)
              const allDone = allInPhase.every((a) => a.status !== 'running')
              if (allDone) {
                setPhases((prev) =>
                  prev.map((p) => (p.name === phaseName ? { ...p, done: true } : p)),
                )
              }
            }
            return next
          })
          break

        case 'done':
          setDone(true)
          setTotalAgents(event.totalAgents)
          setCacheHits(event.cacheHits)
          break

        case 'error':
          break
      }
    }

    // Subscribe to all event types
    const types = [
      'phase:start',
      'agent:start',
      'agent:end',
      'agent:result',
      'log',
      'error',
      'done',
    ]
    for (const type of types) {
      bus.on(type, handleEvent)
    }

    // Elapsed timer (ticks every 100ms)
    const timer = setInterval(() => {
      setElapsed((prev) => prev + 100)
    }, 100)

    return () => {
      for (const type of types) {
        bus.off(type, handleEvent)
      }
      clearInterval(timer)
    }
  }, [])

  const agentList = useMemo(() => Array.from(agents.values()), [agents])

  if (!activeRunId && !runId) return null
  if (done && agentList.length === 0) return null

  const runningCount = agentList.filter((a) => a.status === 'running').length
  const doneCount = agentList.filter((a) => a.status === 'done').length
  const failedCount = agentList.filter((a) => a.status === 'failed').length

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(1)}s`
  }

  const elapsedStr = formatDuration(elapsed)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box>
        <Text bold color="cyan">
          ═══ Workflow: {activeRunId || runId} ═══
        </Text>
      </Box>

      {/* Phases */}
      {phases.map((phase, i) => {
        const phaseAgents = agentList.filter((a) => a.phase === phase.name)
        return (
          <Box key={i} flexDirection="column" marginTop={1}>
            <Text>
              {phase.done ? '●' : '◌'} Phase: {phase.name}
              {phaseAgents.length > 0 &&
                ` [${phaseAgents.filter((a) => a.status === 'done').length}/${phaseAgents.length} done]`}
            </Text>
            {phaseAgents.map((agent, j) => (
              <Box key={j} marginLeft={2}>
                <Text
                  color={
                    agent.status === 'done' ? 'green' : agent.status === 'failed' ? 'red' : 'yellow'
                  }
                >
                  {agent.status === 'done' ? '✓' : agent.status === 'failed' ? '✗' : '⏳'}{' '}
                  {agent.label}
                  {agent.status !== 'running' && ` ${formatDuration(agent.durationMs)}`}
                </Text>
              </Box>
            ))}
          </Box>
        )
      })}

      {/* Summary footer */}
      <Box marginTop={1}>
        <Text dimColor>
          ═══ Elapsed: {elapsedStr} | Agents: {doneCount}/{agentList.length}
          {runningCount > 0 && ` (${runningCount} running)`}
          {failedCount > 0 && ` (${failedCount} failed)`}
          {done && ` | Cache hits: ${cacheHits}`}
          {done && ' | DONE ═══'}
          {!done && ' | Status: running ═══'}
        </Text>
      </Box>
    </Box>
  )
}
