import type { SkillDefinition } from './shared/index.ts'

export interface StandardRuntimeContext {
  skill: SkillDefinition
  cwd: string
  sessionId: string
}

/**
 * Standard skill runtime — executes SKILL.md definitions.
 * Standard skills follow the open-source SKILL.md specification.
 */
export class StandardRuntime {
  private context: StandardRuntimeContext

  constructor(context: StandardRuntimeContext) {
    this.context = context
  }

  getSkill(): SkillDefinition {
    return this.context.skill
  }

  getPrompts(): Record<string, string> {
    return this.context.skill.prompts || {}
  }

  getPrompt(name: string): string | undefined {
    return this.context.skill.prompts?.[name]
  }

  getTools(): SkillDefinition['tools'] {
    return this.context.skill.tools || []
  }

  getHooks(): SkillDefinition['hooks'] {
    return this.context.skill.hooks || []
  }

  /**
   * Execute a named prompt from the skill.
   * Returns the prompt text with any variable substitution applied.
   */
  async executePrompt(
    name: string,
    variables?: Record<string, string>,
  ): Promise<string> {
    const prompt = this.getPrompt(name)
    if (!prompt) {
      throw new Error(`Prompt "${name}" not found in skill "${this.context.skill.name}"`)
    }

    let result = prompt
    if (variables) {
      for (const [key, value] of Object.entries(variables)) {
        result = result.replaceAll(`\${${key}}`, value)
      }
    }

    return result
  }
}
