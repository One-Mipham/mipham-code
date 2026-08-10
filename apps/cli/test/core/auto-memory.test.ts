import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AutoMemoryEngine, type ToolCallRecord } from '../../src/core/auto-memory'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

function createTestDir(): string {
  const dir = join(tmpdir(), `mipham-test-auto-memory-${randomUUID().slice(0, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('AutoMemoryEngine', () => {
  let engine: AutoMemoryEngine
  let testDir: string

  beforeEach(() => {
    testDir = createTestDir()
    engine = new AutoMemoryEngine(testDir)
  })

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  })

  describe('analyzeTurn', () => {
    it('should produce a reflection with successes and failures', () => {
      const toolCalls: ToolCallRecord[] = [
        { name: 'Read', input: { file_path: 'src/foo.ts' }, success: true },
        {
          name: 'Bash',
          input: { command: 'npm install' },
          success: false,
          error: 'timeout after 120s',
        },
        { name: 'Write', input: { file_path: 'src/bar.ts' }, success: true },
      ]

      const reflection = engine.analyzeTurn({
        sessionId: 'test-session',
        userMessage: 'fix the bug in foo.ts',
        assistantContent: 'I will fix the bug by editing foo.ts',
        toolCalls,
        modelProvider: 'anthropic',
        modelId: 'claude-sonnet-5',
        turnDurationMs: 5000,
      })

      expect(reflection.id).toContain('reflection-test-session-')
      expect(reflection.sessionId).toBe('test-session')
      expect(reflection.successes).toHaveLength(2)
      expect(reflection.failures).toHaveLength(1)
      expect(reflection.failures[0]).toContain('timeout')
      expect(reflection.crsiInsights.length).toBeGreaterThanOrEqual(1)
      expect(reflection.crsiInsights[0]!.category).toBe('timeout')
      expect(reflection.summary).toContain('2')
      expect(reflection.summary).toContain('1')
    })

    it('should handle all-successful turns', () => {
      const toolCalls: ToolCallRecord[] = [
        { name: 'Read', input: { file_path: 'src/foo.ts' }, success: true },
        { name: 'Write', input: { file_path: 'src/bar.ts' }, success: true },
      ]

      const reflection = engine.analyzeTurn({
        sessionId: 'test-session-2',
        userMessage: 'read foo.ts',
        assistantContent: 'done',
        toolCalls,
        modelProvider: 'anthropic',
        modelId: 'claude-sonnet-5',
        turnDurationMs: 1000,
      })

      expect(reflection.successes).toHaveLength(2)
      expect(reflection.failures).toHaveLength(0)
      expect(reflection.crsiInsights).toHaveLength(0)
    })

    it('should extract decisions from assistant content', () => {
      const toolCalls: ToolCallRecord[] = []

      const reflection = engine.analyzeTurn({
        sessionId: 'test-session-3',
        userMessage: '用 React 方案吧',
        assistantContent: '决定使用 React + Ink 方案，采用 Fastify 作为 API 框架',
        toolCalls,
        modelProvider: 'anthropic',
        modelId: 'claude-sonnet-5',
        turnDurationMs: 500,
      })

      expect(reflection.decisions.length).toBeGreaterThanOrEqual(1)
      expect(
        reflection.decisions.some(
          (d) => d.includes('React') || d.includes('Fastify') || d.includes('用户决定'),
        ),
      ).toBe(true)
    })

    it('should extract action items from failures and TODOs', () => {
      const toolCalls: ToolCallRecord[] = [
        { name: 'Bash', input: { command: 'bad-cmd' }, success: false, error: 'command not found' },
      ]

      const reflection = engine.analyzeTurn({
        sessionId: 'test-session-4',
        userMessage: 'run bad-cmd',
        assistantContent: '- [ ] 修复 Bash 超时问题\n- [ ] 更新文档',
        toolCalls,
        modelProvider: 'anthropic',
        modelId: 'claude-sonnet-5',
        turnDurationMs: 2000,
      })

      expect(reflection.actionItems.length).toBeGreaterThanOrEqual(2)
      expect(reflection.actionItems.some((a) => a.includes('修复'))).toBe(true)
    })

    it('should deduplicate CRSI insights by category', () => {
      const toolCalls: ToolCallRecord[] = [
        { name: 'Bash', input: { command: 'npm install' }, success: false, error: 'timeout' },
        {
          name: 'Bash',
          input: { command: 'pnpm test' },
          success: false,
          error: 'timeout after 120s',
        },
        { name: 'Bash', input: { command: 'docker build' }, success: false, error: 'timed out' },
      ]

      const reflection = engine.analyzeTurn({
        sessionId: 'test-session-5',
        userMessage: 'run heavy commands',
        assistantContent: 'running commands...',
        toolCalls,
        modelProvider: 'anthropic',
        modelId: 'claude-sonnet-5',
        turnDurationMs: 10000,
      })

      // Should deduplicate: all 3 failures are 'timeout' category → 1 insight
      const timeoutInsights = reflection.crsiInsights.filter((i) => i.category === 'timeout')
      expect(timeoutInsights).toHaveLength(1)
      expect(timeoutInsights[0]!.severity).toBe('critical')
      expect(timeoutInsights[0]!.autoApplicable).toBe(true)
    })
  })

  describe('persist', () => {
    it('should write a reflection to the memory store', () => {
      const toolCalls: ToolCallRecord[] = [
        { name: 'Read', input: { file_path: 'src/foo.ts' }, success: true },
      ]

      const reflection = engine.analyzeTurn({
        sessionId: 'test-session-persist',
        userMessage: 'read foo',
        assistantContent: 'done',
        toolCalls,
        modelProvider: 'anthropic',
        modelId: 'claude-sonnet-5',
        turnDurationMs: 500,
      })

      engine.persist(reflection)

      // Verify the memory file was created
      const memFile = join(testDir, `${reflection.id}.md`)
      expect(existsSync(memFile)).toBe(true)

      // Verify it has the right content
      const content = readFileSync(memFile, 'utf-8')
      expect(content).toContain('会话复盘')
      expect(content).toContain(reflection.id)
      expect(content).toContain('CRSI 洞察')
      expect(content).toContain('成功项')
      expect(content).toContain('失败项')
      expect(content).toContain('关键决策')
      expect(content).toContain('待办项')
    })

    it('should update MEMORY.md index', () => {
      const toolCalls: ToolCallRecord[] = []

      const reflection = engine.analyzeTurn({
        sessionId: 'test-session-index',
        userMessage: 'hello',
        assistantContent: 'hi',
        toolCalls,
        modelProvider: 'anthropic',
        modelId: 'claude-sonnet-5',
        turnDurationMs: 100,
      })

      engine.persist(reflection)

      const indexFile = join(testDir, 'MEMORY.md')
      expect(existsSync(indexFile)).toBe(true)

      const indexContent = readFileSync(indexFile, 'utf-8')
      expect(indexContent).toContain(reflection.id)
    })
  })

  describe('sessionReflectionCount', () => {
    it('should track accumulated reflection count', () => {
      expect(engine.sessionReflectionCount).toBe(0)

      engine.analyzeTurn({
        sessionId: 'test-count',
        userMessage: 'msg1',
        assistantContent: 'resp1',
        toolCalls: [],
        modelProvider: 'anthropic',
        modelId: 'claude-sonnet-5',
        turnDurationMs: 100,
      })
      expect(engine.sessionReflectionCount).toBe(1)

      engine.analyzeTurn({
        sessionId: 'test-count',
        userMessage: 'msg2',
        assistantContent: 'resp2',
        toolCalls: [],
        modelProvider: 'anthropic',
        modelId: 'claude-sonnet-5',
        turnDurationMs: 100,
      })
      expect(engine.sessionReflectionCount).toBe(2)
    })
  })

  describe('recall', () => {
    it('should recall persisted memories', () => {
      const toolCalls: ToolCallRecord[] = [
        { name: 'Bash', input: { command: 'npm install' }, success: false, error: 'timeout' },
      ]

      const reflection = engine.analyzeTurn({
        sessionId: 'test-recall',
        userMessage: 'install deps',
        assistantContent: 'installing...',
        toolCalls,
        modelProvider: 'anthropic',
        modelId: 'claude-sonnet-5',
        turnDurationMs: 5000,
      })

      engine.persist(reflection)

      const results = engine.recall('timeout')
      expect(results.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('buildReminder', () => {
    it('should build system reminder string', () => {
      const reflection = engine.analyzeTurn({
        sessionId: 'test-reminder',
        userMessage: 'fix the timeout bug',
        assistantContent: '增加 timeout 到 300000ms',
        toolCalls: [
          { name: 'Bash', input: { command: 'npm install', timeout: 300000 }, success: true },
        ],
        modelProvider: 'anthropic',
        modelId: 'claude-sonnet-5',
        turnDurationMs: 3000,
      })

      engine.persist(reflection)

      const reminder = engine.buildReminder('timeout bug')
      expect(typeof reminder).toBe('string')
      // May be empty if no matches, which is acceptable
    })
  })
})
