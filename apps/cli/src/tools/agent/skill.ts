import type { ToolDefinition, SkillDefinition, ToolResult } from '../../shared/index.ts'
import { executeForkedSkill } from '../../skills/fork-executor'

export const skillTool: ToolDefinition = {
  name: 'Skill',
  description:
    'Execute a skill (.SKILL.md or .mipham-skill.md) by name. Skills extend AI capabilities with specialized instructions.',
  category: 'agent',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      skill: { type: 'string', description: 'Name of the skill to invoke' },
      args: { type: 'string', description: 'Optional arguments for the skill' },
    },
    required: ['skill'],
  },
  async execute(params, ctx) {
    const skillName = params.skill as string
    const args = (params.args as string) || ''

    // Try to load the skill via SkillsLoader if available
    const loader = ctx.skillsLoader
    if (loader) {
      const skill = loader.get(skillName)
      if (!skill) {
        const available = loader
          .list()
          .map((s) => `  • ${s.name} (${s.type})`)
          .join('\n')
        return {
          success: false,
          content: '',
          error: `Skill "${skillName}" not found.\n\nAvailable skills (${loader.list().length}):\n${available}\n\nUse /skills to browse, or create a .SKILL.md file in .mipham/skills/.`,
        }
      }

      // Check if skill has context: fork — execute in isolated subagent
      if (skill.context === 'fork') {
        const registry = ctx.registry
        if (!registry) {
          return {
            success: false,
            content: '',
            error: 'Provider registry not available for forked skill execution.',
          }
        }

        try {
          const result = await executeForkedSkill(
            skill,
            args,
            registry,
            ctx.toolRegistry || new Map(),
          )
          // Return to AI as internal context
          return { success: true, content: `[Forked skill "${skillName}" result]:\n${result}` }
        } catch (err) {
          return {
            success: false,
            content: '',
            error: `Forked skill execution failed: ${String(err)}`,
          }
        }
      }

      // Standard inline execution — return metadata for AI to follow
      const lines: string[] = [
        `── Skill Invoked: ${skill.name} ──`,
        `Type: ${skill.type} | Version: ${skill.version}`,
        skill.description ? `Description: ${skill.description}` : '',
        args ? `Arguments: ${args}` : '',
        '',
        'The AI should now follow the instructions from this skill.',
        'Skill content has been loaded into context.',
      ].filter(Boolean)

      return { success: true, content: lines.join('\n') }
    }

    // Fallback: no SkillsLoader in context
    return {
      success: false,
      content: '',
      error: `SkillsLoader not available. The skill "${skillName}" cannot be loaded.\n\nSkills are loaded from:\n  • skills/standard/*.SKILL.md (built-in)\n  • skills/mipham/*.mipham-skill.md (Mipham exclusive)\n  • .mipham/skills/ (project custom)`,
    }
  },
}
