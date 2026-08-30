import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryManager } from '../../../src/core/memory/memory-manager'

const SIXTY_ONE_DAYS = 61 * 24 * 60 * 60 * 1000

function ageFile(dir: string, name: string): void {
  const old = new Date(Date.now() - SIXTY_ONE_DAYS)
  utimesSync(join(dir, `${name}.md`), old, old)
}

describe('recall stats', () => {
  it('records recall counts in a sidecar (recall-stats.json)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mipham-hyg-'))
    const mm = new MemoryManager(dir)
    mm.write('deploy-checklist', 'always run pnpm test before deploying', {
      type: 'project',
      relevance: ['deploy'],
    })
    mm.recall('deploy', 10)
    const stats = JSON.parse(readFileSync(join(dir, 'recall-stats.json'), 'utf-8'))
    expect(stats['deploy-checklist'].recallCount).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('gc', () => {
  it('archives stale un-recalled auto-* memories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mipham-hyg-'))
    const mm = new MemoryManager(dir)
    mm.write('auto-s1-0', 'some lesson from session one', { type: 'feedback', relevance: ['x'] })
    ageFile(dir, 'auto-s1-0')
    mm.loadAll()

    const { archived, candidates } = mm.gc()
    expect(archived).toContain('auto-s1-0')
    expect(candidates).toEqual([])
    expect(existsSync(join(dir, 'archive', 'auto-s1-0.md'))).toBe(true)
    expect(existsSync(join(dir, 'auto-s1-0.md'))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not archive auto-* memories that were recalled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mipham-hyg-'))
    const mm = new MemoryManager(dir)
    mm.write('auto-s1-1', 'deploy checklist for production', {
      type: 'feedback',
      relevance: ['deploy'],
    })
    mm.recall('deploy', 10) // 召回 → recallCount 1
    ageFile(dir, 'auto-s1-1')
    mm.loadAll()

    const { archived } = mm.gc()
    expect(archived).not.toContain('auto-s1-1')
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports (does not archive) stale user-written memories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mipham-hyg-'))
    const mm = new MemoryManager(dir)
    mm.write('manual-note', 'an old note I wrote', { type: 'reference', relevance: ['note'] })
    ageFile(dir, 'manual-note')
    mm.loadAll()

    const { archived, candidates } = mm.gc()
    expect(archived).toEqual([])
    expect(candidates).toContain('manual-note')
    expect(existsSync(join(dir, 'manual-note.md'))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('consolidateAutoMemories', () => {
  it('merges overlapping auto-* into one lesson and removes originals', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mipham-cons-'))
    const mm = new MemoryManager(dir)
    mm.write('auto-s1-0', 'run pnpm test build', {
      type: 'feedback',
      relevance: ['test', 'build'],
    })
    mm.write('auto-s1-1', 'run pnpm test lint', {
      type: 'feedback',
      relevance: ['test', 'lint'],
    })

    const { merged, removed } = mm.consolidateAutoMemories()
    expect(merged).toBe(1)
    expect(removed).toBe(2)
    expect(existsSync(join(dir, 'auto-s1-0.md'))).toBe(false)
    expect(existsSync(join(dir, 'auto-s1-1.md'))).toBe(false)
    const lessons = readdirSync(dir).filter((f) => f.startsWith('lesson-') && f.endsWith('.md'))
    expect(lessons).toHaveLength(1)
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps non-overlapping auto-* as separate lessons', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mipham-cons-'))
    const mm = new MemoryManager(dir)
    mm.write('auto-s1-0', 'the sky is blue today', { type: 'feedback', relevance: ['sky'] })
    mm.write('auto-s1-1', 'remember to drink water', { type: 'feedback', relevance: ['water'] })

    const { merged, removed } = mm.consolidateAutoMemories()
    expect(merged).toBe(2)
    expect(removed).toBe(2)
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not touch non-auto-* memories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mipham-cons-'))
    const mm = new MemoryManager(dir)
    mm.write('manual-note', 'a hand-written note', { type: 'reference', relevance: ['note'] })
    mm.write('auto-s1-0', 'always run pnpm test', { type: 'feedback', relevance: ['test'] })

    const { merged, removed } = mm.consolidateAutoMemories()
    expect(merged).toBe(1)
    expect(removed).toBe(1)
    expect(existsSync(join(dir, 'manual-note.md'))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('findNearDuplicate / write dedup', () => {
  it('merges a same-type near-duplicate instead of creating a new one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mipham-dedup-'))
    const mm = new MemoryManager(dir)
    mm.write('note-a', 'always run pnpm test before deploying', {
      type: 'feedback',
      relevance: ['test'],
    })
    mm.write('note-b', 'always run pnpm test before deploying', {
      type: 'feedback',
      relevance: ['deploy'],
    })
    const memFiles = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
    expect(memFiles).toEqual(['note-a.md'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps clearly different memories separate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mipham-dedup-'))
    const mm = new MemoryManager(dir)
    mm.write('note-a', 'the sky is blue today', { type: 'feedback', relevance: ['sky'] })
    mm.write('note-b', 'remember to drink water', { type: 'feedback', relevance: ['water'] })
    const memFiles = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
    expect(memFiles.sort()).toEqual(['note-a.md', 'note-b.md'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not merge near-duplicates of different type', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mipham-dedup-'))
    const mm = new MemoryManager(dir)
    mm.write('note-a', 'always run pnpm test before deploying', {
      type: 'project',
      relevance: ['test'],
    })
    mm.write('note-b', 'always run pnpm test before deploying', {
      type: 'feedback',
      relevance: ['test'],
    })
    const memFiles = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
    expect(memFiles.sort()).toEqual(['note-a.md', 'note-b.md'])
    rmSync(dir, { recursive: true, force: true })
  })
})
