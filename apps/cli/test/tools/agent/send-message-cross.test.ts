import { describe, it, expect, vi } from 'vitest'

// Isolate the cross-session filesystem from the real ~/.mipham so parallel
// test files (discovery/file-inbox/list-agents) that rmSync the shared
// .active-sessions directory cannot race with this file's registrations.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-send-message-cross`,
  }
})

import {
  MessageRouter,
  resolveRecipientSession,
  parseMention,
} from '../../../src/agent/message-router'
import {
  registerActiveSession,
  unregisterSession,
} from '../../../src/agent/cross-session/discovery'
import { sendMessageTool } from '../../../src/tools/agent/send-message'
import type { SessionInfo } from '../../../src/shared/types'

function makeSession(id: string, name: string): SessionInfo {
  return {
    id,
    name,
    machine: 'test-host',
    pid: 1,
    startedAt: new Date().toISOString(),
  }
}

describe('resolveRecipientSession', () => {
  it('resolves by exact id', () => {
    const result = resolveRecipientSession([makeSession('a', 'alpha')], 'a')
    expect(result.session?.id).toBe('a')
    expect(result.error).toBeUndefined()
  })

  it('resolves by unique name', () => {
    const result = resolveRecipientSession([makeSession('a', 'alpha')], 'alpha')
    expect(result.session?.id).toBe('a')
    expect(result.error).toBeUndefined()
  })

  it('prefers id match over name match', () => {
    const result = resolveRecipientSession(
      [makeSession('alpha', 'x'), makeSession('b', 'alpha')],
      'alpha',
    )
    expect(result.session?.id).toBe('alpha')
  })

  it('errors on ambiguous name', () => {
    const result = resolveRecipientSession(
      [makeSession('a', 'dup'), makeSession('b', 'dup')],
      'dup',
    )
    expect(result.session).toBeUndefined()
    expect(result.error).toContain('Ambiguous')
  })

  it('errors when no id or name matches', () => {
    const result = resolveRecipientSession([makeSession('a', 'alpha')], 'zzz')
    expect(result.session).toBeUndefined()
    expect(result.error).toContain('No active session found')
  })
})

describe('parseMention', () => {
  it('parses @name with a message', () => {
    expect(parseMention('@alpha hello there')).toEqual({ name: 'alpha', message: 'hello there' })
  })

  it('parses @name with no message as empty body', () => {
    expect(parseMention('@alpha')).toEqual({ name: 'alpha', message: '' })
  })

  it('trims surrounding whitespace', () => {
    expect(parseMention('  @alpha   hello  ')).toEqual({ name: 'alpha', message: 'hello' })
  })

  it('returns null for plain text (no @mention)', () => {
    expect(parseMention('hello world')).toBeNull()
  })

  it('returns null for a slash command', () => {
    expect(parseMention('/model')).toBeNull()
  })
})

