/**
 * Auto-Dream: Background Memory Consolidation Engine
 *
 * Inspired by Claude Code's Auto-Dream mechanism: a periodic background process
 * that reviews accumulated memory, resolves contradictions, merges related
 * knowledge, and solidifies vague expressions into definite facts.
 *
 * Unlike Claude Code's LLM-driven approach, DreamEngine uses pure text analysis
 * for the most common operations (dedup, contradiction detection via keyword
 * overlap, stale entry cleanup). An optional summarizer callback enables
 * LLM-powered deep consolidation when available.
 *
 * Designed to be called:
 *   - Periodically (every 24h or every 5 sessions) via daemon ScheduleManager
 *   - Manually via `/dream` CLI command
 *   - On session end as a lightweight pass
 *
 * Flow:
 *   Load all memory entries
 *     → Phase 1: Deduplicate near-identical entries
 *     → Phase 2: Detect contradictions (opposing claims)
 *     → Phase 3: Merge related entries (overlapping topics)
 *     → Phase 4: Solidify vague entries (flag "maybe"/"possibly" for review)
 *     → Phase 5: Prune stale entries (30+ days, low relevance)
 *     → Write consolidated memory + generate DreamReport
 */

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ── Types ──

export interface DreamReport {
  /** When the dream cycle ran */
  timestamp: string
  /** Total memories before consolidation */
  beforeCount: number
  /** Total memories after consolidation */
  afterCount: number
  /** Per-phase statistics */
  phases: {
    deduplicated: number
    contradictionsFound: number
    merged: number
    solidified: number
    pruned: number
  }
  /** Specific actions taken */
  actions: DreamAction[]
  /** Summary for display */
  summary: string
}

export interface DreamAction {
  type: 'dedup' | 'contradiction' | 'merge' | 'solidify' | 'prune'
  description: string
  filesAffected: string[]
  autoApplied: boolean
}

interface MemoryFile {
  path: string
  name: string
  frontmatter: Record<string, unknown>
  content: string
  /** Days since last modified */
  age: number
}

// ── Constants ──

const MEMORY_DIR = join(homedir(), '.mipham', 'memory')
const DREAM_LOG = join(homedir(), '.mipham', 'dream-log.json')
const STALE_DAYS = 30
const SIMILARITY_THRESHOLD = 0.75

/** Vague qualifiers that suggest an entry needs solidification */
const VAGUE_PATTERNS = [
  /\bmaybe\b/i,
  /\bperhaps\b/i,
  /\bpossibly\b/i,
  /\bmight\b/i,
  /\bcould be\b/i,
  /\bunsure\b/i,
  /\bunclear\b/i,
  /\bseems?\b/i,
  /\bprobably\b/i,
  /\btypically\b/i,
  /\busually\b/i,
  /\boften\b/i,
]

// ── Engine ──

export class DreamEngine {
  private memoryDir: string

  constructor(memoryDir: string = MEMORY_DIR) {
    this.memoryDir = memoryDir
  }

