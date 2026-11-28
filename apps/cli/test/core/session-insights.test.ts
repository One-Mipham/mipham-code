import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  summarizeSessions,
  loadSessionLogs,
  formatInsightsReport,
} from '../../src/core/session-insights'
import { interruptedCallNotice, type SessionEvent } from '../../src/core/session-log'
import { getCommand } from '../../src/ui/commands'

const ev = (e: unknown) => e as SessionEvent

describe('summarizeSessions', () => {
  it('counts messages, tool calls, failures, compactions, models and top tools', () => {
    const report = summarizeSessions([
      {
        name: 'a',
        events: [
          ev({ type: 'session/start', at: 100, sessionId: 's1', provider: 'p', model: 'm' }),
          ev({ type: 'user/message', at: 110, message: { role: 'user', content: 'hi' } }),
          ev({ type: 'assistant/message', at: 115, message: { role: 'assistant', content: 'ok' } }),
          ev({ type: 'tool/call', at: 120, id: 't1', name: 'Read', input: {} }),
          ev({ type: 'tool/call', at: 130, id: 't2', name: 'Read', input: {} }),
          ev({ type: 'tool/result', at: 140, id: 't2', result: { success: false, content: 'x' } }),
          ev({ type: 'compaction/summary', at: 150, summary: 's', replacedCount: 3 }),
        ],
      },
    ])
    expect(report.sessions).toBe(1)
    expect(report.events).toBe(7)
    expect(report.userMessages).toBe(1)
    expect(report.assistantMessages).toBe(1)
    expect(report.toolCalls).toBe(2)
    expect(report.toolFailures).toBe(1)
    expect(report.toolUnknown).toBe(0)
    expect(report.compactions).toBe(1)
    expect(report.topTools).toEqual([{ name: 'Read', count: 2 }])
    expect(report.models).toEqual([{ provider: 'p', model: 'm', count: 1 }])
    expect(report.firstAt).toBe(100)
    expect(report.lastAt).toBe(150)
  })

  it('returns zeros (not NaN) for empty input', () => {
    const r = summarizeSessions([])
    expect(r).toMatchObject({
      sessions: 0,
      events: 0,
      toolCalls: 0,
      toolFailures: 0,
      toolUnknown: 0,
      compactions: 0,
    })
    expect(r.firstAt).toBeNull()
    expect(r.lastAt).toBeNull()
    expect(r.topTools).toEqual([])
  })

  it('counts embedded multi-block tool_use/tool_result and separates unknown outcomes', () => {
    const r = summarizeSessions([
      {
        name: 'x',
        events: [
          ev({
            type: 'assistant/message',
            at: 10,
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 'a', name: 'Bash', input: {} },
                { type: 'tool_use', id: 'b', name: 'Read', input: {} },
              ],
            },
          }),
          ev({
            type: 'user/message',
            at: 20,
            message: {
              role: 'user',
              content: [
                { type: 'tool_result', tool_use_id: 'a', content: 'x', is_error: true },
                { type: 'tool_result', tool_use_id: 'b', content: 'y' },
              ],
            },
          }),
          ev({
            type: 'tool/result',
            at: 30,
            id: 'c',
            result: { success: false, content: interruptedCallNotice() },
          }),
        ],
      },
    ])
    expect(r.toolCalls).toBe(2)
    expect(r.toolFailures).toBe(1)
    expect(r.toolUnknown).toBe(1)
    expect(r.topTools).toEqual([
      { name: 'Bash', count: 1 },
      { name: 'Read', count: 1 },
    ])
  })
})

describe('loadSessionLogs', () => {
  it('keeps valid events, skips corrupt lines and reports the count', () => {
    const dir = mkdtempSync(join(tmpdir(), 'insights-'))
    try {
      const good = JSON.stringify({ type: 'session/start', at: 1, sessionId: 's' })
      const good2 = JSON.stringify({ type: 'tool/call', at: 2, id: 't', name: 'Bash', input: {} })
      writeFileSync(join(dir, 'a.jsonl'), [good, 'not json', good2].join('\n'))
      const loaded = loadSessionLogs(dir)
      expect(loaded.inputs).toHaveLength(1)
      expect(loaded.inputs[0]!.events).toHaveLength(2)
      expect(loaded.skippedLines).toBe(1)
      expect(loaded.skippedFiles).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns an empty result for a missing directory', () => {
    const loaded = loadSessionLogs(join(tmpdir(), 'definitely-not-here-xyz'))
    expect(loaded.inputs).toEqual([])
  })

  it('stops at the total byte budget and counts the rest as skipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'insights-budget-'))
    try {
      const line = JSON.stringify({ type: 'session/start', at: 1, sessionId: 's' }) + '\n'
      writeFileSync(join(dir, 'a.jsonl'), line.repeat(50))
      writeFileSync(join(dir, 'b.jsonl'), line.repeat(50))
      const loaded = loadSessionLogs(dir, { maxTotalBytes: line.length * 50 + 10 })
      expect(loaded.inputs.length).toBe(1)
      expect(loaded.skippedFiles).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('formatInsightsReport', () => {
  it('says "No session logs found" instead of printing an empty table', () => {
    const text = formatInsightsReport(summarizeSessions([]), '/tmp/sessions', {
      skippedFiles: 0,
      skippedLines: 0,
    })
    expect(text).toContain('No session logs found')
  })

  it('prints counts and top tools', () => {
    const report = summarizeSessions([
      {
        name: 'a',
        events: [ev({ type: 'tool/call', at: 1, id: 't', name: 'Read', input: {} })],
      },
    ])
    const text = formatInsightsReport(report, '/tmp/sessions', {
      skippedFiles: 0,
      skippedLines: 0,
    })
    expect(text).toContain('1 sessions')
    expect(text).toContain('Read')
  })
})

describe('/insights registration', () => {
  it('is registered and renders either the report or the no-logs line', async () => {
    const handler = getCommand('/insights')
    expect(handler).toBeDefined()
    const res = await handler!({ engine: {} } as never, [])
    expect(typeof res.content).toBe('string')
    expect(res.content).toMatch(/Session Insights|No session logs found/)
  })
})
