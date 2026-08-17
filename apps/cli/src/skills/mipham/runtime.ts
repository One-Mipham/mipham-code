import type { SkillDefinition } from '../../shared/index.ts'

export interface MiphamRuntimeContext {
  skill: SkillDefinition
  cwd: string
  sessionId: string
  modelId: string
  providerId: string
}

/**
 * Mipham exclusive skill runtime.
 * Mipham skills use `.mipham-skill.md` extension and have access to
 * Mipham-specific features: model optimization, security features, etc.
 */
export class MiphamRuntime {
  private context: MiphamRuntimeContext

  constructor(context: MiphamRuntimeContext) {
    this.context = context
  }

  getSkill(): SkillDefinition {
    return this.context.skill
  }

  getPrompts(): Record<string, string> {
    return this.context.skill.prompts || {}
  }

  getTools(): SkillDefinition['tools'] {
    return this.context.skill.tools || []
  }

  getHooks(): SkillDefinition['hooks'] {
    return this.context.skill.hooks || []
  }

  /**
   * Execute a named prompt with Mipham-specific context.
   */
  async executePrompt(name: string, variables?: Record<string, string>): Promise<string> {
    const prompt = this.context.skill.prompts?.[name]
    if (!prompt) {
      throw new Error(`Prompt "${name}" not found in skill "${this.context.skill.name}"`)
    }

    let result = prompt
    const allVars: Record<string, string> = {
      provider: this.context.providerId,
      model: this.context.modelId,
      session: this.context.sessionId,
      cwd: this.context.cwd,
      ...variables,
    }

    // Single-pass substitution: replacement values are NOT re-scanned for more
    // template markers, so a variable containing `${key}` can't be re-expanded
    // into another variable's value.
    result = result.replace(/\$\{([^}]+)\}/g, (match, key: string) =>
      Object.prototype.hasOwnProperty.call(allVars, key) ? allVars[key]! : match,
    )

    return result
  }
}
