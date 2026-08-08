// apps/cli/src/agent/agent-context.ts
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { ContextManager } from '../core/context'
import type { ToolDefinition } from '../shared/index.ts'
import type { AgentDefinition } from './types'
import { AgentExperience } from './agent-experience'
import { ExperienceRuleExtractor } from './experience-rules.js'

export interface AgentContextResult {
  context: ContextManager
  allowedTools: ToolDefinition[]
}

/**
 * Load agent memory files from the appropriate scope directory.
 * Returns combined content for injection into the system prompt.
 */
function loadAgentMemory(agentName: string, scope: 'user' | 'project' | 'local'): string {
  let memoryDir: string
  const home = homedir()

  switch (scope) {
    case 'user':
      memoryDir = join(home, '.mipham', 'agent-memory', agentName)
      break
    case 'project':
      memoryDir = join(process.cwd(), '.mipham', 'agent-memory', agentName)
      break
    case 'local':
      memoryDir = join(process.cwd(), '.mipham', 'agent-memory-local', agentName)
      break
  }

  // Load static memory files
  let staticMemory = ''
  if (existsSync(memoryDir)) {
    try {
      const files = readdirSync(memoryDir).filter((f) => f.endsWith('.md'))
      if (files.length > 0) {
        const contents: string[] = []
        for (const file of files.slice(0, 10)) {
          try {
            const content = readFileSync(join(memoryDir, file), 'utf-8').trim()
            if (content) contents.push(content)
          } catch {
            // skip unreadable
          }
        }
        if (contents.length > 0) {
          staticMemory = [`[Agent Memory — ${scope} scope]`, ...contents].join('\n\n')
        }
      }
    } catch {
      // memory dir unreadable
    }
  }

  // Load auto-accumulated experience rules (always from user scope)
  const exp = new AgentExperience(agentName)
  const extractor = new ExperienceRuleExtractor()
  const rules = extractor.prioritize(exp.getRules())

  let experienceMemory = ''
  if (rules.length > 0) {
    experienceMemory = extractor.formatForInjection(rules)
  }

  // Combine both memory sources
  if (staticMemory && experienceMemory) {
    return `${staticMemory}\n\n---\n\n${experienceMemory}`
  }
  if (experienceMemory) return experienceMemory
  return staticMemory
}

/**
 * Create an isolated context and tool set for a sub-agent.
 *
 * Tool scoping rules (first match wins):
 * 1. If `tools` is set, only those tools are allowed.
 * 2. If `disallowedTools` is set, those are removed from the full set.
 * 3. If neither is set, all tools are available.
 *
 * Agent memory: if agentDef.memory is set, loads memory files from the
 * appropriate scope and injects them into the system prompt.
 */
export function createAgentContext(
  agentDef: AgentDefinition,
  toolRegistry: Map<string, ToolDefinition>,
  contextWindow?: number,
): AgentContextResult {
  // Create isolated context
  const context = new ContextManager({
    maxTokens: contextWindow || 100_000,
    compactionThreshold: 0.85,
  })

  // Build system prompt with optional agent memory
  let systemPrompt = agentDef.systemPrompt
  if (agentDef.memory) {
    const memory = loadAgentMemory(agentDef.name, agentDef.memory)
    if (memory) {
      systemPrompt = `${systemPrompt}\n\n---\n\n${memory}`
    }
  }

  context.setSystemPrompt(systemPrompt)

  // Scope tools
  let allowedTools = Array.from(toolRegistry.values())

  if (agentDef.tools) {
    const allowSet = new Set(
      agentDef.tools
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    allowedTools = allowedTools.filter((t) => allowSet.has(t.name))
  }

  if (agentDef.disallowedTools) {
    const denySet = new Set(
      agentDef.disallowedTools
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    allowedTools = allowedTools.filter((t) => !denySet.has(t.name))
  }

  return { context, allowedTools }
}
