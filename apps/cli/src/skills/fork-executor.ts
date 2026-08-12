import { SubAgent } from '../agent/sub-agent'
import type { ProviderRegistry } from '../providers/registry'
import type { ToolDefinition, SkillDefinition } from '../shared/index.ts'
import type { AgentDefinition } from '../agent/types'
import type { PermissionSystem } from '../core/permission'
import { sanitizeSkillDescription } from './sanitizer.js'

/**
 * Execute a skill in an isolated subagent context (context: fork).
 *
 * The skill's markdown body becomes the subagent's system prompt.
 * The skill's allowed-tools become the subagent's tool whitelist.
 * Results are returned to the AI as internal context (not shown directly to user).
 *
 * Safety: skill description is sanitized before injection into subagent prompt.
 */
export async function executeForkedSkill(
  skill: SkillDefinition,
  args: string,
  registry: ProviderRegistry,
  toolRegistry: Map<string, ToolDefinition>,
  permissionSystem?: PermissionSystem,
): Promise<string> {
  const agentDef: AgentDefinition = {
    name: `skill:${skill.name}`,
    description: sanitizeSkillDescription(skill.description, skill.type),
    systemPrompt: buildSkillSystemPrompt(skill),
    tools: skill.allowedTools?.join(', '),
    model: skill.model || 'inherit',
    permissionMode: 'inherit',
    background: false,
    source: 'builtin',
  }

  const sub = new SubAgent(registry, toolRegistry, permissionSystem)
  const prompt = args
    ? `Execute the "${skill.name}" skill with arguments: ${args}`
    : `Execute the "${skill.name}" skill.`

  return sub.execute(prompt, `skill:${skill.name}`, { agentDef })
}

function buildSkillSystemPrompt(skill: SkillDefinition): string {
  const safeDescription = sanitizeSkillDescription(skill.description, skill.type)
  return `You are executing the "${skill.name}" skill (v${skill.version}).\n\n${safeDescription}\n\nFollow the skill instructions precisely and return results.`
}
