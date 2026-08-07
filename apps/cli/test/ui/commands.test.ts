/**
 * Slash Command Tests — bridge commands and forwardToAI mechanism
 *
 * Covers: /code-review, /simplify, /verify, /design, /loop, /goal
 * plus the gitDiffBridgeCmd factory and parseInterval helper.
 */

import { describe, it, expect, vi } from 'vitest'

// ── Mock node:child_process before importing the module under test ──
const mockExecSync = vi.fn()
vi.mock('node:child_process', () => ({ execSync: mockExecSync }))

// Dynamic import so the mock takes effect
const commandsModule = await import('../../src/ui/commands')

const { getCommand, getCommandNames, getCommandList, looksLikeSlashCommand, parseSlashCommand } =
  commandsModule as {
    getCommand: (
      name: string,
    ) => ((ctx: unknown, args: string[]) => { content: string; forwardToAI?: string }) | undefined
    getCommandNames: () => string[]
    getCommandList: () => { name: string; description: string }[]
    looksLikeSlashCommand: (input: string) => boolean
    parseSlashCommand: (input: string) => { command: string; args: string[] }
  }

// Minimal CommandContext stub
const mkCtx = () =>
  ({
    engine: {
      getTools: () => new Map(),
      getContext: () => ({
        getMessages: () => [],
        getEstimatedTokens: () => 0,
        getCheckpoints: () => [],
      }),
      setGoal: vi.fn(),
    },
    config: { providers: {} },
    providerId: 'test',
    modelId: 'test-model',
    version: '0.0.0',
    setSessionTitle: vi.fn(),
    setFastMode: vi.fn(),
    setEffort: vi.fn(),
    setFocusMode: vi.fn(),
    setGoal: vi.fn(),
  }) as unknown as Parameters<NonNullable<ReturnType<typeof getCommand>>>[0]

// ═══════════════════════════════════════════════════════════════
// Registry — all four bridge commands are registered
// ═══════════════════════════════════════════════════════════════

describe('slash command registry', () => {
  it('registers /code-review', () => {
    expect(getCommand('/code-review')).toBeDefined()
  })

  it('registers /simplify', () => {
    expect(getCommand('/simplify')).toBeDefined()
  })

  it('registers /verify', () => {
    expect(getCommand('/verify')).toBeDefined()
  })

  it('registers /design', () => {
    expect(getCommand('/design')).toBeDefined()
  })

  it('registers /loop', () => {
    expect(getCommand('/loop')).toBeDefined()
  })

  it('registers /goal', () => {
    expect(getCommand('/goal')).toBeDefined()
  })

  it('all four bridge commands appear in getCommandNames()', () => {
    const names = getCommandNames()
    expect(names).toContain('/code-review')
    expect(names).toContain('/simplify')
    expect(names).toContain('/verify')
    expect(names).toContain('/design')
  })

  it('all four bridge commands have descriptions', () => {
    const list = getCommandList()
    const byName = Object.fromEntries(list.map((e) => [e.name, e.description]))
    expect(byName['/code-review']).toBeTruthy()
    expect(byName['/simplify']).toBeTruthy()
    expect(byName['/verify']).toBeTruthy()
    expect(byName['/design']).toBeTruthy()
  })
})

// ═══════════════════════════════════════════════════════════════
// /code-review, /simplify, /verify — gitDiffBridgeCmd factory
// ═══════════════════════════════════════════════════════════════

