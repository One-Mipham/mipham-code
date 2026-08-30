import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  renameSync,
  existsSync,
  statSync,
} from 'node:fs'
import { join, extname, basename } from 'node:path'
import { similarities } from './tfidf'

export interface MemoryMetadata {
  type: 'user' | 'feedback' | 'project' | 'reference'
  relevance: string[]
  why?: string
  howToApply?: string
}

export interface MemoryEntry {
  name: string
  description: string
  metadata: MemoryMetadata
  content: string
  filePath: string
  updatedAt: Date
}

const INDEX_FILE = 'MEMORY.md'
const LINKS_FILE = 'links.json'
const RECALL_STATS_FILE = 'recall-stats.json'
const AUTO_PREFIX = 'auto-'
/** 「从没被召回 + 过期」的 auto-* 记忆归档阈值（60 天）。 */
const GC_STALE_MS = 60 * 24 * 60 * 60 * 1000
/** 会话记忆合并的 TF-IDF 余弦阈值（> 此值聚成一簇）。 */
const CONSOLIDATE_THRESHOLD = 0.5
/** 写时去重的 TF-IDF 余弦阈值（> 此值视为近重复，合并而非新增）。高于合并阈值，只拦近重复。 */
const DEDUP_THRESHOLD = 0.65

/** 确定性 hash（无 Date.now / Math.random，同输入同输出 → 幂等 lesson 名）。 */
function stableHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

/** 写时去重：找同 type 且内容近重复（余弦 > 阈值）的现有记忆。纯函数便于测。 */
export function findNearDuplicate(
  candidates: ReadonlyArray<MemoryEntry>,
  content: string,
  type: string,
): MemoryEntry | null {
  for (const entry of candidates) {
    if (entry.metadata.type !== type) continue
    // auto-*（会话记忆，归合并管）与 lesson-*（合并产物）不做写时去重，
    // 否则合并阶段 write 的 lesson 会被尚存的 auto-* 吸收掉。
    if (entry.name.startsWith(AUTO_PREFIX) || entry.name.startsWith('lesson-')) continue
    const sim = similarities(content, [entry.content])[0] ?? 0
    if (sim > DEDUP_THRESHOLD) return entry
  }
  return null
}

export class MemoryManager {
  private memories = new Map<string, MemoryEntry>()
  private linkGraph: Map<string, Set<string>> = new Map()
  private recallStats = new Map<string, { recallCount: number; lastRecalledAt: string }>()
  private contextMaxTokens = 200_000

  constructor(private memoryDir: string) {
    mkdirSync(memoryDir, { recursive: true })
  }

  /** Set the model's context window size for adaptive memory budget. */
  setContextWindow(tokens: number): void {
    this.contextMaxTokens = tokens
  }

  loadAll(): void {
    this.memories.clear()
    this.linkGraph.clear()
    this.recallStats.clear()
    if (!existsSync(this.memoryDir)) return

    let entries: string[] = []
    try {
      entries = readdirSync(this.memoryDir)
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry === INDEX_FILE || entry === LINKS_FILE || extname(entry) !== '.md') continue
      const filePath = join(this.memoryDir, entry)
      try {
        const raw = readFileSync(filePath, 'utf-8')
        const parsed = this.parseMemoryFile(raw, filePath)
        if (parsed) {
          this.memories.set(parsed.name, parsed)
        }
      } catch {
        // skip unparseable
      }
    }

