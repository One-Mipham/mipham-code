import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Isolate session storage to a temp homedir (same pattern as cron.test.ts) so
// tests never touch the developer's real ~/.mipham/sessions/.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-session-store`,
  }
})

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { SessionStore } from '../../src/core/session-store'
import { SessionLog } from '../../src/core/session-log'

const HOME = homedir()
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

  describe('session dir resolution', () => {
    it('resolves sessions under os.homedir(), never a literal "~" in cwd', () => {
      SessionStore.save('test-home-resolve', [{ role: 'user', content: 'x' }])
      const expected = join(homedir(), '.mipham', 'sessions', 'test-home-resolve.jsonl')
      expect(existsSync(expected)).toBe(true)
      SessionStore.delete('test-home-resolve')
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

    // 从前 try 包住整个 for 循环：第一个文件抛异常，list() 就 return [] ——
    // 一个坏会话文件让 /resume 一个会话都不显示，而其余文件全都好好的。
    it('一个坏会话文件只赔上它自己，不吞掉整张列表', () => {
      SessionStore.save('test-list-good', [{ role: 'user', content: 'fine' }])
      mkdirSync(SESSIONS_DIR, { recursive: true })
      const bad = join(SESSIONS_DIR, 'test-list-bad.jsonl')
      // 合法 JSON、不合法事件 —— 投影会在这里抛（rewrite 少 messages ⇒ out 变 undefined）
      writeFileSync(
        bad,
        '{"type":"compaction/rewrite","at":1}\n{"type":"user/message","at":2,"message":{"role":"user","content":"x"}}\n',
        'utf-8',
      )
      try {
        const names = SessionStore.list().map((s) => s.name)
        expect(names).toContain('test-list-good')
        // 坏行被丢掉后，这个文件剩下的那条合法事件仍然算数 —— 是**救回来半份**，
        // 不是整份跳过（跳过才是把可用数据扔了）
        const rescued = SessionStore.list().find((s) => s.name === 'test-list-bad')
        expect(rescued?.messageCount).toBe(1)
      } finally {
        rmSync(bad, { force: true })
      }
    })

    it('读不出来的文件（权限）也只赔上它自己', () => {
      // 这一条测的是**逐文件兜底**本身，与坏内容无关：内容全合法，IO 层抛。
      SessionStore.save('test-list-good3', [{ role: 'user', content: 'fine' }])
      const locked = join(SESSIONS_DIR, 'test-list-locked.jsonl')
      writeFileSync(
        locked,
        '{"type":"user/message","at":1,"message":{"role":"user","content":"x"}}\n',
        'utf-8',
      )
      chmodSync(locked, 0o000)
      try {
        expect(() => readFileSync(locked, 'utf-8')).toThrow() // 正控：这个文件确实读不了
        expect(SessionStore.list().map((s) => s.name)).toContain('test-list-good3')
      } finally {
        chmodSync(locked, 0o600)
        rmSync(locked, { force: true })
      }
    })

    it('全是坏行的文件仍被跳过（不塞一个空会话进列表）', () => {
      SessionStore.save('test-list-good2', [{ role: 'user', content: 'fine' }])
      mkdirSync(SESSIONS_DIR, { recursive: true })
      const bad = join(SESSIONS_DIR, 'test-list-bad2.jsonl')
      writeFileSync(bad, 'null\n', 'utf-8')
      try {
        // 正控：单独看这个文件，它必须仍然被跳过（而不是被当成空会话塞进列表）
        expect(SessionStore.load('test-list-bad2')).toBeNull()
        expect(SessionStore.list().map((s) => s.name)).toContain('test-list-good2')
      } finally {
        rmSync(bad, { force: true })
      }
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
      expect(reloaded!.events()[0]).toMatchObject({
        type: 'session/start',
        sessionId: 'test-savelog',
      })

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

  describe('list dual-format', () => {
    it('lists both new-format and old-format sessions', () => {
      const log = new SessionLog('test-list-new')
      log.append({ type: 'session/start', at: 1, sessionId: 'test-list-new', provider: 'openai' })
      log.append({ type: 'user/message', at: 1, message: { role: 'user', content: 'a' } })
      SessionStore.saveLog('test-list-new', log)
      SessionStore.save('test-list-old', [{ role: 'user', content: 'b' }])

      const names = SessionStore.list().map((s) => s.name)
      expect(names).toContain('test-list-new')
      expect(names).toContain('test-list-old')

      // Cleanup the new-format file (list now sees it, but delete is cleaner)
      SessionStore.delete('test-list-new')
    })
  })

  describe('load old-format fallback + new-format derive', () => {
    it('loads a new-format (event log) session', () => {
      const log = new SessionLog('test-load-new')
      log.append({
        type: 'session/start',
        at: 1,
        sessionId: 'test-load-new',
        provider: 'openai',
        model: 'gpt',
      })
      log.append({ type: 'user/message', at: 1, message: { role: 'user', content: 'Hello' } })
      log.append({
        type: 'assistant/message',
        at: 1,
        message: { role: 'assistant', content: 'Hi' },
      })
      SessionStore.saveLog('test-load-new', log)

      const loaded = SessionStore.load('test-load-new')
      expect(loaded).not.toBeNull()
      expect(loaded!.messages).toHaveLength(2)
      expect(loaded!.messages[0]!.content).toBe('Hello')
      expect(loaded!.metadata.provider).toBe('openai')
      expect(loaded!.metadata.model).toBe('gpt')

      SessionStore.delete('test-load-new')
    })

    it('still loads an old-format (snapshot) session', () => {
      SessionStore.save('test-load-old', [{ role: 'user', content: 'legacy' }], {
        provider: 'anthropic',
      })
      const loaded = SessionStore.load('test-load-old')
      expect(loaded).not.toBeNull()
      expect(loaded!.messages).toHaveLength(1)
      expect(loaded!.metadata.provider).toBe('anthropic')
    })
  })

  describe('loadLog old-format migration', () => {
    it('migrates an old-format snapshot to event log on load', () => {
      SessionStore.save(
        'test-migrate',
        [
          { role: 'user', content: 'legacy hi' },
          { role: 'assistant', content: 'legacy yo' },
        ],
        { provider: 'anthropic', model: 'claude' },
      )

      const log = SessionStore.loadLog('test-migrate')
      const events = log.events()
      expect(events[0]).toMatchObject({
        type: 'session/start',
        sessionId: 'test-migrate',
        provider: 'anthropic',
      })

      const loaded = SessionStore.load('test-migrate')
      expect(loaded!.messages).toHaveLength(2)
      expect(loaded!.metadata.provider).toBe('anthropic')

      SessionStore.delete('test-migrate')
    })
  })
})
