/**
 * CRSI ↔ MegaSystem provenance bridge.
 *
 * Closes the CRSI loop across the terminal↔backend boundary: every
 * auto-generated rule is recorded as an auditable decision in megasystem
 * (via the `mipham-kg` MCP server), and its effectiveness verdict is later
 * attached via `evaluate_decision`. All calls degrade gracefully — when the
 * megasystem MCP server is not connected, `recordDecision` returns null and
 * `evaluateDecision` returns false, so the local CRSI loop keeps working.
 */

import type { ToolCallResult } from '../mcp/types.js'

/** Effectiveness verdicts the CRSI loop can emit for a recorded decision. */
export type CrsiVerdict = 'effective' | 'ineffective' | 'degrading'

/** The narrow MCP surface the bridge needs — injectable for tests. */
export interface CrsiProvenanceClient {
  callTool(
    serverName: string,
    toolName: string,
    params?: Record<string, unknown>,
  ): Promise<ToolCallResult>
}

export class CrsiProvenanceBridge {
  constructor(
    private readonly client: CrsiProvenanceClient,
    private readonly serverName: string = 'mipham-kg',
  ) {}

  /**
   * Record a rule as an auditable decision in megasystem.
   *
   * Returns the megasystem decision id, or null when the server is
   * unavailable or the call failed — the caller may ignore null.
   */
  async recordDecision(
    query: string,
    answer: string,
    confidence?: number,
  ): Promise<string | null> {
    const result = await this.client.callTool(this.serverName, 'record_decision', {
      query,
      answer,
      confidence,
    })
    const parsed = this._parse(result)
    return typeof parsed?.decision_id === 'string' ? parsed.decision_id : null
  }

  /**
   * Attach an effectiveness verdict to a recorded decision.
   *
   * Returns true when the verdict was accepted by megasystem, false otherwise.
   */
  async evaluateDecision(
    decisionId: string,
    verdict: CrsiVerdict,
    opts: { score?: number; metrics?: Record<string, unknown> } = {},
  ): Promise<boolean> {
    const result = await this.client.callTool(this.serverName, 'evaluate_decision', {
      decision_id: decisionId,
      verdict,
      score: opts.score,
      metrics: opts.metrics,
    })
    return !result.isError
  }

  private _parse(result: ToolCallResult): Record<string, unknown> | null {
    if (result.isError) return null
    const text = result.content?.[0]?.text
    if (!text) return null
    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      return null
    }
  }
}
