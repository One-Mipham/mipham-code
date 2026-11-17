import type { CommandHandler } from '../ui/commands.js'
import { listRuns, loadJournal } from '../workflow/journal.js'
import { getEventBus } from '../workflow/event-bus.js'

export const workflowViewCmd: CommandHandler = async (_ctx, args) => {
  const runId = args[0]

  // /workflow list — show recent runs
  if (!runId || runId === 'list') {
    const runs = listRuns()
    if (runs.length === 0) {
      return {
        content:
          'No workflow runs found.\n\nRuns are saved to ~/.mipham/workflows/ after each Workflow tool invocation.',
      }
    }

    const lines: string[] = ['── Recent Workflow Runs ──', '']

    // Show last 10, newest first
    const recent = runs.sort().reverse().slice(0, 10)
    for (const id of recent) {
      const entries = loadJournal(id)
      const agentCount = entries.filter((e) => e.type === 'agent').length
      const phaseCount = entries.filter((e) => e.type === 'phase').length
      const shortId = id.slice(0, 20)
      lines.push(`  ${shortId}... — ${agentCount} agents, ${phaseCount} phases`)
    }

    lines.push('', `Total runs: ${runs.length}`)
    lines.push('', 'Use /workflow view <runId> to see details.')
    return { content: lines.join('\n') }
  }

  // /workflow view <runId> — show run details
  const entries = loadJournal(runId)
  if (entries.length === 0) {
    return { content: `Run "${runId}" not found.\n\nUse /workflow list to see available runs.` }
  }

  const lines: string[] = [`── Workflow: ${runId.slice(0, 30)} ──`, '']

  let currentPhase = ''
  for (const entry of entries) {
    if (entry.type === 'phase') {
      currentPhase = entry.message || ''
      lines.push(`  ▸ Phase: ${currentPhase}`)
    } else if (entry.type === 'agent') {
      const label = entry.opts?.label || entry.prompt?.slice(0, 50) || 'agent'
      lines.push(`    ● ${label}`)
    } else if (entry.type === 'log') {
      lines.push(`    ℹ ${entry.message}`)
    }
  }

  lines.push('', `Total entries: ${entries.length}`)
  return { content: lines.join('\n') }
}

export const workflowWatchCmd: CommandHandler = async (_ctx, _args) => {
  // The event bus is the only place that knows whether a run is live in this
  // process. Reading it makes the answer a fact instead of a fixed sentence.
  const active = getEventBus().getActiveRunId()
  const runs = listRuns().sort()

  if (active) {
    return {
      content: [
        '── Workflow Watch ──',
        '',
        `Active run: ${active}`,
        'Progress streams automatically in the workflow panel.',
        '',
        `Replay so far: /workflow view ${active}`,
      ].join('\n'),
    }
  }

  return {
    content: [
      '── Workflow Watch ──',
      '',
      'No workflow is running in this process.',
      runs.length > 0
        ? `Recorded runs: ${runs.length} (latest: ${runs[runs.length - 1]})`
        : 'No recorded runs yet.',
      '',
      'Use /workflow list to see past runs.',
      'Use /workflow view <id> to replay a completed run.',
    ].join('\n'),
  }
}
