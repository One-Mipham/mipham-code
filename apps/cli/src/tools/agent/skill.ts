import type { ToolDefinition } from '@mipham/shared'

export const skillTool: ToolDefinition = {
  name: 'Skill',
  description: 'Execute a skill (SKILL.md or .mipham-skill.md) by name.',
  category: 'agent',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      skill: { type: 'string', description: 'Name of the skill to invoke' },
      args: { type: 'string', description: 'Optional arguments' },
    },
    required: ['skill'],
  },
  async execute(params, _ctx) {
    const skillName = params.skill as string
    return {
      success: true,
      content: `Skill "${skillName}" invoked. Full skills system in M3.`,
    }
  },
}
