import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/config/preferences', () => ({
  getPreference: vi.fn((_k: string, d: string) => d),
  setPreference: vi.fn(),
}))

import {
  getCommand,
  statuslineVisibility,
  SECURITY_REVIEW_PROMPT,
  type CommandResult,
} from '../../src/ui/commands'
import { ContextManager } from '../../src/core/context'
import { setPreference } from '../../src/config/preferences'

beforeEach(() => {
  vi.clearAllMocks()
})

const run = async (name: string, ctx: unknown, args: string[] = []): Promise<CommandResult> => {
  const handler = getCommand(name)
  if (!handler) throw new Error(`missing command ${name}`)
  return handler(ctx as never, args)
}

const mkCtx = (over: Record<string, unknown> = {}) =>
  ({
    engine: {
      getContext: () =>
        new ContextManager({ maxTokens: 100000, compactionThreshold: 0.9, contextWindow: 200000 }),
    },
    config: {},
    providerId: 'p',
    modelId: 'm',
    version: '0',
    sessionId: 's',
    setSessionTitle: () => {},
    setEffort: () => {},
    setFocusMode: () => {},
    setGoal: () => {},
    setUltracodeMode: () => {},
    setUpdateStatus: () => {},
    t: (k: string) => k,
    ...over,
  }) as never

describe('/autocompact', () => {
  it('sets an override and persists it', async () => {
    const cm = new ContextManager({
      maxTokens: 100000,
      compactionThreshold: 0.9,
      contextWindow: 200000,
    })
    const res = await run('/autocompact', mkCtx({ engine: { getContext: () => cm } }), ['85%'])
    expect(res.content).toContain('85%')
    expect(cm.getCompactionThreshold()).toBe(0.85)
    expect(setPreference).toHaveBeenCalledWith('autocompactThreshold', '0.85')
  })

  it('rejects out-of-range input without setting or persisting', async () => {
    const cm = new ContextManager({
      maxTokens: 100000,
      compactionThreshold: 0.9,
      contextWindow: 200000,
    })
    const res = await run('/autocompact', mkCtx({ engine: { getContext: () => cm } }), ['10%'])
    expect(res.content).toContain('0.50')
    expect(cm.getCompactionThreshold()).toBe(0.9)
    expect(setPreference).not.toHaveBeenCalledWith('autocompactThreshold', '0.1')
  })

  it('default clears the override and the preference', async () => {
    const cm = new ContextManager({
      maxTokens: 100000,
      compactionThreshold: 0.9,
      contextWindow: 200000,
    })
    cm.setCompactionThresholdOverride(0.7)
    await run('/autocompact', mkCtx({ engine: { getContext: () => cm } }), ['default'])
    expect(cm.getCompactionThreshold()).toBeCloseTo(0.9)
    expect(setPreference).toHaveBeenCalledWith('autocompactThreshold', '')
  })

  it('refuses in an attached (remote) session without touching preferences', async () => {
    const res = await run(
      '/autocompact',
      mkCtx({
        engine: {
          isRemote: true,
          getContext: () => {
            throw new Error('remote must not read local context')
          },
        },
      }),
      ['85%'],
    )
    expect(res.content).toContain('Attached to a daemon')
    expect(setPreference).not.toHaveBeenCalledWith('autocompactThreshold', '0.85')
  })
})

describe('/statusline', () => {
  it('maps modes to visible segments; permission label is always kept', () => {
    expect(statuslineVisibility('full')).toEqual({ graft: true, hints: true, git: true })
    expect(statuslineVisibility('compact')).toEqual({ graft: false, hints: false, git: true })
    expect(statuslineVisibility('off')).toEqual({ graft: false, hints: false, git: false })
  })

  it('sets the mode, calls the callback and persists', async () => {
    const setStatuslineMode = vi.fn()
    const res = await run('/statusline', mkCtx({ setStatuslineMode }), ['compact'])
    expect(res.content).toContain('compact')
    expect(setStatuslineMode).toHaveBeenCalledWith('compact')
    expect(setPreference).toHaveBeenCalledWith('statuslineMode', 'compact')
  })

  it('rejects an unknown mode without persisting or calling back', async () => {
    const setStatuslineMode = vi.fn()
    const res = await run('/statusline', mkCtx({ setStatuslineMode }), ['huge'])
    expect(res.content).toContain('Unknown')
    expect(setStatuslineMode).not.toHaveBeenCalled()
    expect(setPreference).not.toHaveBeenCalledWith('statuslineMode', 'huge')
  })
})

describe('/reload-plugins', () => {
  it('calls the callback and reports counts plus boundaries', async () => {
    const reloadPlugins = vi.fn(() => ({ plugins: 2, skills: 30 }))
    const res = await run('/reload-plugins', mkCtx({ reloadPlugins }))
    expect(res.content).toContain('2')
    expect(res.content).toContain('30')
    expect(res.content).toContain('MCP')
  })

  it('says unavailable when the callback is missing', async () => {
    const res = await run('/reload-plugins', mkCtx())
    expect(res.content).toContain('not available')
  })

  it('reports failure instead of success when the callback throws', async () => {
    const res = await run(
      '/reload-plugins',
      mkCtx({
        reloadPlugins: () => {
          throw new Error('boom')
        },
      }),
    )
    expect(res.content).toContain('failed')
    expect(res.content).not.toContain('Reloaded')
  })
})

describe('CC-compatible aliases', () => {
  it.each([
    ['/bug', '/bug-report'],
    ['/plugin', '/plugins'],
    ['/list-agents', '/agents'],
  ])('%s points at the same handler as %s', (alias, target) => {
    expect(getCommand(alias)).toBeDefined()
    expect(getCommand(alias)).toBe(getCommand(target))
  })

  it('/security-review is NOT an alias of /code-review', () => {
    expect(getCommand('/security-review')).toBeDefined()
    expect(getCommand('/security-review')).not.toBe(getCommand('/code-review'))
  })
})

describe('/security-review', () => {
  it('forwards a security-specific instruction, not the generic code-review one', () => {
    expect(SECURITY_REVIEW_PROMPT).toContain('security-review skill')
    expect(SECURITY_REVIEW_PROMPT).toContain('security')
    expect(SECURITY_REVIEW_PROMPT).not.toContain('CLAUDE.md violations only')
  })
})

describe('/subtask', () => {
  it('forwards a foreground fork-agent directive containing the task', async () => {
    const res = await run('/subtask', mkCtx(), ['audit', 'src/'])
    expect(res.forwardToAI).toContain('fork')
    expect(res.forwardToAI).toContain('run_in_background')
    expect(res.forwardToAI).toContain('audit src/')
  })

  it('prints usage and forwards nothing when empty', async () => {
    const res = await run('/subtask', mkCtx())
    expect(res.content).toContain('Usage')
    expect(res.forwardToAI).toBeUndefined()
  })
})