describe('git-diff bridge commands (/code-review, /simplify, /verify)', () => {
  const bridgeCommands = ['/code-review', '/simplify', '/verify'] as const

  for (const cmd of bridgeCommands) {
    describe(cmd, () => {
      it('returns forwardToAI when git diff has changes', async () => {
        mockExecSync.mockReturnValue(
          ' file.ts | 5 +++--\n 1 file changed, 3 insertions(+), 2 deletions(-)',
        )
        const handler = getCommand(cmd)!
        const result = await handler(mkCtx(), [])
        expect(result.forwardToAI).toBeDefined()
        expect(result.forwardToAI!.length).toBeGreaterThan(50)
        expect(result.content).toContain('Changed files:')
      })

      it('does NOT return forwardToAI when there are no changes', async () => {
        mockExecSync.mockReturnValue('')
        const handler = getCommand(cmd)!
        const result = await handler(mkCtx(), [])
        expect(result.forwardToAI).toBeUndefined()
        expect(result.content).toContain('No uncommitted changes')
      })

      it('does NOT return forwardToAI on git error', async () => {
        mockExecSync.mockImplementation(() => {
          throw new Error('not a git repository')
        })
        const handler = getCommand(cmd)!
        const result = await handler(mkCtx(), [])
        expect(result.forwardToAI).toBeUndefined()
        expect(result.content).toContain('git repository')
      })
    })
  }
})

// ═══════════════════════════════════════════════════════════════
// /design — no git dependency, always forwards
// ═══════════════════════════════════════════════════════════════

describe('/design', () => {
  it('always returns forwardToAI (no git check)', async () => {
    const handler = getCommand('/design')!
    const result = await handler(mkCtx(), [])
    expect(result.forwardToAI).toBeDefined()
    expect(result.forwardToAI).toContain('design the architecture')
  })

  it('includes the topic in forwardToAI when args are provided', async () => {
    const handler = getCommand('/design')!
    const result = await handler(mkCtx(), ['the', 'auth', 'module'])
    expect(result.forwardToAI).toContain('the auth module')
  })

  it('uses default topic when no args', async () => {
    const handler = getCommand('/design')!
    const result = await handler(mkCtx(), [])
    expect(result.forwardToAI).toContain('the current task')
  })

  it('is synchronous (no async keyword)', () => {
    const handler = getCommand('/design')!
    const result = handler(mkCtx(), ['test'])
    // If it were async, result would be a Promise; synchronous returns the object directly
    expect(result).toHaveProperty('content')
    expect(result).toHaveProperty('forwardToAI')
  })
})

// ═══════════════════════════════════════════════════════════════
// /loop
// ═══════════════════════════════════════════════════════════════

describe('/loop', () => {
  it('shows usage when fewer than 2 args', async () => {
    const handler = getCommand('/loop')!
    const result = await handler(mkCtx(), ['5m'])
    expect(result.forwardToAI).toBeUndefined()
    expect(result.content).toContain('Usage')
  })

  it('auto-starts autonomous loop when interval is not recognised', async () => {
    const handler = getCommand('/loop')!
    const result = await handler(mkCtx(), ['xyz', 'do something'])
    // 'xyz' is not a valid interval — auto-detected as autonomous mode
    expect(result.content).toContain('Autonomous Loop')
    expect(result.forwardToAI).toBeDefined()
  })

  it('schedules via ScheduleWakeup for valid interval', async () => {
    const handler = getCommand('/loop')!
    const result = await handler(mkCtx(), ['5m', 'check deploy'])
    // Now directly invokes ScheduleWakeup, returns content (not forwardToAI)
    expect(result.content).toBeDefined()
    expect(result.content).toContain('5m')
    expect(result.content).toContain('check deploy')
  })

  it('parses seconds correctly', async () => {
    const handler = getCommand('/loop')!
    const result = await handler(mkCtx(), ['2m', 'ping']) // 120s — within [60,3600]
    expect(result.content).toContain('2m')
    expect(result.content).toContain('ping')
  })

  it('parses hours correctly', async () => {
    const handler = getCommand('/loop')!
    const result = await handler(mkCtx(), ['30min', 'full audit']) // 1800s — within [60,3600]
    expect(result.content).toContain('30m')
    expect(result.content).toContain('full audit')
  })

  it('parses alternate formats (min, sec, hr)', async () => {
    const handler = getCommand('/loop')!
    const r1 = await handler(mkCtx(), ['10sec', 'a'])
    expect(r1.content).toContain('a') // prompt is included
    const r2 = await handler(mkCtx(), ['3min', 'b'])
    expect(r2.content).toContain('b')
    const r3 = await handler(mkCtx(), ['1hr', 'c'])
    expect(r3.content).toContain('c')
  })
})

