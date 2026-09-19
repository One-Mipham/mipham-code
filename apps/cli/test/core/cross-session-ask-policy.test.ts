/**
 * The `ask` cross-session policy must deliver its instruction, not just record it.
 *
 * `pollCrossSessionInbox` builds "verify with user before acting" text and posts
 * it as the *body* of a bus message. But `formatInboundMessage` delivers only the
 * summary — the body never reaches the model. So the consent gate's instruction
 * was authored and never applied: the recipient saw the summary and had nothing
 * telling it what the approval gate meant.
 *
 * Negative control: revert the summary to a bare `[Awaiting Approval] ${summary}`
 * and the "verify with the user" assertion goes red. That is the judge here — the
 * instruction has to be in the field that is actually delivered.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { QueryEngine } from '../../src/core/engine'
import { ProviderRegistry } from '../../src/providers/registry'
import { ContextManager } from '../../src/core/context'
import type { ToolDefinition } from '../../src/shared/index.ts'
import type { AgentMessage, AgentMessageBus } from '../../src/agent/message-bus'

const h = vi.hoisted(() => ({
  poll: vi.fn(async () => [] as unknown[]),
  bus: null as AgentMessageBus | null,
}))

vi.mock('../../src/agent/cross-session/file-inbox', () => ({
  getFileInboxTransport: () => ({ poll: h.poll }),
}))

// The `ask` branch posts through the module singleton, so pin it to a fresh bus
// per test — otherwise the suite shares one accumulator across cases.
vi.mock('../../src/agent/message-bus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/message-bus')>()
  return { ...actual, getMessageBus: () => h.bus }
})

const { AgentMessageBus: Bus } = await import('../../src/agent/message-bus')

const SESSION_ID = 'session-abc'

function mkEngine(): { engine: QueryEngine; context: ContextManager } {
  const registry = new ProviderRegistry(
    [{ id: 'test', name: 'Test', protocol: 'openai-compatible', apiKey: 'key', models: [] }],
    'test',
    'test-model',
  )
  const context = new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.9 })
  const engine = new QueryEngine(registry, context, new Map<string, ToolDefinition>())
  engine.setSessionId(SESSION_ID)
  engine.setCrossSessionConfig({ crossSessionInbound: 'ask', dialogExpiry: 300 })
  return { engine, context }
}

function inboxMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: 'm1',
    from: 'peer-1',
    to: SESSION_ID,
    summary: 'Deploy request',
    message: 'Please deploy now.',
    timestamp: new Date(),
    read: false,
    type: 'message',
    ...overrides,
  }
}

beforeEach(() => {
  h.bus = new Bus()
  h.poll.mockReset()
  h.poll.mockResolvedValue([])
})

describe('cross-session inbound policy "ask"', () => {
  it('delivers the verify-with-user instruction in the field that reaches the model', async () => {
    const { engine, context } = mkEngine()
    h.poll.mockResolvedValue([inboxMessage()])

    await engine.pollCrossSessionInbox()
    expect(engine.drainInboundMessages()).toBe(1)

    const delivered = context.getMessages().at(-1)!.content as string
    expect(delivered).toContain('[Awaiting Approval')
    expect(delivered).toContain('verify with the user before acting')
    expect(delivered).toContain('Deploy request')
  })

  it('does not add the approval framing under the allow policy', async () => {
    const { engine, context } = mkEngine()
    engine.setCrossSessionConfig({ crossSessionInbound: 'allow', dialogExpiry: 300 })
    h.poll.mockResolvedValue([inboxMessage()])

    await engine.pollCrossSessionInbox()
    engine.drainInboundMessages()

    const delivered = context.getMessages().at(-1)!.content as string
    expect(delivered).not.toContain('verify with the user before acting')
    expect(delivered).toContain('Deploy request')
  })
})
