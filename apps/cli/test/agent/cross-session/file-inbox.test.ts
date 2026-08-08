import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  FileInboxTransport,
  getFileInboxTransport,
} from '../../../src/agent/cross-session/file-inbox'
import {
  registerActiveSession,
  unregisterSession,
  discoverSessions,
} from '../../../src/agent/cross-session/discovery'
import type { SessionInfo } from '../../../src/shared/types'

const TEST_INBOX = join(homedir(), '.mipham', 'inbox', 'test-session-cross')
const TEST_ACTIVE = join(homedir(), '.mipham', '.active-sessions')

describe('FileInboxTransport', () => {
  const transport = new FileInboxTransport()

  const fromSession: SessionInfo = {
    id: 'sender-123',
    name: 'sender-session',
    machine: 'test-host',
    pid: 12345,
    startedAt: new Date().toISOString(),
  }

  beforeEach(() => {
    // Clean up test directories
    try {
      rmSync(TEST_INBOX, { recursive: true })
    } catch {}
    try {
      rmSync(TEST_ACTIVE, { recursive: true })
    } catch {}
  })

  afterEach(() => {
    try {
      rmSync(TEST_INBOX, { recursive: true })
    } catch {}
    try {
      rmSync(TEST_ACTIVE, { recursive: true })
    } catch {}
  })

  it('sends a message to a session inbox', async () => {
    const result = await transport.send(fromSession, 'test-session-cross', {
      id: 'msg-1',
      from: 'sender-123',
      to: 'test-session-cross',
      summary: 'Hello',
      message: 'How are you?',
      timestamp: new Date(),
      read: false,
      type: 'message',
    })
    expect(result).toBe(true)
    expect(existsSync(TEST_INBOX)).toBe(true)
  })

  it('polls messages from inbox', async () => {
    // Send a message first
    await transport.send(fromSession, 'test-session-cross', {
      id: 'msg-1',
      from: 'sender-123',
      to: 'test-session-cross',
      summary: 'Hello',
      message: 'Test message body',
      timestamp: new Date(),
      read: false,
      type: 'message',
    })

    const messages = await transport.poll('test-session-cross')
    expect(messages).toHaveLength(1)
    expect(messages[0]!.summary).toBe('Hello')
    expect(messages[0]!.from).toBe('sender-123')
  })

  it('poll returns empty for unknown session', async () => {
    const messages = await transport.poll('nonexistent-session')
    expect(messages).toHaveLength(0)
  })

  it('poll deletes messages after reading', async () => {
    await transport.send(fromSession, 'test-session-cross', {
      id: 'msg-1',
      from: 'sender-123',
      to: 'test-session-cross',
      summary: 'Ephemeral',
      message: 'This should be deleted after poll',
      timestamp: new Date(),
      read: false,
      type: 'message',
    })

    // First poll returns the message
    const first = await transport.poll('test-session-cross')
    expect(first).toHaveLength(1)

    // Second poll returns nothing (messages deleted after read)
    const second = await transport.poll('test-session-cross')
    expect(second).toHaveLength(0)
  })

  it('send returns false on error (invalid path chars)', async () => {
    const result = await transport.send(fromSession, 'invalid/\0/path', {
      id: 'msg-1',
      from: 'sender',
      to: 'invalid/\0/path',
      summary: '',
      message: '',
      timestamp: new Date(),
      read: false,
      type: 'message',
    })
    expect(result).toBe(false)
  })
})

describe('discovery', () => {
  const testSession: SessionInfo = {
    id: 'discovery-test-1',
    name: 'test-discover',
    machine: 'test-host',
    pid: 99999,
    startedAt: new Date().toISOString(),
    cwd: '/tmp',
  }

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

  it('discovers registered sessions', () => {
    registerActiveSession(testSession)
    const sessions = discoverSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.id).toBe('discovery-test-1')
    expect(sessions[0]!.name).toBe('test-discover')
    expect(sessions[0]!.machine).toBe('test-host')
  })

  it('returns empty when no sessions registered', () => {
    const sessions = discoverSessions()
    expect(sessions).toHaveLength(0)
  })

  it('unregister removes session', () => {
    registerActiveSession(testSession)
    unregisterSession('discovery-test-1')
    const sessions = discoverSessions()
    expect(sessions).toHaveLength(0)
  })

  it('discovers multiple sessions sorted by start time', () => {
    const older: SessionInfo = {
      ...testSession,
      id: 'older-session',
      startedAt: '2026-01-01T00:00:00.000Z',
    }
    const newer: SessionInfo = {
      ...testSession,
      id: 'newer-session',
      startedAt: '2026-08-08T00:00:00.000Z',
    }
    registerActiveSession(older)
    registerActiveSession(newer)
    const sessions = discoverSessions()
    expect(sessions).toHaveLength(2)
    expect(sessions[0]!.id).toBe('newer-session') // most recent first
    expect(sessions[1]!.id).toBe('older-session')
  })
})
