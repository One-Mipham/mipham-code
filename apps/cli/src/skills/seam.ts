import type { Context, Disposer } from '../vajra'
import type { SkillDefinition } from '../shared'

/** 技能加载缝的 capability —— 读能力。换 provider = 换技能来源，engine 零 fork 跟随。 */
export interface Skills {
  get(name: string): SkillDefinition | undefined
  list(): SkillDefinition[]
  has(name: string): boolean
  buildSystemReminder(context?: string, maxTokens?: number): string
}

/** 缝键：ctx.skills。 */
export const SKILLS_KEY = 'skills'

/** 把一个 Skills（如 SkillsLoader 或测试替身）挂载为 ctx.skills。 */
export function mountSkills(ctx: Context, skills: Skills): Disposer {
  return ctx.provide(SKILLS_KEY, skills)
}
