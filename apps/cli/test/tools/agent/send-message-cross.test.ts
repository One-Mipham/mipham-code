import { describe, it, expect } from 'vitest'
import { MessageRouter } from '../../../src/agent/message-router'
import {
  registerActiveSession,
  unregisterSession,
} from '../../../src/agent/cross-session/discovery'
import type { SessionInfo } from '../../../src/shared/types'

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
})
