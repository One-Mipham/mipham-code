/**
 * Fake successes, step 3: commands that reported success while changing
 * nothing (or changing the wrong thing).
 *
 * Covers /no-plan, /lang, /loop, /crsi disable|restore, /keys rotate, and the
 * removal of /theme (no reader existed anywhere in the tree).
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Isolate user-level stores: settings.json / config.yml / keys.json.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => `${actual.tmpdir()}/mipham-test-step3-home` }
})

const { mockSchedule } = vi.hoisted(() => ({ mockSchedule: vi.fn() }))
vi.mock('../../src/tools/scheduling/schedule-wakeup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tools/scheduling/schedule-wakeup')>()
  return { ...actual, scheduleWakeupTool: { execute: mockSchedule } }
})

const { getCommand, getCommandNames } = (await import('../../src/ui/commands')) as unknown as {
  getCommand: (
    name: string,
  ) =>
    | ((ctx: unknown, args: string[]) => Promise<{ content: string }> | { content: string })
    | undefined
  getCommandNames: () => string[]
}

const HOME = join(tmpdir(), 'mipham-test-step3-home')

beforeEach(() => {
  rmSync(HOME, { recursive: true, force: true })
  mockSchedule.mockReset()
  mockSchedule.mockResolvedValue({ success: true, content: 'Wakeup scheduled' })
})

afterEach(() => {
  delete process.env.MIPHAM_ROTATE_KEY
  delete process.env.MIPHAM_ROTATE_KEY_DEEPSEEK
})

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true })
})

// ── /theme ──────────────────────────────────────────────────────

describe('/theme — removed instead of claiming a set that never happened', () => {
  it('is no longer a command', () => {
    expect(getCommand('/theme')).toBeUndefined()
    expect(getCommandNames()).not.toContain('/theme')
  })
})

// ── /no-plan ────────────────────────────────────────────────────

const permCtx = (mode: string, opts: { canSwitch?: boolean } = {}) => {
  const state = { mode }
  const ctx: Record<string, unknown> = {
    engine: { getPermission: () => ({ getMode: () => state.mode }) },
    t: undefined,
  }
  if (opts.canSwitch !== false) {
    ctx.setPermissionMode = (next: string) => {
      state.mode = next
    }
  }
  return { ctx: ctx as never, state }
}

describe('/no-plan — exits plan mode for real', () => {
  it('switches the live mode from plan to default', async () => {
    const { ctx, state } = permCtx('plan')
    const result = await getCommand('/no-plan')!(ctx, [])
    expect(state.mode).toBe('default')
    expect(result.content).toContain('Plan mode exited')
  })

  it('says nothing changed when not in plan mode (instead of claiming an exit)', async () => {
    const { ctx, state } = permCtx('acceptEdits')
    const result = await getCommand('/no-plan')!(ctx, [])
    expect(state.mode).toBe('acceptEdits')
    expect(result.content).toContain('Not in plan mode')
    expect(result.content).not.toContain('Plan mode exited')
  })

  it('reports the clamp when the organisation keeps the mode in plan', async () => {
    const { ctx, state } = permCtx('plan')
    ;(ctx as unknown as { setPermissionMode: (m: string) => void }).setPermissionMode = () => {}
    const result = await getCommand('/no-plan')!(ctx, [])
    expect(state.mode).toBe('plan')
    expect(result.content).toContain('kept the mode at plan')
  })

  it('admits the surface cannot switch modes', async () => {
    const { ctx } = permCtx('plan', { canSwitch: false })
    const result = await getCommand('/no-plan')!(ctx, [])
    expect(result.content).toContain('cannot switch permission modes')
  })
})

// ── /lang ───────────────────────────────────────────────────────

describe('/lang — persists the choice and reports the live locale', () => {
  const langCtx = (locale: string) => ({ locale }) as never

  it('writes the locale to user settings.json', async () => {
    const result = await getCommand('/lang')!(langCtx('en-US'), ['zh-CN'])
    expect(result.content).toContain('zh-CN')
    expect(result.content).toContain('Restart')
    const settings = JSON.parse(readFileSync(join(HOME, '.mipham', 'settings.json'), 'utf-8'))
    expect(settings.locale).toBe('zh-CN')
  })

  it('reports the live locale, not a hardcoded en-US', async () => {
    const result = await getCommand('/lang')!(langCtx('zh-CN'), [])
    expect(result.content).toContain('zh-CN')
  })

  it('keeps other settings keys when saving', async () => {
    mkdirSync(join(HOME, '.mipham'), { recursive: true })
    const path = join(HOME, '.mipham', 'settings.json')
    await import('node:fs').then((fs) =>
      fs.writeFileSync(path, JSON.stringify({ telemetry: { enabled: true } }), 'utf-8'),
    )
    await getCommand('/lang')!(langCtx('en-US'), ['zh-CN'])
    const settings = JSON.parse(readFileSync(path, 'utf-8'))
    expect(settings.telemetry).toEqual({ enabled: true })
    expect(settings.locale).toBe('zh-CN')
  })
})

// ── /loop ───────────────────────────────────────────────────────

describe('/loop — schedules against the real session and respects the tool bounds', () => {
  const loopCtx = (sessionId: string) =>
    ({
      sessionId,
      engine: { getUsageTracker: () => ({ totalApiTokens: 0 }) },
      config: {},
    }) as never

  it('arms the wakeup for this session, not a hardcoded one', async () => {
    const result = await getCommand('/loop')!(loopCtx('sess-42'), ['5m', 'check deploy'])
    expect(result.content).toContain('Wakeup scheduled')
    expect(mockSchedule).toHaveBeenCalledTimes(1)
    const [params, toolCtx] = mockSchedule.mock.calls[0]!
    expect((params as { delaySeconds: number }).delaySeconds).toBe(300)
    expect((toolCtx as { sessionId: string }).sessionId).toBe('sess-42')
  })

  it('rejects intervals below the tool minimum before scheduling', async () => {
    const result = await getCommand('/loop')!(loopCtx('sess-42'), ['10s', 'poll'])
    expect(result.content).toContain('60')
    expect(mockSchedule).not.toHaveBeenCalled()
  })

  it('rejects intervals above one hour before scheduling', async () => {
    const result = await getCommand('/loop')!(loopCtx('sess-42'), ['2h', 'poll'])
    expect(result.content).toContain('3600')
    expect(mockSchedule).not.toHaveBeenCalled()
  })

  it('usage text no longer advertises a 10s example', async () => {
    const result = await getCommand('/loop')!(loopCtx('sess-42'), [])
    expect(result.content).not.toContain('10s')
  })
})

// ── /crsi disable / restore ─────────────────────────────────────

const crsiCtx = (opts: { found: boolean; source?: string }) => {
  const setRuleEnabled = vi.fn(() => opts.found)
  const ctx = {
    engine: {
      getRuleEngine: () => ({
        setRuleEnabled,
        getRule: () => (opts.found ? { source: opts.source ?? 'manual' } : undefined),
      }),
    },
  }
  return { ctx: ctx as never, setRuleEnabled }
}

describe('/crsi disable — unknown ids are reported, session-only changes are labelled', () => {
  it('says "not found" instead of "has been disabled" for an unknown id', async () => {
    const { ctx } = crsiCtx({ found: false })
    const result = await getCommand('/crsi disable')!(ctx, ['nope'])
    expect(result.content).toContain('not found')
    expect(result.content).not.toContain('has been disabled')
  })

  it('disables a known rule', async () => {
    const { ctx, setRuleEnabled } = crsiCtx({ found: true, source: 'manual' })
    const result = await getCommand('/crsi disable')!(ctx, ['rule-x'])
    expect(setRuleEnabled).toHaveBeenCalledWith('rule-x', false)
    expect(result.content).toContain('has been disabled')
  })

  it('labels builtin rules as reverting on restart', async () => {
    const { ctx } = crsiCtx({ found: true, source: 'builtin' })
    const result = await getCommand('/crsi disable')!(ctx, ['rule-builtin'])
    expect(result.content).toContain('reverts on restart')
  })

  it('restore reports unknown ids too', async () => {
    const { ctx } = crsiCtx({ found: false })
    const result = await getCommand('/crsi restore')!(ctx, ['nope'])
    expect(result.content).toContain('not found')
    expect(result.content).not.toContain('has been re-enabled')
  })
})

// ── /keys rotate ────────────────────────────────────────────────

describe('/keys rotate — a path that can actually rotate a key', () => {
  it('refuses to read the key from chat and names the environment variable', async () => {
    // Dispatch path: `parseSlashCommand('/keys rotate deepseek')` → /keys + args.
    const result = await getCommand('/keys')!({} as never, ['rotate', 'deepseek'])
    expect(result.content).toContain('MIPHAM_ROTATE_KEY_DEEPSEEK')
    expect((result as { forwardToAI?: string }).forwardToAI).toBeUndefined()
  })

  it('reads the key from the environment and persists it', async () => {
    mkdirSync(join(HOME, '.mipham'), { recursive: true })
    process.env.MIPHAM_ROTATE_KEY_DEEPSEEK = 'sk-rotated-123'
    const result = await getCommand('/keys')!({} as never, ['rotate', 'deepseek'])
    expect(result.content).toContain('rotated')
    expect(existsSync(join(HOME, '.mipham', 'config.yml'))).toBe(true)
    const { getProviderApiKey } = await import('../../src/config/loader')
    expect(getProviderApiKey('deepseek')).toBe('sk-rotated-123')
  })
})
