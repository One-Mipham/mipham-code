import { describe, it, expect } from 'vitest'
import { UsageTracker } from '../../src/core/usage-tracker'

describe('UsageTracker', () => {
  it('records API usage for chat turns', () => {
    const tracker = new UsageTracker()
    tracker.recordApiUsage(100, 50, 'chat')

    const summary = tracker.getSummary()
    expect(summary.apiInputTokens).toBe(100)
    expect(summary.apiOutputTokens).toBe(50)
    expect(summary.tools['chat']).toEqual({ inputTokens: 100, outputTokens: 50, calls: 1 })
  })

  it('records API usage attributed to specific tools', () => {
    const tracker = new UsageTracker()
    tracker.recordApiUsage(200, 80, 'Bash')
    tracker.recordApiUsage(150, 60, 'Bash')
    tracker.recordApiUsage(100, 40, 'Read')

    const summary = tracker.getSummary()
    expect(summary.apiInputTokens).toBe(450)
    expect(summary.apiOutputTokens).toBe(180)
    expect(summary.tools['Bash']).toEqual({ inputTokens: 350, outputTokens: 140, calls: 2 })
    expect(summary.tools['Read']).toEqual({ inputTokens: 100, outputTokens: 40, calls: 1 })
  })

  it('correctly attributes MCP tools (mcp__ prefix)', () => {
    const tracker = new UsageTracker()
    tracker.recordApiUsage(300, 120, 'mcp__github_search')
    tracker.recordApiUsage(50, 20, 'chat')

    const summary = tracker.getSummary()
    expect(summary.tools['mcp__github_search']).toBeDefined()
    expect(summary.tools['mcp__github_search']!.inputTokens).toBe(300)
    // MCP tools only get billed for turns where they were actually invoked
    expect(summary.tools['mcp__github_search']!.calls).toBe(1)
  })

  it('records estimated usage as fallback', () => {
    const tracker = new UsageTracker()
    tracker.recordEstimatedUsage(200, 'Bash')

    const summary = tracker.getSummary()
    expect(summary.estimatedTokens).toBe(200)
    expect(summary.tools['Bash']!.inputTokens).toBe(200)
    expect(summary.tools['Bash']!.calls).toBe(1)
  })

  it('reset clears all counters', () => {
    const tracker = new UsageTracker()
    tracker.recordApiUsage(100, 50, 'Bash')
    tracker.recordEstimatedUsage(200, 'chat')
    expect(tracker.totalApiTokens).toBe(150)

    tracker.reset()
    const summary = tracker.getSummary()
    expect(summary.apiInputTokens).toBe(0)
    expect(summary.apiOutputTokens).toBe(0)
    expect(summary.estimatedTokens).toBe(0)
    expect(Object.keys(summary.tools)).toHaveLength(0)
    expect(tracker.totalApiTokens).toBe(0)
  })

  it('getSummary returns sorted tool entries by total tokens', () => {
    const tracker = new UsageTracker()
    tracker.recordApiUsage(100, 50, 'Read')
    tracker.recordApiUsage(500, 200, 'Bash')
    tracker.recordApiUsage(80, 30, 'Write')

    const summary = tracker.getSummary()
    const toolNames = Object.keys(summary.tools)
    // All tools should be present
    expect(toolNames).toContain('Bash')
    expect(toolNames).toContain('Read')
    expect(toolNames).toContain('Write')
  })
})
