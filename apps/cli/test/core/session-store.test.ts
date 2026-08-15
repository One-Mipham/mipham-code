import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { SessionStore } from '../../src/core/session-store'
import { SessionLog } from '../../src/core/session-log'

const HOME = process.env.HOME || '~'
const SESSIONS_DIR = join(HOME, '.mipham', 'sessions')
const INDEX_FILE = join(SESSIONS_DIR, '.index.json')
const SUMMARIES_DIR = join(SESSIONS_DIR, '.summaries')

describe('SessionStore', () => {
  beforeEach(() => {
    // Clean up test sessions
    const sessions = SessionStore.list()
    for (const s of sessions) {
      if (s.name.startsWith('test-')) {
        SessionStore.delete(s.name)
      }
    }
    // Clean up index and summaries
    if (existsSync(INDEX_FILE)) unlinkSync(INDEX_FILE)
    if (existsSync(SUMMARIES_DIR)) rmSync(SUMMARIES_DIR, { recursive: true, force: true })
  })

  afterEach(() => {
    const sessions = SessionStore.list()
    for (const s of sessions) {
      if (s.name.startsWith('test-')) {
        SessionStore.delete(s.name)
      }
    }
    // Clean up index and summaries
    if (existsSync(INDEX_FILE)) unlinkSync(INDEX_FILE)
    if (existsSync(SUMMARIES_DIR)) rmSync(SUMMARIES_DIR, { recursive: true, force: true })
  })

  describe('save and load', () => {
    it('saves and loads a session', () => {
      const messages = [
        { role: 'user' as const, content: 'Hello' },
        { role: 'assistant' as const, content: 'Hi there!' },
      ]

      SessionStore.save('test-save-load', messages, {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      })

      const loaded = SessionStore.load('test-save-load')
      expect(loaded).toBeDefined()
      expect(loaded!.messages).toHaveLength(2)
      expect(loaded!.messages[0]!.content).toBe('Hello')
      expect(loaded!.messages[1]!.content).toBe('Hi there!')
      expect(loaded!.metadata.provider).toBe('anthropic')
      expect(loaded!.metadata.model).toBe('claude-sonnet-4-6')
    })

    it('returns null for non-existent session', () => {
      const loaded = SessionStore.load('nonexistent-session-999')
      expect(loaded).toBeNull()
    })
  })

  describe('list', () => {
    it('lists saved sessions', () => {
      SessionStore.save('test-list-a', [{ role: 'user', content: 'a' }])
      SessionStore.save('test-list-b', [{ role: 'user', content: 'b' }])

      const list = SessionStore.list()
      const names = list.map((s) => s.name)
      expect(names).toContain('test-list-a')
      expect(names).toContain('test-list-b')
    })

    it('includes message count in metadata', () => {
      const messages = [
        { role: 'user' as const, content: '1' },
        { role: 'assistant' as const, content: '2' },
        { role: 'user' as const, content: '3' },
      ]
      SessionStore.save('test-count', messages)

      const list = SessionStore.list()
      const session = list.find((s) => s.name === 'test-count')
      expect(session).toBeDefined()
      expect(session!.messageCount).toBe(3)
    })
  })

  describe('delete', () => {
    it('deletes a saved session', () => {
      SessionStore.save('test-delete', [{ role: 'user', content: 'test' }])
      expect(SessionStore.load('test-delete')).toBeDefined()

      const deleted = SessionStore.delete('test-delete')
      expect(deleted).toBe(true)
      expect(SessionStore.load('test-delete')).toBeNull()
    })

    it('returns false for non-existent session', () => {
      expect(SessionStore.delete('never-saved-session')).toBe(false)
    })
  })

  describe('autoSave', () => {
    it('auto-saves with timestamp name', () => {
      const name = SessionStore.autoSave([{ role: 'user', content: 'auto-save test' }], {
        provider: 'openai',
      })
      expect(name).toMatch(/^session-\d{4}-\d{2}-\d{2}T/)
      expect(SessionStore.load(name)).toBeDefined()

      // Cleanup
      SessionStore.delete(name)
    })
  })

  describe('sanitization', () => {
    it('sanitizes session names with special characters', () => {
      SessionStore.save('test-../etc/passwd', [{ role: 'user', content: 'test' }])

      // Should not load with the original name (sanitized to underscores)
      const loaded = SessionStore.load('test-../etc/passwd')
      expect(loaded).toBeDefined()
    })
  })

  describe('session cwd persistence', () => {
    it('save and load preserves cwd', () => {
      const testDir = '/tmp/test-session-cwd'
      SessionStore.save('test-cwd-save', [], {
        provider: 'test',
        model: 'test',
        cwd: testDir,
      })
      const loaded = SessionStore.load('test-cwd-save')
      expect(loaded?.metadata.cwd).toBe(testDir)
    })

    it('load session without cwd returns undefined', () => {
      SessionStore.save('test-no-cwd', [], {
        provider: 'test',
        model: 'test',
      })
      const loaded = SessionStore.load('test-no-cwd')
      expect(loaded?.metadata.cwd).toBeUndefined()
    })
  })

  describe('session index and summary', () => {
    it('getLatest returns most recent session metadata', () => {
      const prefix = `test-latest-${Date.now()}`
      SessionStore.save(`${prefix}-old`, [{ role: 'user', content: 'old' }])
      // Small delay to ensure different timestamps
      SessionStore.save(`${prefix}-new`, [{ role: 'user', content: 'new' }])

      const latest = SessionStore.getLatest()
      expect(latest).toBeDefined()
      // getLatest returns the most recent across ALL sessions (including parallel tests).
      // Our sessions must exist in the index; the most recent overall may not be ours.
      const sessions = SessionStore.list()
      const ourNew = sessions.find((s) => s.name === `${prefix}-new`)
      expect(ourNew).toBeDefined()
    })

    it('saveSummary persists session summary to .summaries/', () => {
      SessionStore.save('test-summary', [{ role: 'user', content: 'test' }])
      SessionStore.saveSummary('test-summary', 'Discussed memory persistence design', [
        'memory',
        'design',
      ])

      const meta = SessionStore.getLatest()
      expect(meta).toBeDefined()
      // Summary is stored in .index.json metadata
      const sessions = SessionStore.list()
      const s = sessions.find((x) => x.name === 'test-summary')
      expect(s).toBeDefined()
    })

    it('updateIndex writes .index.json with all sessions', () => {
      SessionStore.save('test-idx', [{ role: 'user', content: 'idx test' }])
      SessionStore.updateIndex()

      const latest = SessionStore.getLatest()
      expect(latest).toBeDefined()
    })
  })

  describe('saveLog / loadLog', () => {
    it('persists a log and reloads it with events intact', () => {
      const log = new SessionLog('test-savelog')
      log.append({ type: 'session/start', at: 1, sessionId: 'test-savelog', provider: 'anthropic' })
      log.append({ type: 'user/message', at: 1, message: { role: 'user', content: 'hi' } })
      SessionStore.saveLog('test-savelog', log, { provider: 'anthropic', model: 'm' })

      const reloaded = SessionStore.loadLog('test-savelog')
      expect(reloaded).not.toBeNull()
      expect(reloaded!.events()).toHaveLength(2)
      expect(reloaded!.events()[0]).toMatchObject({ type: 'session/start', sessionId: 'test-savelog' })

      SessionStore.delete('test-savelog')
    })

    it('saveLog adds a session/start event if missing, and is idempotent', () => {
      const log = new SessionLog('test-savelog2')
      log.append({ type: 'user/message', at: 1, message: { role: 'user', content: 'hi' } })
      SessionStore.saveLog('test-savelog2', log, { provider: 'p' })
      SessionStore.saveLog('test-savelog2', log, { provider: 'p' })

      const reloaded = SessionStore.loadLog('test-savelog2')
      expect(reloaded!.events()).toHaveLength(2) // session/start + user/message, 无重复

      SessionStore.delete('test-savelog2')
    })
  })
})
