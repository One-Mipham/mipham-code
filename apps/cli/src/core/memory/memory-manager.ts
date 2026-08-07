import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from 'node:fs'
import { join, extname } from 'node:path'

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

export class MemoryManager {
  private memories = new Map<string, MemoryEntry>()
  private linkGraph: Map<string, Set<string>> = new Map()
  private readonly LINKS_FILE = 'links.json'

  constructor(private memoryDir: string) {
    mkdirSync(memoryDir, { recursive: true })
  }

  loadAll(): void {
    this.memories.clear()
    this.linkGraph.clear()
    if (!existsSync(this.memoryDir)) return

    let entries: string[] = []
    try {
      entries = readdirSync(this.memoryDir)
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry === INDEX_FILE || extname(entry) !== '.md') continue
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
    this.loadLinkGraph()
    this.rebuildLinkGraph()
  }

  write(name: string, content: string, metadata: MemoryMetadata): void {
    // Dedup: same name = update, don't create duplicate
    const formattedBody = this.formatMemoryBody(metadata, content)
    const existing = this.memories.get(name)
    if (existing) {
      existing.content = formattedBody
      existing.metadata = metadata
      existing.description = metadata.relevance.join(', ')
      existing.updatedAt = new Date()
      this.memories.set(name, existing)
      const body = this.formatMemoryFile(name, metadata, content)
      writeFileSync(existing.filePath, body, 'utf-8')
      this.updateWikilinks(name, content)
      this.updateIndex()
      return
    }

    const fileName = `${name}.md`
    const filePath = join(this.memoryDir, fileName)

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

  recall(context: string, limit: number = 10): MemoryEntry[] {
    const contextLower = context.toLowerCase()
    const scored: Array<{ entry: MemoryEntry; score: number }> = []
    const seen = new Set<string>()

    for (const entry of this.memories.values()) {
      let score = 0
      // Match against relevance tags
      for (const tag of entry.metadata.relevance) {
        if (contextLower.includes(tag.toLowerCase())) score += 3
      }
      // Match against content keywords
      const contentWords = entry.content.toLowerCase().split(/\s+/)
      const contextWords = new Set(contextLower.split(/\s+/))
      for (const word of contentWords) {
        if (contextWords.has(word) && word.length > 3) score += 1
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
    return scored.slice(0, limit).map((s) => s.entry)
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
    this.updateIndex()
  }

  buildSystemReminder(context: string, maxTokens: number = 5000): string {
    const relevant = this.recall(context, 10)
    if (relevant.length === 0) return ''

    const lines: string[] = ['<system-reminder>', 'Relevant memories from previous sessions:']

    let tokenBudget = 50 // opening tags
    for (const entry of relevant) {
      const line = `- ${entry.name}: ${entry.content.slice(0, 200)}`
      const lineTokens = Math.ceil(line.length / 4)
      if (tokenBudget + lineTokens > maxTokens) break
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

      const content = bullet.trim()
      const slug = `auto-${sessionId}-${results.length}`

      this.write(slug, content, {
        type: 'feedback',
        relevance: this.extractKeywords(content),
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
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at',
      'to', 'for', 'of', 'and', 'or', 'but', 'not', 'this', 'that',
      'with', 'from', 'by', 'as', 'be', 'has', 'have', 'it', 'its',
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
  }

  private saveLinkGraph(): void {
    const obj: Record<string, string[]> = {}
    for (const [k, v] of this.linkGraph) {
      obj[k] = Array.from(v)
    }
    writeFileSync(join(this.memoryDir, this.LINKS_FILE), JSON.stringify(obj, null, 2), 'utf-8')
  }

  private loadLinkGraph(): void {
    const path = join(this.memoryDir, this.LINKS_FILE)
    if (!existsSync(path)) return
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8'))
      for (const [k, v] of Object.entries(raw)) {
        this.linkGraph.set(k, new Set(v as string[]))
      }
    } catch {
      // corrupt file, start fresh
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
      updatedAt: new Date(),
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