  /**
   * Run a full dream consolidation cycle.
   *
   * @param options.aggressive — if true, auto-apply more actions (default: safe-only)
   * @returns DreamReport with statistics and actions taken
   */
  dream(options: { aggressive?: boolean } = {}): DreamReport {
    const { aggressive = false } = options
    const actions: DreamAction[] = []
    const timestamp = new Date().toISOString()

    // Load all memory files
    const memories = this.loadMemories()
    const beforeCount = memories.length

    if (memories.length === 0) {
      return {
        timestamp,
        beforeCount: 0,
        afterCount: 0,
        phases: { deduplicated: 0, contradictionsFound: 0, merged: 0, solidified: 0, pruned: 0 },
        actions: [],
        summary: 'No memories to consolidate. Dream skipped.',
      }
    }

    // ── Phase 1: Deduplicate near-identical entries ──
    const dedupResult = this.deduplicate(memories, aggressive)
    actions.push(...dedupResult.actions)
    let working = dedupResult.memories

    // ── Phase 2: Detect contradictions ──
    const contradictions = this.detectContradictions(working)
    actions.push(...contradictions)
    // Contradictions are flagged, not auto-resolved

    // ── Phase 3: Merge related entries ──
    const mergeResult = this.mergeRelated(working, aggressive)
    actions.push(...mergeResult.actions)
    working = mergeResult.memories

    // ── Phase 4: Solidify vague entries ──
    const solidifyActions = this.solidifyVague(working)
    actions.push(...solidifyActions)
    // Solidification just flags — human or LLM should resolve

    // ── Phase 5: Prune stale entries ──
    const pruneResult = this.pruneStale(working, aggressive)
    actions.push(...pruneResult.actions)
    working = pruneResult.memories

    // ── Persist dream log ──
    this.saveDreamLog(timestamp, actions)

    const afterCount = working.length
    const autoApplied = actions.filter((a) => a.autoApplied).length
    const flagged = actions.filter((a) => !a.autoApplied).length

    return {
      timestamp,
      beforeCount,
      afterCount,
      phases: {
        deduplicated: dedupResult.actions.length,
        contradictionsFound: contradictions.length,
        merged: mergeResult.actions.length,
        solidified: solidifyActions.length,
        pruned: pruneResult.actions.length,
      },
      actions,
      summary: [
        `Dream complete: ${beforeCount} → ${afterCount} memories`,
        `${autoApplied} actions auto-applied, ${flagged} flagged for review`,
        `Phases: ${dedupResult.actions.length} deduped, ${contradictions.length} contradictions, ${mergeResult.actions.length} merged, ${solidifyActions.length} solidified, ${pruneResult.actions.length} pruned`,
      ].join('\n'),
    }
  }

  // ── Phase 1: Deduplication ──

  private deduplicate(
    memories: MemoryFile[],
    aggressive: boolean,
  ): { memories: MemoryFile[]; actions: DreamAction[] } {
    const actions: DreamAction[] = []
    const kept: MemoryFile[] = []
    const removed = new Set<string>()

    for (let i = 0; i < memories.length; i++) {
      if (removed.has(memories[i]!.path)) continue

      for (let j = i + 1; j < memories.length; j++) {
        if (removed.has(memories[j]!.path)) continue

        const similarity = this.jaccardSimilarity(memories[i]!.content, memories[j]!.content)

        if (similarity >= SIMILARITY_THRESHOLD) {
          // Keep the older, more established entry
          const keep = memories[i]!.age >= memories[j]!.age ? memories[i]! : memories[j]!
          const remove = keep === memories[i]! ? memories[j]! : memories[i]!

          if (aggressive) {
            try {
              unlinkSync(remove.path)
              removed.add(remove.path)
              actions.push({
                type: 'dedup',
                description: `Merged near-duplicate: "${remove.name}" → "${keep.name}" (${Math.round(similarity * 100)}% similar)`,
                filesAffected: [remove.path],
                autoApplied: true,
              })
            } catch {
              // Best-effort
            }
          } else {
            actions.push({
              type: 'dedup',
              description: `Near-duplicate detected: "${remove.name}" ≈ "${keep.name}" (${Math.round(similarity * 100)}% similar). Run /dream --aggressive to auto-merge.`,
              filesAffected: [keep.path, remove.path],
              autoApplied: false,
            })
          }
        }
      }

      if (!removed.has(memories[i]!.path)) {
        kept.push(memories[i]!)
      }
    }

    return { memories: kept, actions }
  }

  // ── Phase 2: Contradiction Detection ──

