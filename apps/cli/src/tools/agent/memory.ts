import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ToolDefinition } from '../../shared/index.ts'
import { MemoryManager } from '../../core/memory/memory-manager'

const MEMORY_DIR = join(homedir(), '.mipham', 'memory')

/**
 * Format a memory file with frontmatter, compatible with MemoryManager.parseMemoryFile.
 */
function formatMemory(name: string, content: string): string {
  const desc = content.slice(0, 80).replace(/\n/g, ' ')
  return `---
name: ${name}
description: ${desc}
metadata:
  type: reference
  relevance: []
---

${content}
`
}

export const memoryTool: ToolDefinition = {
  name: 'Memory',
  description: 'Read, write, list, and search persistent memory files in ~/.mipham/memory/.',
  category: 'agent',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['read', 'write', 'list', 'search'],
        description: 'Action to perform',
      },
      name: { type: 'string', description: 'Memory file name (slug)' },
      content: { type: 'string', description: 'Content to write (for write action)' },
      query: { type: 'string', description: 'Search query (for search action)' },
    },
    required: ['action'],
  },
  async execute(params, _ctx) {
    const action = params.action as string
    mkdirSync(MEMORY_DIR, { recursive: true })

    if (action === 'list') {
      const files = readdirSync(MEMORY_DIR).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
      return { success: true, content: files.join('\n') || '(no memories)' }
    }

    // Semantic-less recall (keyword + wikilink + time-decay scoring) — lets the
    // AI retrieve relevant memories mid-conversation, not only at session start.
    if (action === 'search') {
      const query = (params.query as string)?.trim()
      if (!query) return { success: false, content: '', error: 'query is required' }
      const mm = new MemoryManager(MEMORY_DIR)
      mm.loadAll()
      const results = mm.recall(query, 10)
      if (results.length === 0) return { success: true, content: '(no matching memories)' }
      const lines = results.map((entry) => {
        const snippet = entry.content.replace(/\n+/g, ' ').trim().slice(0, 140)
        return `- ${entry.name}: ${entry.description || snippet}\n  ${snippet}`
      })
      return { success: true, content: lines.join('\n') }
    }

    const name = params.name as string
    if (!name) return { success: false, content: '', error: 'name is required' }
    const filePath = join(MEMORY_DIR, `${name}.md`)

    if (action === 'read') {
      if (!existsSync(filePath))
        return { success: false, content: '', error: `Memory "${name}" not found` }
      return { success: true, content: readFileSync(filePath, 'utf-8') }
    }

    if (action === 'write') {
      const body = formatMemory(name, params.content as string)
      writeFileSync(filePath, body, 'utf-8')
      return { success: true, content: `Memory "${name}" written` }
    }

    return { success: false, content: '', error: `Unknown action: ${action}` }
  },
}
