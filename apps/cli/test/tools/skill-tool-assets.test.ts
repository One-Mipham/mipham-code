import { describe, it, expect, vi } from 'vitest'
import { SkillsLoader } from '../../src/skills/loader'

vi.mock('../../src/skills/skill-assets', () => ({ ensureSkillAssets: vi.fn() }))
import { ensureSkillAssets } from '../../src/skills/skill-assets'
import { skillTool } from '../../src/tools/agent/skill'

describe('Skill tool — asset extraction trigger', () => {
  it('calls ensureSkillAssets when invoking a skill that bundles assets', async () => {
    const loader = new SkillsLoader()
    loader.loadBuiltinFromPackage()

    const ctx = { skillsLoader: loader } as never
    const result = await skillTool.execute(
      { skill: 'web-access' },
      ctx as Parameters<typeof skillTool.execute>[1],
    )

    expect(result.success).toBe(true)
    expect(ensureSkillAssets).toHaveBeenCalledWith('web-access')
  })
})