    // Try cached link graph first, fall back to rebuild
    if (!this.loadLinkGraph()) {
      this.rebuildLinkGraph()
    }
    this.loadRecallStats()
  }

  write(name: string, content: string, metadata: MemoryMetadata): void {
    // 同名 update（replace 语义）
    const existing = this.memories.get(name)
    if (existing) {
      this.updateEntry(existing, content, metadata)
      return
    }

    // 写时去重：不同名但同 type + 内容近重复 → 合并进现有（union relevance），不新增（治「越存越乱」）。
    const nearDup = findNearDuplicate([...this.memories.values()], content, metadata.type)
    if (nearDup) {
      const mergedMetadata: MemoryMetadata = {
        ...metadata,
        relevance: [...new Set([...nearDup.metadata.relevance, ...metadata.relevance])],
      }
      this.updateEntry(nearDup, content, mergedMetadata)
      return
    }

    // 新建
    const fileName = `${name}.md`
    const filePath = join(this.memoryDir, fileName)
    const formattedBody = this.formatMemoryBody(metadata, content)
    const body = this.formatMemoryFile(name, metadata, content)
    writeFileSync(filePath, body, 'utf-8')

    const entry: MemoryEntry = {
      name,
      description: metadata.relevance.join(', '),
      metadata,
      content: formattedBody,
      filePath,
      updatedAt: new Date(),
    }

    this.memories.set(name, entry)
    this.updateWikilinks(name, content)
    this.updateIndex()
  }

  /** 更新一条现有记忆（内容/元数据/文件/索引）。同名 update 与近重复合并共用。 */
  private updateEntry(entry: MemoryEntry, content: string, metadata: MemoryMetadata): void {
    entry.content = this.formatMemoryBody(metadata, content)
    entry.metadata = metadata
    entry.description = metadata.relevance.join(', ')
    entry.updatedAt = new Date()
    const body = this.formatMemoryFile(entry.name, metadata, content)
    writeFileSync(entry.filePath, body, 'utf-8')
    this.updateWikilinks(entry.name, content)
    this.updateIndex()
  }

  recall(context: string, limit: number = 10, grounding?: string): MemoryEntry[] {
    // 状态接地（治「前存后忘」）：把「当前还剩什么没做」拼进 query，让召回绑定到
    // 已验证的当前状态，而不是只绑定到「刚说了什么」。历史越长，旧但相关的记忆越不被埋。
    const query = grounding ? `${grounding}\n${context}` : context
    const contextLower = query.toLowerCase()
    const entries = [...this.memories.values()]
    // TF-IDF cosine similarity (CJK-bigram aware) replaces the old word-overlap.
    const sims = similarities(
      query,
      entries.map((e) => e.content),
    )
    const scored: Array<{ entry: MemoryEntry; score: number }> = []
    const seen = new Set<string>()

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!
      let score = sims[i]! * 10
      // Match against relevance tags (strong curated signal)
      for (const tag of entry.metadata.relevance) {
        if (contextLower.includes(tag.toLowerCase())) score += 3
      }
      if (score > 0) {
        scored.push({ entry, score })
        seen.add(entry.name)
      }
    }

    // Boost wikilink-connected memories with lower weight
    for (const scoredItem of [...scored]) {
      const linkedNames = this.linkGraph.get(scoredItem.entry.name)
      if (!linkedNames) continue
      for (const linkedName of linkedNames) {
        if (seen.has(linkedName)) continue
        const linkedEntry = this.memories.get(linkedName)
        if (linkedEntry) {
          scored.push({ entry: linkedEntry, score: 1 })
          seen.add(linkedName)
        }
      }
    }

    // Apply time decay: memories older than 30 days get 50% weight
    const now = Date.now()
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
    for (const item of scored) {
      const age = now - item.entry.updatedAt.getTime()
      if (age > THIRTY_DAYS_MS) {
        item.score *= 0.5
      }
    }

    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, limit).map((s) => s.entry)
    this.recordRecall(top.map((e) => e.name))
    return top
  }

  getLinkedMemories(name: string): MemoryEntry[] {
    const targets = this.linkGraph.get(name)
    if (!targets || targets.size === 0) return []
    const results: MemoryEntry[] = []
    for (const target of targets) {
      const entry = this.memories.get(target)
      if (entry) results.push(entry)
    }
    return results
  }

  delete(name: string): void {
    const entry = this.memories.get(name)
    if (!entry) return

    try {
      unlinkSync(entry.filePath)
    } catch {
      // file may already be gone
    }
    this.memories.delete(name)
    this.linkGraph.delete(name)
    this.saveLinkGraph()
    this.updateIndex()
  }

  /**
   * 淘汰：归档「从没被召回 + 过期」的 auto-* 记忆；手写记忆只报告不自动动。
   * auto-* 是 `distillFromSession` 的产物（每次会话各写一条），是可安全淘汰的膨胀源；
   * 用户手写进 candidates 待人工确认。
   */
  gc(): { archived: string[]; candidates: string[] } {
    const archived: string[] = []
    const candidates: string[] = []
    const now = Date.now()

    for (const [name, entry] of this.memories) {
      const recallCount = this.recallStats.get(name)?.recallCount ?? 0
      const age = now - entry.updatedAt.getTime()
      if (recallCount > 0 || age <= GC_STALE_MS) continue

      if (name.startsWith(AUTO_PREFIX)) {
        this.archive(name, entry)
        archived.push(name)
      } else {
        candidates.push(name)
      }
    }

    return { archived, candidates }
  }

  /** 把一条记忆移到 archive/ 子目录并从内存/索引移除。loadAll 不递归，故天然不再加载。 */
  private archive(name: string, entry: MemoryEntry): void {
    try {
      mkdirSync(join(this.memoryDir, 'archive'), { recursive: true })
      renameSync(entry.filePath, join(this.memoryDir, 'archive', basename(entry.filePath)))
    } catch {
      // best-effort：rename 失败（文件已不在等）也不阻塞淘汰
    }
    this.memories.delete(name)
    this.linkGraph.delete(name)
    this.recallStats.delete(name)
    this.saveLinkGraph()
    this.saveRecallStats()
    this.updateIndex()
  }

  /**
   * 会话记忆合并：把 auto-* 聚簇成持久化 lesson-*（重叠的合并、去重，删原 auto-*）。
   * 手动触发（/memory consolidate），不后台自动跑。返回创建的 lesson 数与删除的 auto-* 数。
   */
  consolidateAutoMemories(): { merged: number; removed: number } {
    const autoEntries = [...this.memories.values()].filter((e) => e.name.startsWith(AUTO_PREFIX))
    if (autoEntries.length === 0) return { merged: 0, removed: 0 }

    // 贪心聚簇：与簇代表（首条）余弦 > 阈值则归入，否则新开一簇。
    const clusters: MemoryEntry[][] = []
    for (const entry of autoEntries) {
      let placed = false
      for (const cluster of clusters) {
        const sim = similarities(cluster[0]!.content, [entry.content])[0] ?? 0
        if (sim > CONSOLIDATE_THRESHOLD) {
          cluster.push(entry)
          placed = true
          break
        }
      }
      if (!placed) clusters.push([entry])
    }

    let merged = 0
    let removed = 0
    for (const cluster of clusters) {
      const name = `lesson-${stableHash(
        cluster
          .map((e) => e.name)
          .sort()
          .join('|'),
      )}`
      const content = cluster.map((e) => e.content).join('\n\n')
      const relevance = [...new Set(cluster.flatMap((e) => e.metadata.relevance))].slice(0, 10)
      this.write(name, content, { type: 'feedback', relevance })
      merged++
      for (const member of cluster) {
        this.delete(member.name)
        removed++
      }
    }

    return { merged, removed }
  }

  buildSystemReminder(context: string, maxTokens?: number, grounding?: string): string {
    // Adaptive budget: 5% of context window, min 5000, max 75000
    const effectiveMaxTokens =
      maxTokens ?? Math.max(5000, Math.min(75000, Math.floor(this.contextMaxTokens * 0.05)))
    const relevant = this.recall(context, 10, grounding)
    if (relevant.length === 0) return ''

    const lines: string[] = ['<system-reminder>', 'Relevant memories from previous sessions:']

    let tokenBudget = 50 // opening tags
    for (const entry of relevant) {
      const line = `- ${entry.name}: ${entry.content.slice(0, 200)}`
      const lineTokens = Math.ceil(line.length / 4)
      if (tokenBudget + lineTokens > effectiveMaxTokens) break
      lines.push(line)
      tokenBudget += lineTokens
    }

    lines.push('</system-reminder>')
    return lines.join('\n')
  }

  distillFromSession(summary: string, sessionId: string): MemoryEntry[] {
    const results: MemoryEntry[] = []
    // Split on bullet points (both - and *)
    const bullets = summary.split(/\n\s*[-*]\s+/).filter((b) => b.trim().length > 20)

    for (const bullet of bullets) {
      // Extract Why / How to apply if present
      const whyMatch = bullet.match(/\*\*Why:\*\*\s*(.+?)(?:\s*\*\*How to apply:|$)/)
      const howMatch = bullet.match(/\*\*How to apply:\*\*\s*(.+)$/)

      // Strip Why/How markers from content — they're passed as metadata fields
      // and formatMemoryBody appends them, so leaving them in duplicates the text
      const stripped = bullet
        .trim()
        .replace(/\s*\*\*Why:\*\*.*/, '')
        .replace(/\s*\*\*How to apply:\*\*.*/, '')
        .trim()
      const slug = `auto-${sessionId}-${results.length}`

      this.write(slug, stripped, {
        type: 'feedback',
        relevance: this.extractKeywords(stripped),
        why: whyMatch?.[1]?.trim(),
        howToApply: howMatch?.[1]?.trim(),
      })

      const entry = this.memories.get(slug)
      if (entry) results.push(entry)
    }
    return results
  }

  private extractKeywords(content: string): string[] {
    const words = content
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
    const stopWords = new Set([
      'the',
      'a',
      'an',
      'is',
      'are',
      'was',
      'were',
      'in',
      'on',
      'at',
      'to',
      'for',
      'of',
      'and',
      'or',
      'but',
      'not',
      'this',
      'that',
      'with',
      'from',
      'by',
      'as',
      'be',
      'has',
      'have',
      'it',
      'its',
    ])
    const seen = new Set<string>()
    const result: string[] = []
    for (const word of words) {
      if (word.length > 3 && !stopWords.has(word) && !seen.has(word)) {
        seen.add(word)
        result.push(word)
      }
    }
    return result.slice(0, 10)
  }

  private updateIndex(): void {
    const lines: string[] = [
      '# Memory Index',
      '',
      `_Last updated: ${new Date().toISOString()}_`,
      '',
    ]

    for (const entry of this.memories.values()) {
      lines.push(`- [${entry.name}](${entry.name}.md) — ${entry.description}`)
    }

    writeFileSync(join(this.memoryDir, INDEX_FILE), lines.join('\n') + '\n', 'utf-8')
  }

  private extractWikilinks(content: string): string[] {
    const re = /\[\[([^\]]+)\]\]/g
    const links: string[] = []
    let match: RegExpExecArray | null
    while ((match = re.exec(content)) !== null) {
      if (links.length >= 10) break // hard cap
      links.push(match[1]!)
    }
    return links
  }

  private updateWikilinks(name: string, content: string): void {
    // Clear stale outbound links for this memory
    this.linkGraph.delete(name)

    // Extract outbound wikilinks from content
    const links = this.extractWikilinks(content)
    if (links.length > 0) {
      this.linkGraph.set(name, new Set(links))
    }

    // Update reverse links: other memories that link to this one
    for (const [otherName, otherEntry] of this.memories) {
      if (otherName === name) continue
      const otherLinks = this.extractWikilinks(otherEntry.content)
      if (otherLinks.includes(name)) {
        const otherSet = this.linkGraph.get(otherName) || new Set()
        otherSet.add(name)
        this.linkGraph.set(otherName, otherSet)
      }
    }

    this.saveLinkGraph()
  }

  private rebuildLinkGraph(): void {
    this.linkGraph.clear()
    for (const [name, entry] of this.memories) {
      const links = this.extractWikilinks(entry.content)
      if (links.length > 0) {
        this.linkGraph.set(name, new Set(links))
      }
    }
    // Compute reverse links: other memories that link to each memory
    for (const [name, entry] of this.memories) {
      const linked = this.extractWikilinks(entry.content)
      for (const target of linked) {
        if (target === name) continue
        const targetSet = this.linkGraph.get(target)
        if (targetSet) {
          targetSet.add(name)
        } else {
          this.linkGraph.set(target, new Set([name]))
        }
      }
    }
  }

  private saveLinkGraph(): void {
    const obj: Record<string, string[]> = {}
    for (const [k, v] of this.linkGraph) {
      obj[k] = Array.from(v)
    }
    try {
      writeFileSync(join(this.memoryDir, LINKS_FILE), JSON.stringify(obj, null, 2), 'utf-8')
    } catch {
      // best-effort — never block on cache write
    }
  }

  private loadLinkGraph(): boolean {
    const path = join(this.memoryDir, LINKS_FILE)
    if (!existsSync(path)) return false
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8'))
      for (const [k, v] of Object.entries(raw)) {
        this.linkGraph.set(k, new Set(v as string[]))
      }
      return this.linkGraph.size > 0
    } catch {
      // corrupt file — rebuild from source
      return false
    }
  }

  /** 记录召回（质量信号）：被召回的条目 recallCount+1。写入 sidecar，不改记忆文件本身。 */
  private recordRecall(names: string[]): void {
    if (names.length === 0) return
    const now = new Date().toISOString()
    for (const name of names) {
      const stats = this.recallStats.get(name)
      if (stats) {
        stats.recallCount++
        stats.lastRecalledAt = now
      } else {
        this.recallStats.set(name, { recallCount: 1, lastRecalledAt: now })
      }
    }
    this.saveRecallStats()
  }

  private saveRecallStats(): void {
    const obj: Record<string, { recallCount: number; lastRecalledAt: string }> = {}
    for (const [k, v] of this.recallStats) obj[k] = v
    try {
      writeFileSync(join(this.memoryDir, RECALL_STATS_FILE), JSON.stringify(obj, null, 2), 'utf-8')
    } catch {
      // best-effort — never block on stats write
    }
  }

  private loadRecallStats(): void {
    const path = join(this.memoryDir, RECALL_STATS_FILE)
    if (!existsSync(path)) return
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8'))
      for (const [k, v] of Object.entries(raw)) {
        const rec = v as { recallCount?: number; lastRecalledAt?: string }
        this.recallStats.set(k, {
          recallCount: rec.recallCount ?? 0,
          lastRecalledAt: rec.lastRecalledAt ?? '',
        })
      }
    } catch {
      // corrupt file — ignore
    }
  }

  private parseMemoryFile(raw: string, filePath: string): MemoryEntry | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!match) return null

    const frontmatter = match[1] || ''
    const content = (match[2] || '').trim()

    // Parse simple YAML-like frontmatter
    const nameMatch = frontmatter.match(/name:\s*(\S+)/)
    const descMatch = frontmatter.match(/description:\s*(.+)/)
    const typeMatch = frontmatter.match(/type:\s*(\S+)/)
    const relevanceMatch = frontmatter.match(/relevance:\s*\[(.+)\]/)

    if (!nameMatch) return null

    return {
      name: nameMatch[1]!,
      description: descMatch?.[1]?.trim() || '',
      metadata: {
        type: (typeMatch?.[1] as MemoryMetadata['type']) || 'reference',
        relevance: relevanceMatch?.[1]?.split(',').map((s) => s.trim()) || [],
      },
      content,
      filePath,
      updatedAt: statSync(filePath).mtime,
    }
  }

  private formatMemoryFile(name: string, metadata: MemoryMetadata, content: string): string {
    const body = this.formatMemoryBody(metadata, content)
    return `---
name: ${name}
description: ${metadata.relevance.join(', ')}
metadata:
  type: ${metadata.type}
  relevance: [${metadata.relevance.join(', ')}]
---

${body}
`
  }

  private formatMemoryBody(metadata: MemoryMetadata, content: string): string {
    let body = content

    if (metadata.why) {
      body += `\n\n**Why:** ${metadata.why}`
    }
    if (metadata.howToApply) {
      body += `\n\n**How to apply:** ${metadata.howToApply}`
    }

    return body
  }
}