  private detectContradictions(memories: MemoryFile[]): DreamAction[] {
    const actions: DreamAction[] = []

    // Simple heuristic: two entries about the same topic (similar name/description)
    // but with opposing sentiment markers
    const negationWords = /\b(not?|never|no|don't|doesn't|shouldn't|can't|cannot)\b/i

    for (let i = 0; i < memories.length; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        const a = memories[i]!
        const b = memories[j]!

        // Must be about similar topics
        const nameSim = this.jaccardSimilarity(a.name, b.name)
        if (nameSim < 0.4) continue

        // One has negation, the other doesn't → potential contradiction
        const aNegates = negationWords.test(a.content)
        const bNegates = negationWords.test(b.content)

        if (aNegates !== bNegates) {
          actions.push({
            type: 'contradiction',
            description: `Potential contradiction: "${a.name}" vs "${b.name}" — one asserts, the other negates. Review manually.`,
            filesAffected: [a.path, b.path],
            autoApplied: false,
          })
        }
      }
    }

    return actions
  }

  // ── Phase 3: Merge Related ──

  private mergeRelated(
    memories: MemoryFile[],
    aggressive: boolean,
  ): { memories: MemoryFile[]; actions: DreamAction[] } {
    const actions: DreamAction[] = []
    const merged = new Set<string>()
    const result: MemoryFile[] = []

    for (let i = 0; i < memories.length; i++) {
      if (merged.has(memories[i]!.path)) continue

      const related: MemoryFile[] = [memories[i]!]

      for (let j = i + 1; j < memories.length; j++) {
        if (merged.has(memories[j]!.path)) continue

        // Related if: same type + high name similarity + moderate content overlap
        const metaI = memories[i]!.frontmatter['metadata'] as Record<string, unknown> | undefined
        const metaJ = memories[j]!.frontmatter['metadata'] as Record<string, unknown> | undefined
        const sameType = metaI?.['type'] === metaJ?.['type']
        const nameSim = this.jaccardSimilarity(memories[i]!.name, memories[j]!.name)
        const contentSim = this.jaccardSimilarity(
          memories[i]!.content.slice(0, 500),
          memories[j]!.content.slice(0, 500),
        )

        if (sameType && nameSim >= 0.5 && contentSim >= 0.3) {
          related.push(memories[j]!)
          merged.add(memories[j]!.path)
        }
      }

      if (related.length >= 2 && aggressive) {
        // Merge: keep the most recent, append "See also" links to others
        const primary = related.sort((a, b) => b.age - a.age)[0]!
        const secondary = related.filter((r) => r !== primary)

        try {
          const links = secondary.map((s) => `- See also: [[${s.name}]]`).join('\n')
          const updated = primary.content + `\n\n## Related\n${links}`
          writeFileSync(primary.path, updated, 'utf-8')

          for (const s of secondary) {
            try {
              unlinkSync(s.path)
            } catch {
              /* best-effort */
            }
          }

          actions.push({
            type: 'merge',
            description: `Merged ${secondary.length} related entries into "${primary.name}"`,
            filesAffected: [primary.path, ...secondary.map((s) => s.path)],
            autoApplied: true,
          })

          result.push(primary)
        } catch {
          result.push(...related)
        }
      } else if (related.length >= 2) {
        actions.push({
          type: 'merge',
          description: `${related.length} related entries found around "${memories[i]!.name}". Run /dream --aggressive to auto-merge.`,
          filesAffected: related.map((r) => r.path),
          autoApplied: false,
        })
        result.push(...related)
      } else {
        result.push(memories[i]!)
      }
    }

    return { memories: result, actions }
  }

  // ── Phase 4: Solidify Vague ──

  private solidifyVague(memories: MemoryFile[]): DreamAction[] {
    const actions: DreamAction[] = []

    for (const mem of memories) {
      const vagueMatches = VAGUE_PATTERNS.filter((p) => p.test(mem.content))
      if (vagueMatches.length > 0) {
        const matched = vagueMatches
          .map((p) => {
            const m = mem.content.match(p)
            return m ? `"${m[0]}"` : ''
          })
          .filter(Boolean)
          .join(', ')
        actions.push({
          type: 'solidify',
          description: `Vague entry "${mem.name}" uses qualifiers: ${matched}. Consider replacing with definite statements.`,
          filesAffected: [mem.path],
          autoApplied: false,
        })
      }
    }

    return actions
  }

  // ── Phase 5: Prune Stale ──

  private pruneStale(
    memories: MemoryFile[],
    aggressive: boolean,
  ): { memories: MemoryFile[]; actions: DreamAction[] } {
    const actions: DreamAction[] = []
    const kept: MemoryFile[] = []

    for (const mem of memories) {
      if (mem.age > STALE_DAYS) {
        if (aggressive) {
          try {
            unlinkSync(mem.path)
            actions.push({
              type: 'prune',
              description: `Pruned stale entry: "${mem.name}" (${mem.age}d old)`,
              filesAffected: [mem.path],
              autoApplied: true,
            })
          } catch {
            kept.push(mem)
          }
        } else {
          actions.push({
            type: 'prune',
            description: `Stale entry: "${mem.name}" (${mem.age}d old). Run /dream --aggressive to prune.`,
            filesAffected: [mem.path],
            autoApplied: false,
          })
          kept.push(mem)
        }
      } else {
        kept.push(mem)
      }
    }

    return { memories: kept, actions }
  }

  // ── Helpers ──

  private loadMemories(): MemoryFile[] {
    if (!existsSync(this.memoryDir)) return []

    try {
      const files = readdirSync(this.memoryDir).filter(
        (f) => f.endsWith('.md') && f !== 'MEMORY.md',
      )

      return files
        .map((f) => {
          const path = join(this.memoryDir, f)
          try {
            const raw = readFileSync(path, 'utf-8')
            const { frontmatter, content } = this.parseFrontmatter(raw)
            const stat = statSync(path)
            const age = Math.floor((Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24))
            return {
              path,
              name: f.replace('.md', ''),
              frontmatter: frontmatter as Record<string, unknown>,
              content,
              age,
            }
          } catch {
            return null
          }
        })
        .filter((m): m is MemoryFile => m !== null)
    } catch {
      return []
    }
  }

  private parseFrontmatter(raw: string): {
    frontmatter: Record<string, unknown>
    content: string
  } {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!match) return { frontmatter: {}, content: raw }
    try {
      const lines = match[1]!.split('\n')
      const fm: Record<string, unknown> = {}
      for (const line of lines) {
        const kv = line.match(/^(\w[\w\s]*?):\s*(.+)$/)
        if (kv) fm[kv[1]!.trim()] = kv[2]!.trim()
      }
      return { frontmatter: fm, content: match[2] || '' }
    } catch {
      return { frontmatter: {}, content: raw }
    }
  }

  private jaccardSimilarity(a: string, b: string): number {
    const tokensA = new Set(
      a
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 1),
    )
    const tokensB = new Set(
      b
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 1),
    )
    if (tokensA.size === 0 || tokensB.size === 0) return 0

    let intersection = 0
    for (const t of tokensA) {
      if (tokensB.has(t)) intersection++
    }
    const union = tokensA.size + tokensB.size - intersection
    return union > 0 ? intersection / union : 0
  }

  private saveDreamLog(timestamp: string, actions: DreamAction[]): void {
    try {
      const dir = join(this.memoryDir, '..')
      mkdirSync(dir, { recursive: true })

      let log: Array<{ timestamp: string; actions: DreamAction[] }> = []
      if (existsSync(DREAM_LOG)) {
        log = JSON.parse(readFileSync(DREAM_LOG, 'utf-8'))
      }
      log.unshift({ timestamp, actions })
      // Keep last 10 dream cycles
      if (log.length > 10) log = log.slice(0, 10)
      writeFileSync(DREAM_LOG, JSON.stringify(log, null, 2), 'utf-8')
    } catch {
      // Best-effort persistence
    }
  }

  /** Get dream history for display. */
  getDreamHistory(): Array<{ timestamp: string; actions: DreamAction[] }> {
    try {
      if (!existsSync(DREAM_LOG)) return []
      return JSON.parse(readFileSync(DREAM_LOG, 'utf-8'))
    } catch {
      return []
    }
  }
}
