// apps/cli/src/agent/agent-context.ts
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ContextManager } from '../core/context'
import { mcpServerPrefix } from '../core/permission-rules'
import type { ToolDefinition } from '../shared/index.ts'
import type { AgentDefinition } from './types'
import type { CrsiConfig } from '../shared/index.ts'
import { AgentExperience } from './agent-experience'
import { ExperienceRuleExtractor } from './experience-rules.js'
import { miphamHome } from '../core/paths.ts'
import { MIPHAM_DIR } from '../shared/constants.ts'
import { sanitizeSkillBody } from '../skills/sanitizer'

export interface AgentContextResult {
  context: ContextManager
  allowedTools: ToolDefinition[]
  /**
   * 组装好的系统提示（**含** agent memory）。
   *
   * 必须由这里交出去、而不是让调用方自己再拼一份：memory 的拼接规则只此一处，调用方
   * 拿不到它就等于重新推导一遍（漏掉的那一遍正是缺陷本身 —— 请求里从来没有记忆）。
   */
  systemPrompt: string
}

/**
 * Load agent memory files from the appropriate scope directory.
 * Returns combined content for injection into the system prompt.
 *
 * @param crsiRuleInjection — when false, skip experience rule extraction (CRSI feature flag).
 */
function loadAgentMemory(
  agentName: string,
  scope: 'user' | 'project' | 'local',
  crsiRuleInjection = true,
): string {
  let memoryDir: string

  switch (scope) {
    case 'user':
      memoryDir = miphamHome('agent-memory', agentName)
      break
    case 'project':
      memoryDir = join(process.cwd(), MIPHAM_DIR, 'agent-memory', agentName)
      break
    case 'local':
      memoryDir = join(process.cwd(), MIPHAM_DIR, 'agent-memory-local', agentName)
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
  // Gated by crsi.ruleInjection feature flag
  let experienceMemory = ''
  if (crsiRuleInjection) {
    const exp = new AgentExperience(agentName)
    const extractor = new ExperienceRuleExtractor()
    const rules = extractor.prioritize(exp.getRules())

    if (rules.length > 0) {
      experienceMemory = extractor.formatForInjection(rules)
    }
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
/** The slice of `SkillsLoader` this module needs (kept structural so the agent
 *  layer does not import the skills loader just for a type). */
export interface DeclaredSkillLookup {
  get(name: string): { name: string; description: string; body?: string } | undefined
}

/**
 * Render the skills an agent declared in its frontmatter into its system prompt.
 *
 * `skills:` was parsed into `AgentDefinition` but read by nobody, so an agent
 * that declared skills ran without their instructions — the field was
 * advertised and never applied. Unknown names are reported once (to stderr,
 * like the loader's other warnings) rather than silently dropped: a typo and a
 * missing file are the same thing to the agent, and both mean the same thing
 * to the user.
 */
function loadDeclaredSkills(
  agentName: string,
  names: string[],
  lookup: DeclaredSkillLookup | undefined,
): string {
  if (!lookup) {
    process.stderr.write(
      `⚠️  Agent "${agentName}": declares skills (${names.join(', ')}) but no skills loader is available — skipped.\n`,
    )
    return ''
  }
  const blocks: string[] = []
  for (const name of names) {
    const skill = lookup.get(name)
    if (!skill) {
      process.stderr.write(
        `⚠️  Agent "${agentName}": declared skill "${name}" not found — skipped.\n`,
      )
      continue
    }
    const body = skill.body ? sanitizeSkillBody(skill.body).text : ''
    blocks.push([`## ${skill.name}`, skill.description, body].filter(Boolean).join('\n'))
  }
  if (blocks.length === 0) return ''
  return ['[Agent Skills — declared in frontmatter]', ...blocks].join('\n\n')
}

export function createAgentContext(
  agentDef: AgentDefinition,
  toolRegistry: Map<string, ToolDefinition>,
  contextWindow?: number,
  crsiConfig?: Partial<CrsiConfig>,
  skills?: DeclaredSkillLookup,
): AgentContextResult {
  // Create isolated context, sized to the resolved model's window when known.
  // Passing contextWindow (not just maxTokens) enables adaptive thresholds.
  const context = new ContextManager({
    maxTokens: contextWindow || 100_000,
    compactionThreshold: 0.85,
    contextWindow,
  })

  // Build system prompt with optional agent memory
  let systemPrompt = agentDef.systemPrompt
  if (agentDef.memory) {
    const ruleInjection = crsiConfig?.ruleInjection !== false
    const memory = loadAgentMemory(agentDef.name, agentDef.memory, ruleInjection)
    if (memory) {
      systemPrompt = `${systemPrompt}\n\n---\n\n${memory}`
    }
  }
  if (agentDef.skills?.length) {
    const declared = loadDeclaredSkills(agentDef.name, agentDef.skills, skills)
    if (declared) systemPrompt = `${systemPrompt}\n\n---\n\n${declared}`
  }

  context.setSystemPrompt(systemPrompt)

  return { context, allowedTools: selectAgentTools(agentDef, toolRegistry), systemPrompt }
}

/**
 * The tools an agent definition is allowed to use, read from the **current**
 * registry.
 *
 * Exported because the answer is not a one-time fact: MCP servers connect in the
 * background, so a sub-agent that started early would otherwise be pinned to the
 * tool table of the moment it started, and a server that finished connecting a
 * second later could never be used by it — even though calling the tool would
 * have worked (`sub-agent.ts` resolves each call against the live registry).
 *
 * `warnOnEmpty` is for the repeat callers: the warning is worth printing once
 * per run, not once per turn.
 */
export function selectAgentTools(
  agentDef: AgentDefinition,
  toolRegistry: Map<string, ToolDefinition>,
  warnOnEmpty = true,
): ToolDefinition[] {
  let allowedTools = Array.from(toolRegistry.values())

  if (agentDef.tools) {
    const allowRules = agentDef.tools
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    // `mcp__server` / `mcp__server__*` mean "every tool on that server", and
    // `mcp__*` means every MCP tool. Without expansion these exact-match
    // nothing, so an agent that asks for a whole server silently receives no
    // tools at all.
    const serverPrefix = (r: string): string | null =>
      r === 'mcp__*' ? 'mcp__' : mcpServerPrefix(r)
    const serverPrefixes = allowRules.map(serverPrefix).filter((p): p is string => p !== null)
    const allowSet = new Set(allowRules.filter((r) => serverPrefix(r) === null))
    allowedTools = allowedTools.filter(
      (t) => allowSet.has(t.name) || serverPrefixes.some((p) => t.name.startsWith(p)),
    )
    if (allowedTools.length === 0 && warnOnEmpty) {
      process.stderr.write(
        `⚠️  Agent "${agentDef.name}": tools list (${allowRules.join(', ')}) matched no registered tool — the agent will run without tools.\n`,
      )
    }
  }

  if (agentDef.disallowedTools) {
    // The deny side needs the same server expansion as the allow side. With
    // exact matching, `disallowedTools: mcp__server` denied nothing — the agent
    // kept every tool on the server it was told to avoid (CC 2.1.178-021).
    const denyRules = agentDef.disallowedTools
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const denyPrefix = (r: string): string | null => (r === 'mcp__*' ? 'mcp__' : mcpServerPrefix(r))
    const denySet = new Set(denyRules.filter((r) => denyPrefix(r) === null))
    const denyPrefixes = denyRules.map(denyPrefix).filter((p): p is string => p !== null)
    allowedTools = allowedTools.filter(
      (t) => !denySet.has(t.name) && !denyPrefixes.some((p) => t.name.startsWith(p)),
    )
  }

  return allowedTools
}