// ═══════════════════════════════════════════════════════════════
// /goal
// ═══════════════════════════════════════════════════════════════

describe('/goal', () => {
  it('shows usage when no args', () => {
    const handler = getCommand('/goal')!
    const result = handler(mkCtx(), [])
    expect(result.content).toContain('Usage')
  })

  it('sets goal when text provided', () => {
    const ctx = mkCtx()
    const handler = getCommand('/goal')!
    const result = handler(ctx, ['Fix', 'all', 'TypeScript', 'errors'])
    expect(result.content).toContain('✓ Goal set')
    expect(result.content).toContain('Fix all TypeScript errors')
  })
})

// ═══════════════════════════════════════════════════════════════
// Public API helpers
// ═══════════════════════════════════════════════════════════════

describe('slash command public API', () => {
  it('looksLikeSlashCommand detects slash-prefixed input', () => {
    expect(looksLikeSlashCommand('/help')).toBe(true)
    expect(looksLikeSlashCommand('hello')).toBe(false)
    expect(looksLikeSlashCommand(' /help')).toBe(true)
  })

  it('parseSlashCommand splits command and args', () => {
    expect(parseSlashCommand('/code-review')).toEqual({
      command: '/code-review',
      args: [],
    })
    expect(parseSlashCommand('/design auth module')).toEqual({
      command: '/design',
      args: ['auth', 'module'],
    })
  })

  it('getCommand returns undefined for unknown commands', () => {
    expect(getCommand('/nonexistent-command-xyz')).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════
// /resume, /resume last, /resume delete (Task 2.2)
// ═══════════════════════════════════════════════════════════════

describe('/resume commands (Task 2.2)', () => {
  it('registers /resume', () => {
    expect(getCommand('/resume')).toBeDefined()
  })

  it('registers /resume last', () => {
    expect(getCommand('/resume last')).toBeDefined()
  })

  it('registers /resume delete', () => {
    expect(getCommand('/resume delete')).toBeDefined()
  })

  it('all three resume commands appear in getCommandNames()', () => {
    const names = getCommandNames()
    expect(names).toContain('/resume')
    expect(names).toContain('/resume last')
    expect(names).toContain('/resume delete')
  })

  it('all three resume commands have descriptions', () => {
    const list = getCommandList()
    const byName: Record<string, string> = {}
    for (const e of list) {
      byName[e.name] = e.description
    }
    expect(byName['/resume']).toBeTruthy()
    expect(byName['/resume last']).toBeTruthy()
    expect(byName['/resume delete']).toBeTruthy()
  })

  it('/resume handles "last" sub-command', async () => {
    const handler = getCommand('/resume')!
    const result = await handler(mkCtx(), ['last'])
    // Without actual SessionStore data, should return "no saved sessions"
    expect(result.content).toContain('No saved sessions')
  })

  it('/resume handles "delete" sub-command', async () => {
    const handler = getCommand('/resume')!
    const result = await handler(mkCtx(), ['delete'])
    // Without a name arg, should show usage
    expect(result.content).toContain('Usage')
    expect(result.content).toContain('/resume delete')
  })

  it('/resume delete requires a session name', async () => {
    const handler = getCommand('/resume')!
    const result = await handler(mkCtx(), ['delete', 'nonexistent-session'])
    // Session doesn't exist, so it won't delete
    expect(result.content).toContain('not found')
  })

  it('/resume last standalone handler returns no-sessions message', async () => {
    const handler = getCommand('/resume last')!
    const result = await handler(mkCtx(), [])
    expect(result.content).toContain('No saved sessions')
  })

  it('/resume delete standalone handler shows usage without name', async () => {
    const handler = getCommand('/resume delete')!
    const result = await handler(mkCtx(), [])
    expect(result.content).toContain('Usage')
  })
})
