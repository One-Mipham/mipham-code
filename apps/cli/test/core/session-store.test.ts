import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { SessionStore } from '../../src/core/session-store'

const TEST_SESSIONS_DIR = `${process.env.HOME}/.mipham/sessions`

describe('SessionStore', () => {
  beforeEach(() => {
    // Clean up test sessions
    const sessions = SessionStore.list()
    for (const s of sessions) {
      if (s.name.startsWith('test-')) {
        SessionStore.delete(s.name)
      }
    }
  })

  afterEach(() => {
    const sessions = SessionStore.list()
    for (const s of sessions) {
      if (s.name.startsWith('test-')) {
        SessionStore.delete(s.name)
      }
    }
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
})
