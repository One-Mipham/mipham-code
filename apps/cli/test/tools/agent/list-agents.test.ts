import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { listAgentsTool } from '../../../src/tools/agent/list-agents'
import {
  registerActiveSession,
  unregisterSession,
} from '../../../src/agent/cross-session/discovery'
import type { SessionInfo } from '../../../src/shared/types'

const TEST_ACTIVE = join(homedir(), '.mipham', '.active-sessions')

describe('ListAgents tool', () => {
  beforeEach(() => {
    try {
      rmSync(TEST_ACTIVE, { recursive: true })
    } catch {}
  })

  afterEach(() => {
    try {
      rmSync(TEST_ACTIVE, { recursive: true })
    } catch {}
  })

  it('returns empty when no sessions', async () => {
    const result = await listAgentsTool.execute({ scope: 'local' }, {} as any)
    expect(result.success).toBe(true)
    expect(result.content).toContain('No active')
  })

  it('lists registered sessions', async () => {
    const s1: SessionInfo = {
      id: 'session-aaa',
      name: 'Alpha Project',
      machine: 'macbook',
      pid: 1000,
      startedAt: new Date().toISOString(),
      cwd: '/home/user/projects/alpha',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    }
    registerActiveSession(s1)

    const result = await listAgentsTool.execute({ scope: 'local' }, {} as any)
    expect(result.success).toBe(true)
    expect(result.content).toContain('session-aaa')
    expect(result.content).toContain('Alpha Project')
    expect(result.content).toContain('macbook')
    expect(result.content).toContain('claude-sonnet-5')
  })

  it('shows session count in output', async () => {
    registerActiveSession({
      id: 's1',
      name: 'One',
      machine: 'host',
      pid: 1,
      startedAt: new Date().toISOString(),
    })
    registerActiveSession({
      id: 's2',
      name: 'Two',
      machine: 'host',
      pid: 2,
      startedAt: new Date().toISOString(),
    })

    const result = await listAgentsTool.execute({ scope: 'local' }, {} as any)
    expect(result.content).toContain('2 active session')
  })
})
