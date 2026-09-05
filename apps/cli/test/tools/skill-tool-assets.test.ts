import { describe, it, expect, vi } from 'vitest'
import { SkillsLoader } from '../../src/skills/loader'

// Isolate skill usage recording from the real ~/.mipham/skill-usage.json — a
// successful execute now calls recordSkillUsage, which must not pollute live data.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => `${actual.tmpdir()}/mipham-test-skill-assets` }
})
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

  it('still returns the skill body when asset extraction throws (e.g. EACCES/ENOSPC)', async () => {
    vi.mocked(ensureSkillAssets).mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied, mkdir ~/.mipham/skills')
    })

    const loader = new SkillsLoader()
    loader.loadBuiltinFromPackage()

    const ctx = { skillsLoader: loader } as never
    const result = await skillTool.execute(
      { skill: 'web-access' },
      ctx as Parameters<typeof skillTool.execute>[1],
    )

    expect(result.success).toBe(true)
    expect(result.content).toContain('web-access')
  })
})
