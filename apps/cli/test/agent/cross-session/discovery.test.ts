import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, existsSync, readFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  ensureUniqueSessionName,
  renameActiveSession,
  registerActiveSession,
  discoverSessions,
} from '../../../src/agent/cross-session/discovery'
import type { SessionInfo } from '../../../src/shared/types'

const TEST_ACTIVE = join(homedir(), '.mipham', '.active-sessions')

function makeSession(id: string, name: string): SessionInfo {
  return { id, name, machine: 'test-host', pid: 1, startedAt: new Date().toISOString() }
}

describe('ensureUniqueSessionName', () => {
  it('returns the preferred name when it is not taken', () => {
    expect(ensureUniqueSessionName('mipham-code', [])).toBe('mipham-code')
  })

  it('appends -2 when the preferred name is already taken', () => {
    const existing = [makeSession('a', 'mipham-code')]
    expect(ensureUniqueSessionName('mipham-code', existing)).toBe('mipham-code-2')
  })

  it('skips taken suffixes to find the next free name', () => {
    const existing = [makeSession('a', 'mipham-code'), makeSession('b', 'mipham-code-2')]
    expect(ensureUniqueSessionName('mipham-code', existing)).toBe('mipham-code-3')
  })

  it('ignores self id when resolving a rename', () => {
    const existing = [makeSession('self', 'mipham-code')]
    expect(ensureUniqueSessionName('mipham-code', existing, 'self')).toBe('mipham-code')
  })
})

describe('renameActiveSession', () => {
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

  it('updates the name in the registry file while keeping the id', () => {
    registerActiveSession(makeSession('rename-s1', 'old-name'))
    const finalName = renameActiveSession('rename-s1', 'new-name')
    expect(finalName).toBe('new-name')
    const raw = readFileSync(join(TEST_ACTIVE, 'rename-s1.json'), 'utf-8')
    const info = JSON.parse(raw) as SessionInfo
    expect(info.name).toBe('new-name')
    expect(info.id).toBe('rename-s1')
  })

  it('returns null for an unknown session and writes nothing', () => {
    const finalName = renameActiveSession('missing-session', 'nope')
    expect(finalName).toBeNull()
    expect(existsSync(join(TEST_ACTIVE, 'missing-session.json'))).toBe(false)
  })
})

describe('stale session pruning', () => {
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

  it('prunes a session whose heartbeat is stale', () => {
    registerActiveSession(makeSession('stale-1', 'stale'))
    const old = new Date(Date.now() - 20 * 60 * 1000) // 20 min ago
    utimesSync(join(TEST_ACTIVE, 'stale-1.json'), old, old)

    const sessions = discoverSessions()
    expect(sessions.find((s) => s.id === 'stale-1')).toBeUndefined()
  })

  it('keeps a freshly-registered session', () => {
    registerActiveSession(makeSession('fresh-1', 'fresh'))
    const sessions = discoverSessions()
    expect(sessions.find((s) => s.id === 'fresh-1')).toBeDefined()
  })
})
