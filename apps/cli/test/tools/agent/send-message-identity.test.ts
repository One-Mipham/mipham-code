import { describe, it, expect, vi } from 'vitest'

// Same isolation as the sibling `send-message-cross.test.ts`: keep any
// cross-session filesystem use off the real ~/.mipham.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-send-message-identity`,
  }
})

import { sendMessageTool } from '../../../src/tools/agent/send-message'
import { getMessageBus } from '../../../src/agent/message-bus'
import type { ToolContext } from '../../../src/shared/types'

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: process.cwd(),
    sessionId: 'sub-agent',
    provider: 'mock',
    model: 'mock',
    ...overrides,
  } as ToolContext
}

/**
 * The sender on the envelope is what the parent sees (`Message from @…`,
 * `message-bus.ts`). For a sub-agent that used to be `sub-agent-<ms>`, minted
 * fresh on every call — an opaque id keyed to the message, not the agent, so two
 * messages from one agent arrived as two senders that could not be grouped.
 */
describe('SendMessage — sender identity', () => {
  it('puts the agent name on the envelope and keeps it stable across messages', async () => {
    const bus = getMessageBus()
    const before = bus.list('main').length
    const ctx = makeCtx({ agentName: 'explore' })

    const first = await sendMessageTool.execute({ to: 'main', summary: 'first', message: 'a' }, ctx)
    const second = await sendMessageTool.execute(
      { to: 'main', summary: 'second', message: 'b' },
      ctx,
    )

    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    // Both the reply the tool hands back and the envelope the parent reads.
    expect(first.content).toMatch(/From:\s+explore\b/)
    expect(second.content).toMatch(/From:\s+explore\b/)

    const sent = bus.list('main').slice(before)
    expect(sent).toHaveLength(2)
    expect(sent.map((m) => m.from)).toEqual(['explore', 'explore'])
  })

  it('falls back to the anonymous sub-agent sender when no name is threaded', async () => {
    const ctx = makeCtx({ sessionId: 'sub-agent' }) // no agentName
    const res = await sendMessageTool.execute({ to: 'main', summary: 's', message: 'm' }, ctx)
    expect(res.content).toMatch(/From:\s+sub-agent-[0-9a-z]+\b/)
  })

  it('keeps the raw session id for a caller with no agent identity', async () => {
    const ctx = makeCtx({ sessionId: 'sess-42' })
    const res = await sendMessageTool.execute({ to: 'main', summary: 's', message: 'm' }, ctx)
    expect(res.content).toMatch(/From:\s+sess-42\b/)
  })

  it('keeps "main" for a session-less caller', async () => {
    const ctx = makeCtx({ sessionId: '' })
    const res = await sendMessageTool.execute({ to: 'main', summary: 's', message: 'm' }, ctx)
    expect(res.content).toMatch(/From:\s+main\b/)
  })
})
