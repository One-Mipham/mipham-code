/**
 * Cross-session insight report — counts only.
 *
 * Reads the CLI's own session logs (`~/.mipham/sessions/*.jsonl`) and produces
 * an aggregate report. Deliberately never prints message text, tool input or
 * tool output: the point is "where did my tool calls go", not a transcript.
 *
 * Counting rule that is easy to get wrong: `messageToEvents` splits a tool
 * call/result out of a message only when that message holds a **single**
 * block; a multi-block turn stays one `assistant/message` / `user/message`.
 * Counting event types alone therefore under-reports tool calls and failures,
 * so both shapes are counted here.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { interruptedCallNotice, isValidEvent, type SessionEvent } from './session-log'
import { miphamHome } from './paths.ts'

export interface SessionInsightsInput {
  name: string
  events: SessionEvent[]
}

export interface InsightsReport {
  sessions: number
  events: number
  userMessages: number
  assistantMessages: number
  toolCalls: number
  toolFailures: number
  toolUnknown: number
  compactions: number
  topTools: Array<{ name: string; count: number }>
  models: Array<{ provider: string; model: string; count: number }>
  firstAt: number | null
  lastAt: number | null
}

export interface LoadedSessionLogs {
  inputs: SessionInsightsInput[]
  skippedFiles: number
  skippedLines: number
}

const DEFAULT_MAX_FILES = 200
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024

/** Aggregate the already-parsed events. Pure: no I/O, deterministic. */
export function summarizeSessions(inputs: SessionInsightsInput[]): InsightsReport {
  const topTools = new Map<string, number>()
  const models = new Map<string, { provider: string; model: string; count: number }>()
  const interrupted = interruptedCallNotice()

  let events = 0
  let userMessages = 0
  let assistantMessages = 0
  let toolCalls = 0
  let toolFailures = 0
  let toolUnknown = 0
  let compactions = 0
  let firstAt: number | null = null
  let lastAt: number | null = null

  const bumpTool = (name: string) => {
    toolCalls += 1
    topTools.set(name, (topTools.get(name) ?? 0) + 1)
  }

  for (const input of inputs) {
    for (const event of input.events) {
      events += 1
      if (Number.isFinite(event.at) && event.at > 0) {
        firstAt = firstAt === null ? event.at : Math.min(firstAt, event.at)
        lastAt = lastAt === null ? event.at : Math.max(lastAt, event.at)
      }

      switch (event.type) {
        case 'user/message': {
          userMessages += 1
          if (Array.isArray(event.message.content)) {
            for (const block of event.message.content) {
              if (block.type === 'tool_result' && block.is_error === true) toolFailures += 1
            }
          }
          break
        }
        case 'assistant/message': {
          assistantMessages += 1
          if (Array.isArray(event.message.content)) {
            for (const block of event.message.content) {
              if (block.type === 'tool_use') bumpTool(block.name)
            }
          }
          break
        }
        case 'tool/call':
          bumpTool(event.name)
          break
        case 'tool/result':
          if (event.result.success === false) {
            // Synthesized on resume for calls that were in flight when the
            // process died — "outcome unknown" is not the same as "failed".
            if (event.result.content === interrupted) toolUnknown += 1
            else toolFailures += 1
          }
          break
        case 'compaction/summary':
          compactions += 1
          break
        case 'session/start': {
          const provider = event.provider ?? 'unknown'
          const model = event.model ?? 'unknown'
          const key = `${provider}\u0000${model}`
          const seen = models.get(key)
          if (seen) seen.count += 1
          else models.set(key, { provider, model, count: 1 })
          break
        }
        default:
          break
      }
    }
  }

  return {
    sessions: inputs.length,
    events,
    userMessages,
    assistantMessages,
    toolCalls,
    toolFailures,
    toolUnknown,
    compactions,
    topTools: [...topTools.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 10),
    models: [...models.values()].sort(
      (a, b) =>
        b.count - a.count || `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`),
    ),
    firstAt,
    lastAt,
  }
}

/**
 * Read session logs newest-first with hard budgets, so one pathological
 * directory cannot turn a slash command into a multi-GB synchronous read.
 */
export function loadSessionLogs(
  dir: string = miphamHome('sessions'),
  opts: { maxFiles?: number; maxBytes?: number; maxTotalBytes?: number } = {},
): LoadedSessionLogs {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES

  const inputs: SessionInsightsInput[] = []
  let skippedFiles = 0
  let skippedLines = 0

  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
  } catch {
    return { inputs, skippedFiles, skippedLines }
  }

  const files: Array<{ name: string; mtimeMs: number; size: number }> = []
  for (const name of names) {
    try {
      const st = statSync(join(dir, name))
      files.push({ name, mtimeMs: st.mtimeMs, size: st.size })
    } catch {
      skippedFiles += 1
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const selected = files.slice(0, maxFiles)
  skippedFiles += files.length - selected.length

  let totalBytes = 0
  for (const file of selected) {
    if (file.size > maxBytes || totalBytes + file.size > maxTotalBytes) {
      skippedFiles += 1
      continue
    }
    totalBytes += file.size

    try {
      const raw = readFileSync(join(dir, file.name), 'utf-8')
      const events: SessionEvent[] = []
      for (const line of raw.split('\n')) {
        const text = line.trim()
        if (!text) continue
        try {
          const parsed: unknown = JSON.parse(text)
          if (isValidEvent(parsed)) events.push(parsed)
          else skippedLines += 1
        } catch {
          skippedLines += 1
        }
      }
      inputs.push({ name: file.name, events })
    } catch {
      skippedFiles += 1
    }
  }

  return { inputs, skippedFiles, skippedLines }
}

export function formatInsightsReport(
  report: InsightsReport,
  dir: string,
  loaded: { skippedFiles: number; skippedLines: number },
): string {
  if (report.sessions === 0) {
    return `No session logs found at ${dir}.`
  }

  const range =
    report.firstAt !== null && report.lastAt !== null
      ? `${new Date(report.firstAt).toISOString()} → ${new Date(report.lastAt).toISOString()}`
      : 'unknown'

  const lines: string[] = [
    '── Session Insights ──',
    `Scanned: ${dir} (${report.sessions} sessions, ${report.events} events)`,
    '',
    `Messages: user ${report.userMessages} · assistant ${report.assistantMessages}`,
    `Tool calls: ${report.toolCalls} (failures ${report.toolFailures}, unknown ${report.toolUnknown})`,
    `Compactions: ${report.compactions}`,
    `Range: ${range}`,
  ]

  if (report.models.length > 0) {
    lines.push('', 'Models:')
    for (const m of report.models) lines.push(`  ${m.provider}/${m.model}  ${m.count}`)
  }

  if (report.topTools.length > 0) {
    lines.push('', 'Top tools:')
    for (const t of report.topTools) lines.push(`  ${t.name}  ${t.count}`)
  }

  if (loaded.skippedFiles > 0 || loaded.skippedLines > 0) {
    lines.push('', `Skipped: ${loaded.skippedFiles} file(s), ${loaded.skippedLines} line(s).`)
  }

  return lines.join('\n')
}
