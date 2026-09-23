/**
 * `/bg` must actually run the prompt.
 *
 * The command used to create an Agent View row, flip it to `working`, and report
 * "✓ Background agent spawned" — without ever handing the prompt to a model. The
 * row then sat at `working` forever. These tests pin the two halves that make the
 * claim true: a `BackgroundAgentRegistry.spawn` call whose executor really runs
 * the prompt through a SubAgent, and a session status that follows the executor's
 * actual outcome.
 *
 * Negative control: revert `bgCmd` to the session-only version and the first
 * assertion (`spawn` called once) goes red — the executor it inspects would not
 * exist.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { AgentViewManager } from '../../src/agent-view/agent-view-manager'
import type { CommandContext } from '../../src/ui/commands'

const h = vi.hoisted(() => ({
  spawn: vi.fn(() => 'bg-1'),
  execute: vi.fn(),
}))

vi.mock('../../src/agent/background-registry', () => ({
  getBackgroundAgentRegistry: () => ({ spawn: h.spawn }),
}))

vi.mock('../../src/agent/sub-agent', () => ({
  SubAgent: class {
    execute = h.execute
  },
}))

const { getCommand } = await import('../../src/ui/commands')

type Executor = (signal: AbortSignal) => Promise<string>

function mkCtx(mgr: AgentViewManager): CommandContext {
  return {
    engine: {
      getAgentViewManager: () => mgr,
      getRegistry: () => ({}),
      getTools: () => new Map(),
      getPermission: () => ({}),
      getLlm: () => undefined,
    },
    providerId: 'test-provider',
    modelId: 'test-model',
  } as unknown as CommandContext
}

/** Run `/bg <args>`, then hand back the executor the command registered. */
async function runBg(mgr: AgentViewManager, args: string[]): Promise<Executor> {
  const handler = getCommand('/bg')
  if (!handler) throw new Error('/bg is not registered')

  const result = await handler(mkCtx(mgr), args)
  expect(result.content).toContain('Background agent spawned')

  expect(h.spawn).toHaveBeenCalledTimes(1)
  const call = h.spawn.mock.calls[0] as unknown as [string, string, Executor, string]
  return call[2]
}

beforeEach(() => {
  h.spawn.mockClear()
  h.execute.mockReset()
})

describe('/bg', () => {
  it('runs the prompt through a sub-agent instead of only listing a session', async () => {
    const mgr = new AgentViewManager()
    h.execute.mockResolvedValue('the suite is green\n')

    const executor = await runBg(mgr, ['summarize', 'the', 'repo'])
    const output = await executor(new AbortController().signal)

    // The whole point: the prompt reaches a model-driven executor — and it
    // carries the registry's abort signal down, which is the only thing that
    // makes Ctrl+X in Agent View able to stop a running `/bg`.
    expect(h.execute).toHaveBeenCalledWith('summarize the repo', expect.any(String), {
      type: 'general',
      signal: expect.any(AbortSignal),
    })
    expect(output).toBe('the suite is green\n')

    const session = mgr.list()[0]!
    expect(session.status).toBe('completed')
    expect(session.kind).toBe('unattended')
    expect(session.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(session.messages[0]!.content).toBe('summarize the repo')
    expect(session.messages[1]!.content).toBe('the suite is green\n')
  })

  it('leaves the session honest when the executor fails', async () => {
    const mgr = new AgentViewManager()
    h.execute.mockRejectedValue(new Error('provider offline'))

    const executor = await runBg(mgr, ['do', 'the', 'thing'])
    await expect(executor(new AbortController().signal)).rejects.toThrow('provider offline')

    const session = mgr.list()[0]!
    expect(session.status).toBe('failed')
    expect(session.messages.at(-1)!.content).toContain('provider offline')
  })
})
