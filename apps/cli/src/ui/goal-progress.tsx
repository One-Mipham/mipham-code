import { useState, useEffect, useRef } from 'react'
import { Box, Text } from 'ink'
import { useI18n } from '../i18n-context'
import { getTasks } from '../tools/exec/task.js'
import type { Task } from '../tools/exec/task.js'

export interface GoalProgressProps {
  goal: string
  /** Read current session token total; defaults to 0. */
  getTokens?: () => number
  /** Read current tasks; defaults to the real task store. */
  listTasks?: () => Task[]
}

export interface TaskSummary {
  total: number
  done: number
  inProgress: number
  pending: number
  failed: number
}

/** Count tasks by status, ignoring deleted. */
export function summarizeTasks(tasks: Task[]): TaskSummary {
  const summary: TaskSummary = { total: 0, done: 0, inProgress: 0, pending: 0, failed: 0 }
  for (const t of tasks) {
    if (t.status === 'deleted') continue
    summary.total++
    if (t.status === 'completed') summary.done++
    else if (t.status === 'in_progress') summary.inProgress++
    else if (t.status === 'pending') summary.pending++
    else if (t.status === 'failed') summary.failed++
  }
  return summary
}

/** Format a token count: raw under 1000, `1.2K` style above. */
export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

function taskIcon(status: Task['status']): { icon: string; color?: string; dim?: boolean } {
  switch (status) {
    case 'completed':
      return { icon: '✓', color: 'green' }
    case 'in_progress':
      return { icon: '⏳', color: 'yellow' }
    case 'failed':
      return { icon: '✗', color: 'red' }
    default:
      return { icon: '📋', dim: true }
  }
}

/** Live goal progress panel — mirrors ZCode's goal view: title + subtasks + done/total · elapsed · tokens. */
export function GoalProgress({ goal, getTokens, listTasks }: GoalProgressProps) {
  const { t } = useI18n()
  const [tasks, setTasks] = useState<Task[]>([])
  const [tokens, setTokens] = useState(0)
  const [elapsedMs, setElapsedMs] = useState(0)

  // Hold latest callbacks in refs so the interval doesn't churn on re-render.
  const listTasksRef = useRef(listTasks ?? getTasks)
  const getTokensRef = useRef(getTokens ?? (() => 0))
  listTasksRef.current = listTasks ?? getTasks
  getTokensRef.current = getTokens ?? (() => 0)

  useEffect(() => {
    if (!goal) {
      setTasks([])
      setTokens(0)
      setElapsedMs(0)
      return
    }
    const start = Date.now()
    const tick = () => {
      setTasks(listTasksRef.current())
      setTokens(getTokensRef.current())
      setElapsedMs(Date.now() - start)
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [goal])

  if (!goal) return null

  const summary = summarizeTasks(tasks)
  const visibleTasks = tasks.filter((t) => t.status !== 'deleted')

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginBottom={1}
    >
      <Text bold color="green">
        {t('ui.goal_progress.title', { goal })}
      </Text>

      {visibleTasks.length === 0 ? (
        <Text dimColor>{t('ui.goal_progress.no_subtasks')}</Text>
      ) : (
        visibleTasks.map((t) => {
          const meta = taskIcon(t.status)
          return (
            <Box key={t.id} marginLeft={1}>
              <Text color={meta.color} dimColor={meta.dim}>
                {meta.icon} {t.subject}
              </Text>
            </Box>
          )
        })
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {t('ui.goal_progress.summary', {
            done: String(summary.done),
            total: String(summary.total),
          })}
          {summary.inProgress > 0 &&
            t('ui.goal_progress.in_progress', { n: String(summary.inProgress) })}
          {summary.failed > 0 && t('ui.goal_progress.failed', { n: String(summary.failed) })}
          {' · '}
          {formatElapsed(elapsedMs)}
          {tokens > 0 && t('ui.goal_progress.tokens', { n: formatTokens(tokens) })}
          {t('ui.goal_progress.border_end')}
        </Text>
      </Box>
    </Box>
  )
}
