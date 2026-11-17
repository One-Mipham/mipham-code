/**
 * Readout fidelity: panels that under-reported or mislabelled what they show.
 */

import { describe, it, expect } from 'vitest'

const { getCommand } = (await import('../../src/ui/commands')) as unknown as {
  getCommand: (
    name: string,
  ) =>
    | ((ctx: unknown, args: string[]) => Promise<{ content: string }> | { content: string })
    | undefined
}

const rules = [
  { id: 'r-builtin', source: 'builtin', enabled: true },
  { id: 'r-auto', source: 'pattern-analyzer', enabled: true },
  { id: 'r-manual', source: 'manual', enabled: true },
  { id: 'r-managed', source: 'managed', enabled: true },
]

const mkCtx = (mode = 'default') =>
  ({
    engine: {
      getTools: () =>
        new Map([
          ['read', { category: 'file', permission: 'self', description: 'Read a file' }],
          ['artifact', { category: 'artifact', permission: 'self', description: 'Write artifact' }],
          [
            'schedule-wakeup',
            { category: 'scheduling', permission: 'self', description: 'Schedule wakeup' },
          ],
        ]),
      getPermission: () => ({ getMode: () => mode }),
      getRuleEngine: () => ({
        getActiveRules: () => rules,
      }),
      getEffectivenessTracker: () => ({ allRules: [], getEffectiveness: () => undefined }),
    },
    config: {
      version: 1,
      defaultProvider: 'test',
      defaultModel: 'test-model',
      permission: 'default',
      showThinking: false,
      providers: [],
    },
    sessionId: 's',
    version: '0.0.0',
    t: undefined,
  }) as never

describe('/commands bucket coverage', () => {
  it('lists the Code Quality bucket instead of silently dropping its commands', async () => {
    const result = await getCommand('/commands')!(mkCtx(), [])
    expect(result.content).toContain('Code Quality')
    expect(result.content).toContain('/code-review')
    expect(result.content).toContain('/verify')
  })
})

describe('/tools category coverage', () => {
  it('shows artifact and scheduling tools instead of dropping them', async () => {
    const result = await getCommand('/tools')!(mkCtx(), [])
    expect(result.content).toContain('ARTIFACT')
    expect(result.content).toContain('artifact')
    expect(result.content).toContain('SCHEDULING')
    expect(result.content).toContain('schedule-wakeup')
  })
})

describe('/crsi managed rules', () => {
  it('counts managed rules instead of making the breakdown sum to less than the total', async () => {
    const stats = await getCommand('/crsi stats')!(mkCtx(), [])
    expect(stats.content).toContain('Managed: 1')

    const health = await getCommand('/crsi health')!(mkCtx(), [])
    expect(health.content).toContain('受管 1')
  })
})

describe('/version runtime label', () => {
  it('names the actual runtime instead of "Bun (Node.js)"', async () => {
    const result = await getCommand('/version')!(mkCtx(), [])
    const expected =
      typeof Bun !== 'undefined' ? `Bun ${Bun.version}` : `Node.js ${process.version}`
    expect(result.content).toContain(expected)
    expect(result.content).not.toContain('(Node.js)')
  })
})

describe('/config permission readout', () => {
  it('reports the live permission mode, not just the configured default', async () => {
    const result = await getCommand('/config')!(mkCtx('plan'), [])
    expect(result.content).toContain('plan')
    expect(result.content).toMatch(/permission.*plan/)
  })
})