describe('MessageRouter', () => {
  const router = new MessageRouter()

  it('routes "main" to in-process bus', async () => {
    const result = await router.route('test-sender', 'main', 'Hello', 'Test message')
    expect(result.success).toBe(true)
    expect(result.routedTo).toBe('bus')
  })

  it('routes background task IDs to in-process bus', async () => {
    const result = await router.route('test-sender', 'bg-1-abc123', 'Status', 'How is it going?')
    expect(result.success).toBe(true)
    expect(result.routedTo).toBe('bus')
  })

  it('returns error for unknown session ID', async () => {
    const result = await router.route('test-sender', 'nonexistent-session-xyz', 'Hello', 'Test')
    expect(result.success).toBe(false)
    expect(result.routedTo).toBe('unknown')
    expect(result.error).toContain('No active session found')
  })

  it('routes to cross-session inbox for registered session', async () => {
    const targetSession: SessionInfo = {
      id: 'target-session-1',
      name: 'target',
      machine: 'test-host',
      pid: 55555,
      startedAt: new Date().toISOString(),
    }

    registerActiveSession(targetSession)

    const result = await router.route(
      'test-sender',
      'target-session-1',
      'Hello',
      'Cross-session test',
    )
    expect(result.success).toBe(true)
    expect(result.routedTo).toBe('inbox')
    expect(result.messageId).toBeTruthy()

    // Cleanup
    unregisterSession('target-session-1')
  })

  it('routes to inbox by unique session name (bare name)', async () => {
    const targetSession: SessionInfo = {
      id: 'bare-name-id-xyz',
      name: 'bare-name-unique-xyz',
      machine: 'test-host',
      pid: 55556,
      startedAt: new Date().toISOString(),
    }

    registerActiveSession(targetSession)

    const result = await router.route('test-sender', 'bare-name-unique-xyz', 'Hello', 'By name')
    expect(result.success).toBe(true)
    expect(result.routedTo).toBe('inbox')

    // Cleanup
    unregisterSession('bare-name-id-xyz')
  })

  it('reports "refused" when the recipient denies inbound messages', async () => {
    const targetSession: SessionInfo = {
      id: 'deny-session-1',
      name: 'deny-target',
      machine: 'test-host',
      pid: 55557,
      startedAt: new Date().toISOString(),
      crossSessionInbound: 'deny',
    }

    registerActiveSession(targetSession)

    const result = await router.route('test-sender', 'deny-session-1', 'Hello', 'Blocked?')
    expect(result.success).toBe(false)
    expect(result.routedTo).toBe('inbox')
    expect(result.error).toContain('refuses')

    // Cleanup
    unregisterSession('deny-session-1')
  })

  it('marks a message as held when the recipient reviews inbound first', async () => {
    // The default policy is 'ask': writing the file succeeds, but the recipient
    // has not seen the message and may decline it.
    registerActiveSession({
      id: 'ask-session-1',
      name: 'ask-target',
      machine: 'test-host',
      pid: 55558,
      startedAt: new Date().toISOString(),
      crossSessionInbound: 'ask',
    })

    const result = await router.route('test-sender', 'ask-session-1', 'Hello', 'Held?')
    expect(result.success).toBe(true)
    expect(result.routedTo).toBe('inbox')
    expect(result.held).toBe(true)
    expect(result.targetName).toBe('ask-target')

    unregisterSession('ask-session-1')
  })

  it('does not mark a message held when the recipient accepts directly', async () => {
    registerActiveSession({
      id: 'allow-session-1',
      name: 'allow-target',
      machine: 'test-host',
      pid: 55559,
      startedAt: new Date().toISOString(),
      crossSessionInbound: 'allow',
    })

    const result = await router.route('test-sender', 'allow-session-1', 'Hello', 'Direct?')
    expect(result.success).toBe(true)
    expect(result.held).toBe(false)

    unregisterSession('allow-session-1')
  })
})

/**
 * The notice the *sender* reads. Writing to a holder's inbox is not delivery,
 * and the sender acts on this text — "Sent" there means "expect a reply".
 */
describe('SendMessage — held notice', () => {
  it('says the message is queued and names the session holding it', async () => {
    registerActiveSession({
      id: 'held-notice-1',
      name: 'busy-reviewer',
      machine: 'test-host',
      pid: 55560,
      startedAt: new Date().toISOString(),
      crossSessionInbound: 'ask',
    })

    const res = await sendMessageTool.execute(
      { to: 'held-notice-1', summary: 'ping', message: 'are you there?' },
      { cwd: process.cwd(), sessionId: 'session-1', provider: 'mock', model: 'mock' } as never,
    )

    expect(res.success).toBe(true)
    expect(res.content).toContain('Message Queued')
    expect(res.content).not.toContain('Message Sent')
    expect(res.content).toContain('busy-reviewer')
    expect(res.content).toMatch(/not yet delivered|holds inbound/i)

    unregisterSession('held-notice-1')
  })
})
