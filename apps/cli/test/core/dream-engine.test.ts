/**
 * DreamEngine tests — 5-phase memory consolidation with pure text analysis.
 *
 * No LLM calls, no async I/O beyond fs sync ops (mocked via temp dirs).
 * Each phase independently testable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DreamEngine } from '../../src/core/dream-engine.js'

function writeMem(dir: string, name: string, type: string, body: string): void {
  const fm = [
    '---',
    `name: ${name}`,
    'description: test',
    'metadata:',
    `  type: ${type}`,
    '---',
  ].join('\n')
  writeFileSync(join(dir, `${name}.md`), `${fm}\n${body}`, 'utf-8')
}

function writeMemAged(dir: string, name: string, body: string, ageDays: number): void {
  const past = new Date(Date.now() - ageDays * 86_400_000)
  const fm = [
    '---',
    `name: ${name}`,
    'description: test',
    'metadata:',
    '  type: feedback',
    '---',
  ].join('\n')
  const path = join(dir, `${name}.md`)
  writeFileSync(path, `${fm}\n${body}`, 'utf-8')
  const { utimesSync } = require('node:fs')
  utimesSync(path, past, past)
}

describe('DreamEngine', () => {
  let engine: DreamEngine
  let memDir: string
  let indexFile: string
  let counter = 0

  beforeEach(() => {
    memDir = join(tmpdir(), `dream-test-${Date.now()}-${counter++}`)
    indexFile = join(memDir, 'MEMORY.md')
    mkdirSync(memDir, { recursive: true })
    engine = new DreamEngine(memDir)
  })

  afterEach(() => {
    try {
      rmSync(memDir, { recursive: true, force: true })
    } catch {
      /* */
    }
  })

  // ── Empty / edge cases ──

  describe('empty memory', () => {
    it('returns empty report when no memories exist', () => {
      const report = engine.dream()
      expect(report.beforeCount).toBe(0)
      expect(report.afterCount).toBe(0)
      expect(report.actions).toHaveLength(0)
      expect(report.summary).toContain('No memories')
    })

    it('returns empty report when only MEMORY.md exists', () => {
      writeFileSync(indexFile, '# Index\n', 'utf-8')
      const report = engine.dream()
      expect(report.beforeCount).toBe(0)
    })
  })

  // ── Phase 1: Deduplication ──

  describe('Phase 1: Deduplication', () => {
    it('detects near-identical entries without aggressive flag', () => {
      writeMem(memDir, 'fact-a', 'feedback', 'The user prefers dark themes for coding.')
      writeMem(memDir, 'fact-b', 'feedback', 'The user prefers dark themes for coding sessions.')

      const report = engine.dream()
      expect(report.phases.deduplicated).toBeGreaterThanOrEqual(1)
      const dedup = report.actions.filter((a) => a.type === 'dedup')
      expect(dedup.length).toBeGreaterThanOrEqual(1)
      expect(dedup[0]!.autoApplied).toBe(false) // safe mode — only flags
    })

    it('auto-deduplicates with aggressive flag', () => {
      writeMem(memDir, 'fact-a', 'feedback', 'The user prefers dark themes for coding.')
      writeMem(memDir, 'fact-b', 'feedback', 'The user prefers dark themes for coding sessions.')

      const report = engine.dream({ aggressive: true })
      const dedup = report.actions.filter((a) => a.type === 'dedup' && a.autoApplied)
      expect(dedup.length).toBeGreaterThanOrEqual(1)
      expect(existsSync(join(memDir, 'fact-a.md')) || existsSync(join(memDir, 'fact-b.md'))).toBe(
        true,
      )
      expect(existsSync(join(memDir, 'fact-a.md')) && existsSync(join(memDir, 'fact-b.md'))).toBe(
        false,
      )
    })

    it('does NOT flag distinct entries as duplicates', () => {
      writeMem(memDir, 'fact-a', 'feedback', 'User prefers TypeScript over JavaScript.')
      writeMem(memDir, 'fact-b', 'project', 'The MegaSystem ontology has 127 domains registered.')

      const report = engine.dream()
      expect(report.phases.deduplicated).toBe(0)
    })
  })

  // ── Phase 2: Contradiction Detection ──

  describe('Phase 2: Contradiction Detection', () => {
    it('detects opposing claims with similar names', () => {
      writeMem(memDir, 'deploy strategy', 'project', 'We should deploy via Docker Compose.')
      writeMem(memDir, 'deploy strategy v2', 'project', 'We should not deploy via Docker Compose.')

      const report = engine.dream()
      expect(report.phases.contradictionsFound).toBeGreaterThanOrEqual(1)
    })

    it('does NOT flag non-contradictory entries', () => {
      writeMem(memDir, 'ci pipeline', 'project', 'The CI pipeline runs on GitHub Actions.')
      writeMem(memDir, 'cd pipeline', 'project', 'The CD pipeline also uses GitHub Actions.')

      const report = engine.dream()
      expect(report.phases.contradictionsFound).toBe(0)
    })
  })

  // ── Phase 3: Merge Related ──

  describe('Phase 3: Merge Related', () => {
    it('detects related entries of same type', () => {
      // Names similar, same type, content has moderate overlap (≥ 0.3) but below dedup threshold (0.65)
      writeMem(
        memDir,
        'sis design',
        'project',
        'SIS is a self immune system with three defense lines for safe tool execution.',
      )
      writeMem(
        memDir,
        'sis design impl',
        'project',
        'SIS self immune system uses defense lines to block unsafe tool commands.',
      )

      const report = engine.dream()
      expect(report.phases.merged).toBeGreaterThanOrEqual(1)
    })

    it('auto-merges with aggressive flag', () => {
      // Names overlap enough (≥0.5), same type, content moderately similar (≥0.3), below dedup (0.65)
      writeMem(
        memDir,
        'crsi pattern one',
        'project',
        'CRSI analyzes tool error patterns and automatically generates correction rules.',
      )
      writeMem(
        memDir,
        'crsi pattern two',
        'project',
        'CRSI generates new auto correction rules from error pattern analysis results.',
      )

      const report = engine.dream({ aggressive: true })
      const merged = report.actions.filter((a) => a.type === 'merge' && a.autoApplied)
      expect(merged.length).toBeGreaterThanOrEqual(1)
    })

    it('does NOT merge entries of different types', () => {
      writeMem(memDir, 'user pref', 'user', 'Prefers dark mode UI.')
      writeMem(memDir, 'project fact', 'project', 'Uses dark mode UI design system.')

      const report = engine.dream()
      expect(report.phases.merged).toBe(0)
    })
  })

  // ── Phase 4: Solidify Vague ──

  describe('Phase 4: Solidify Vague', () => {
    it('flags entries with vague qualifiers', () => {
      writeMem(
        memDir,
        'maybe-fact',
        'feedback',
        'The user maybe prefers using Bun over Node.js, perhaps because of speed.',
      )

      const report = engine.dream()
      expect(report.phases.solidified).toBeGreaterThanOrEqual(1)
      const flag = report.actions.find((a) => a.type === 'solidify')
      expect(flag).toBeDefined()
      expect(flag!.autoApplied).toBe(false)
    })

    it('does NOT flag definitive statements', () => {
      writeMem(
        memDir,
        'definite-fact',
        'feedback',
        'The user uses Bun as the primary runtime for all Mipham projects.',
      )

      const report = engine.dream()
      expect(report.phases.solidified).toBe(0)
    })

    it('detects "seems" and "probably" as vague', () => {
      writeMem(
        memDir,
        'soft-fact',
        'feedback',
        'It seems like the build is usually faster with caching enabled.',
      )

      const report = engine.dream()
      expect(report.phases.solidified).toBeGreaterThanOrEqual(1)
    })
  })

  // ── Phase 5: Prune Stale ──

  describe('Phase 5: Prune Stale', () => {
    it('flags stale entries (30+ days)', () => {
      writeMemAged(memDir, 'old-fact', 'This is an old fact that should be reviewed.', 35)

      const report = engine.dream()
      expect(report.phases.pruned).toBeGreaterThanOrEqual(1)
    })

    it('auto-prunes stale entries with aggressive flag', () => {
      writeMemAged(memDir, 'very-old', 'Obsolete information.', 60)

      const report = engine.dream({ aggressive: true })
      expect(report.phases.pruned).toBeGreaterThanOrEqual(1)
    })

    it('keeps recent entries', () => {
      writeMem(memDir, 'recent-fact', 'feedback', 'A freshly written memory entry.')

      const report = engine.dream()
      expect(report.phases.pruned).toBe(0)
    })
  })

  // ── Full pipeline ──

  describe('full dream pipeline', () => {
    it('processes a realistic memory set end-to-end', () => {
      writeMem(
        memDir,
        'happy user feedback',
        'feedback',
        'User is happy with TypeScript strict mode.',
      )
      writeMem(
        memDir,
        'happy user feedback dup',
        'feedback',
        'User is happy with TypeScript strict mode and prefers it.',
      )
      writeMem(
        memDir,
        'uncertain fact',
        'feedback',
        'Maybe the user might switch to Rust eventually.',
      )
      writeMemAged(memDir, 'old setup', 'Use Node 18 for this project.', 45)
      writeMem(memDir, 'deploy how to', 'project', 'Deploy using rsync to the production server.')
      writeMem(memDir, 'deploy how not', 'project', 'Do not use rsync use Docker instead.')

      const report = engine.dream()
      expect(report.beforeCount).toBe(6)
      expect(report.phases.deduplicated).toBeGreaterThanOrEqual(1)
      expect(report.phases.contradictionsFound).toBeGreaterThanOrEqual(1)
      expect(report.phases.solidified).toBeGreaterThanOrEqual(1)
      expect(report.phases.pruned).toBeGreaterThanOrEqual(1)
      expect(report.actions.length).toBeGreaterThanOrEqual(4)
    })
  })

  // ── Dream history ──

  describe('dream history', () => {
    it('returns empty history before any dream cycles', () => {
      expect(engine.getDreamHistory()).toEqual([])
    })

    it('persists history across cycles', () => {
      writeMem(memDir, 'fact-1', 'feedback', 'Unique fact one.')
      engine.dream()
      const history = engine.getDreamHistory()
      expect(history.length).toBeGreaterThanOrEqual(1)
    })
  })
})
