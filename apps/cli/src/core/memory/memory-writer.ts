import type { MemoryManager } from './memory-manager'

const MEMORY_TRIGGERS = [
  {
    pattern: /(?:以后|今后|从现在开始|always|from now on|记住|remember)\s*[：:]\s*(.+)/i,
    type: 'user' as const,
  },
  {
    pattern: /(?:偏好|prefer|preference|习惯)\s*[：:]\s*(.+)/i,
    type: 'user' as const,
  },
  {
    pattern: /(?:项目|project)\s+(?:使用|uses?|采用)\s+(.+)/i,
    type: 'project' as const,
  },
  {
    pattern: /(?:决策|decided?|决定)\s*[：:]\s*(.+)/i,
    type: 'project' as const,
  },
]

/**
 * Analyze the user's message for memory-worthy content and persist it.
 */
export function analyzeForMemory(userMessage: string, memoryManager: MemoryManager): void {
  for (const trigger of MEMORY_TRIGGERS) {
    const match = userMessage.match(trigger.pattern)
    if (match?.[1]) {
      const content = match[1].trim()
      const name = `auto-${trigger.type}-${Date.now()}`
      const relevance = extractKeywords(content)

      memoryManager.write(name, content, {
        type: trigger.type === 'user' ? 'user' : 'project',
        relevance,
      })
    }
  }
}

function extractKeywords(text: string): string[] {
  // Simple keyword extraction: words > 3 chars, no stop words
  const stopWords = new Set([
    'this',
    'that',
    'with',
    'from',
    'have',
    'been',
    'were',
    'they',
    'will',
    'would',
    'could',
    'should',
    'about',
    'which',
    'their',
    '使用',
    '以后',
    '现在',
    '可以',
    '需要',
    '不要',
    '应该',
    '已经',
  ])
  return text
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stopWords.has(w.toLowerCase()))
    .slice(0, 5)
}
