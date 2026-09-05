import { describe, it, expect, vi } from 'vitest'

// commands.ts imports execSync at top level — mock it to avoid real side effects.
const mockExecSync = vi.fn()
vi.mock('node:child_process', () => ({ execSync: mockExecSync }))

vi.mock('../../src/core/session-store', () => ({
  SessionStore: {
    getLatest: vi.fn(() => null),
    load: vi.fn(() => null),
    list: vi.fn(() => []),
    delete: vi.fn(() => false),
  },
}))

// Control skill-usage data without touching the real ~/.mipham/skill-usage.json.
vi.mock('../../src/skills/usage', () => ({
  loadSkillUsage: vi.fn(() => new Map()),
  recordSkillUsage: vi.fn(),
}))

const commandsModule = await import('../../src/ui/commands')
const { getCommand } = commandsModule as {
  getCommand: (name: string) => ((ctx: unknown, args: string[]) => { content: string }) | undefined
}
import { loadSkillUsage } from '../../src/skills/usage'

function mkSkill(name: string, type: 'standard' | 'mipham' = 'standard') {
  return { name, type, description: `Description for ${name}`, version: '1.0.0' }
}

function mkCtx(skills: ReturnType<typeof mkSkill>[]) {
  return { skillsLoader: { list: () => skills }, version: '0.0.0' } as never
}

describe('/skill-doctor', () => {
  it('is registered', () => {
    expect(getCommand('/skill-doctor')).toBeDefined()
  })

  it('lists never-used skills with a reclaimable-token summary', async () => {
    const skills = [mkSkill('alpha'), mkSkill('beta'), mkSkill('gamma', 'mipham')]
    const result = await getCommand('/skill-doctor')!(mkCtx(skills), [])
    expect(result.content).toContain('Loaded 3 skills')
    expect(result.content).toContain('3 never used')
    expect(result.content).toContain('Never used:')
    expect(result.content).toContain('alpha')
    expect(result.content).toContain('beta')
    expect(result.content).toContain('gamma')
  })

  it('separates recently-used from never-used skills', async () => {
    vi.mocked(loadSkillUsage).mockReturnValue(new Map([['alpha', Date.now()]]))
    const skills = [mkSkill('alpha'), mkSkill('beta')]
    const result = await getCommand('/skill-doctor')!(mkCtx(skills), [])
    expect(result.content).toContain('Recently used:')
    expect(result.content).toContain('alpha')
    expect(result.content).toContain('Never used:')
    expect(result.content).toContain('beta')
    expect(result.content).toContain('1 never used')
  })

  it('reports unavailable when there is no skills loader', async () => {
    const result = await getCommand('/skill-doctor')!({ version: '0.0.0' } as never, [])
    expect(result.content).toContain('unavailable')
  })
})
