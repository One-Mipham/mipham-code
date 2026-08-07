import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MemoryManager } from '../../../src/core/memory/memory-manager'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), 'mipham-memory-test-' + Date.now())

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('MemoryManager', () => {
  it('writes and reads a memory entry', () => {
    const mm = new MemoryManager(TEST_DIR)
    mm.write('test-pref', 'User prefers tabs over spaces', {
      type: 'user',
      relevance: ['coding-style'],
    })

    const recalled = mm.recall('coding-style tabs')
    expect(recalled).toHaveLength(1)
    expect(recalled[0]!.name).toBe('test-pref')
    expect(recalled[0]!.content).toContain('tabs over spaces')
  })

  it('deletes a memory', () => {
    const mm = new MemoryManager(TEST_DIR)
    mm.write('temp', 'temporary note', { type: 'feedback', relevance: ['temp'] })
    expect(mm.recall('temp')).toHaveLength(1)

    mm.delete('temp')
    expect(mm.recall('temp')).toHaveLength(0)
  })

  it('builds system reminder within token limit', () => {
    const mm = new MemoryManager(TEST_DIR)
    mm.write('pref-1', 'User likes TypeScript', { type: 'user', relevance: ['ts'] })
    mm.write('pref-2', 'Project uses pnpm', { type: 'project', relevance: ['tools'] })

    const reminder = mm.buildSystemReminder('TypeScript configuration', 100)
    expect(reminder).toContain('<system-reminder>')
    expect(reminder).toContain('pref-1')
    expect(reminder.length).toBeLessThan(200) // within token budget
  })

  it('recall filters by relevance', () => {
    const mm = new MemoryManager(TEST_DIR)
    mm.write('ts-pref', 'TypeScript strict mode', { type: 'user', relevance: ['typescript'] })
    mm.write('py-pref', 'Python 3.12+', { type: 'user', relevance: ['python'] })

    const tsResults = mm.recall('TypeScript project')
    expect(tsResults).toHaveLength(1)
    expect(tsResults[0]!.name).toBe('ts-pref')
  })

  it('updates existing memory with same name', () => {
    const mm = new MemoryManager(TEST_DIR)
    mm.write('note', 'First version', { type: 'feedback', relevance: ['test'] })
    mm.write('note', 'Updated version', { type: 'feedback', relevance: ['test'] })

    const recalled = mm.recall('test')
    expect(recalled).toHaveLength(1)
    expect(recalled[0]!.content).toContain('Updated version')
  })

  it('handles empty directory gracefully', () => {
    const mm = new MemoryManager(TEST_DIR)
    mm.loadAll()
    expect(mm.recall('anything')).toHaveLength(0)
  })

  it('extracts wikilinks from content and builds link graph', () => {
    const mm = new MemoryManager(TEST_DIR)
    mm.write('phase-4', 'Phase 4 complete. See also: [[phase-5]] [[service-mesh]]', {
      type: 'project',
      relevance: ['phase-4'],
    })

    const linked = mm.getLinkedMemories('phase-4')
    expect(linked).toHaveLength(0) // phase-5 not written yet, so no resolved links

    mm.write('phase-5', 'Phase 5 next steps. See also: [[phase-4]]', {
      type: 'project',
      relevance: ['phase-5'],
    })

    // Now the link is bidirectional
    const linked2 = mm.getLinkedMemories('phase-4')
    expect(linked2).toHaveLength(1)
    expect(linked2[0]!.name).toBe('phase-5')

    // Verify reverse direction
    const reverseLinked = mm.getLinkedMemories('phase-5')
    expect(reverseLinked).toHaveLength(1)
    expect(reverseLinked[0]!.name).toBe('phase-4')
  })

  it('write with why/howToApply stores structured memory', () => {
    const mm = new MemoryManager(TEST_DIR)
    mm.write('decision', 'Use pnpm over npm', {
      type: 'project',
      relevance: ['tools'],
      why: 'Faster installs, strict dependency resolution',
      howToApply: 'Always use pnpm for new projects',
    })

    const recalled = mm.recall('pnpm decision')
    expect(recalled).toHaveLength(1)
    expect(recalled[0]!.content).toContain('**Why:**')
    expect(recalled[0]!.content).toContain('Faster installs')
    expect(recalled[0]!.content).toContain('**How to apply:**')
    expect(recalled[0]!.content).toContain('Always use pnpm')
  })

  it('write with same name updates instead of duplicating', () => {
    const mm = new MemoryManager(TEST_DIR)
    mm.write('same-name', 'Version 1', {
      type: 'feedback',
      relevance: ['test'],
    })
    mm.write('same-name', 'Version 2', {
      type: 'feedback',
      relevance: ['test'],
    })

    const all = mm.recall('test')
    expect(all).toHaveLength(1) // not duplicated
    expect(all[0]!.content).toContain('Version 2')
  })

  it('distillFromSession splits summary into individual memories', () => {
    const mm = new MemoryManager(TEST_DIR)
    const summary = `Session summary:
- User prefers TypeScript strict mode. **Why:** type safety. **How to apply:** enable strict in tsconfig.
- Decided to use Vitest for testing. **Why:** faster than Jest. **How to apply:** use vitest.config.ts in new projects.`

    const entries = mm.distillFromSession(summary, 'session-test-001')
    expect(entries.length).toBeGreaterThanOrEqual(2)

    const tsEntry = entries.find((e) => e.content.includes('TypeScript'))
    expect(tsEntry).toBeDefined()
    expect(tsEntry!.metadata.type).toBe('feedback')
    expect(tsEntry!.metadata.relevance).toContain('typescript')

    const vitestEntry = entries.find((e) => e.content.includes('Vitest'))
    expect(vitestEntry).toBeDefined()
    expect(vitestEntry!.content).toContain('**Why:** faster than Jest')
  })

  it('recall includes wikilink-connected memories with lower weight', () => {
    const mm = new MemoryManager(TEST_DIR)
    mm.write('a', 'Memory A. See also: [[b]]', {
      type: 'project',
      relevance: ['topic-a'],
    })
    mm.write('b', 'Memory B — connected from A', {
      type: 'project',
      relevance: ['topic-b'],
    })

    // Search for topic-a — should get both A (direct) and B (via wikilink)
    const results = mm.recall('topic-a')
    const names = results.map((r) => r.name)
    expect(names).toContain('a')
    expect(names).toContain('b')
    // 'a' should come first (higher score)
    expect(names[0]).toBe('a')
  })
})
