import { describe, it, expect } from 'vitest'
import {
  CrsiProvenanceBridge,
  type CrsiProvenanceClient,
} from '../../src/agent/crsi-provenance-bridge.js'
import type { ToolCallResult } from '../../src/mcp/types.js'

function makeClient(
  handler: (tool: string, params?: Record<string, unknown>) => ToolCallResult,
): CrsiProvenanceClient {
  return {
    async callTool(serverName: string, toolName: string, params?: Record<string, unknown>) {
      expect(serverName).toBe('mipham-kg')
      return handler(toolName, params)
    },
  }
}

function ok(text: string): ToolCallResult {
  return { content: [{ type: 'text', text }] }
}

describe('CrsiProvenanceBridge', () => {
  it('recordDecision returns decision_id from the server', async () => {
    const client = makeClient((tool) => {
      expect(tool).toBe('record_decision')
      return ok(JSON.stringify({ decision_id: 'd123' }))
    })
    const bridge = new CrsiProvenanceBridge(client)
    expect(await bridge.recordDecision('q', 'a', 0.8)).toBe('d123')
  })

  it('recordDecision forwards query/answer/confidence', async () => {
    let captured: Record<string, unknown> | undefined
    const client = makeClient((tool, params) => {
      captured = params
      return ok(JSON.stringify({ decision_id: 'd1' }))
    })
    const bridge = new CrsiProvenanceBridge(client)
    await bridge.recordDecision('evidence', 'fix rule', 0.7)
    expect(captured).toEqual({ query: 'evidence', answer: 'fix rule', confidence: 0.7 })
  })

  it('recordDecision returns null when the server errors', async () => {
    const client = makeClient(() => ({ content: [], isError: true }))
    const bridge = new CrsiProvenanceBridge(client)
    expect(await bridge.recordDecision('q', 'a')).toBeNull()
  })

  it('recordDecision returns null on non-JSON text', async () => {
    const client = makeClient(() => ok('not json'))
    const bridge = new CrsiProvenanceBridge(client)
    expect(await bridge.recordDecision('q', 'a')).toBeNull()
  })

  it('evaluateDecision returns true on success', async () => {
    const client = makeClient((tool) => {
      expect(tool).toBe('evaluate_decision')
      return ok('{}')
    })
    const bridge = new CrsiProvenanceBridge(client)
    expect(await bridge.evaluateDecision('d123', 'effective')).toBe(true)
  })

  it('evaluateDecision forwards verdict/score/metrics', async () => {
    let captured: Record<string, unknown> | undefined
    const client = makeClient((tool, params) => {
      captured = params
      return ok('{}')
    })
    const bridge = new CrsiProvenanceBridge(client)
    await bridge.evaluateDecision('d123', 'ineffective', {
      score: 0.8,
      metrics: { applied: 10, success: 2 },
    })
    expect(captured).toEqual({
      decision_id: 'd123',
      verdict: 'ineffective',
      score: 0.8,
      metrics: { applied: 10, success: 2 },
    })
  })

  it('evaluateDecision returns false on error', async () => {
    const client = makeClient(() => ({ content: [], isError: true }))
    const bridge = new CrsiProvenanceBridge(client)
    expect(await bridge.evaluateDecision('d123', 'degrading')).toBe(false)
  })
})
