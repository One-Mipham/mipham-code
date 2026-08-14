import { describe, it, expect } from 'vitest'
import { MessageRouter, resolveRecipientSession } from '../../../src/agent/message-router'
import {
  registerActiveSession,
  unregisterSession,
} from '../../../src/agent/cross-session/discovery'
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
})
