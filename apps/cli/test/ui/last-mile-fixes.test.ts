/**
 * Remaining P1/P2: Ollama context windows are real (not a hardcoded 128k), and
 * ultracode mode persists past the turn that enabled it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => {
    throw new Error('ollama not installed in test')
  }),
}))

const { getCommand } = (await import('../../src/ui/commands')) as unknown as {
  getCommand: (
    name: string,
  ) =>
    | ((ctx: unknown, args: string[]) => Promise<{ content: string }> | { content: string })
    | undefined
}
const { applyUltracodeMode, QueryEngine } = (await import('../../src/core/engine')) as unknown as {
  applyUltracodeMode: (prompt: string, on: boolean) => string
  QueryEngine: new (...args: unknown[]) => {
    setUltracodeMode: (on: boolean) => void
    getUltracodeMode: () => boolean
  }
}

const mkCtx = () =>
  ({
    config: {
      providers: [{ id: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: [] }],
    },
    t: undefined,
  }) as never

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('/ollama-refresh context windows', () => {
  it('uses the context length reported by /api/show', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ model_info: { 'llama.context_length': 8192 } }),
      })),
    )
    const ctx = mkCtx()
    const result = await getCommand('/ollama-refresh')!(ctx, [])
    const provider = (ctx as unknown as { config: { providers: any[] } }).config.providers[0]
    expect(provider.models.length).toBeGreaterThan(0)
    expect(provider.models.every((m: { contextWindow: number }) => m.contextWindow === 8192)).toBe(
      true,
    )
    expect(provider.models.every((m: { maxOutput: number }) => m.maxOutput === 8192)).toBe(true)
    expect(result.content).not.toContain('assumed')
  })

  it('says the 128k fallback out loud when /api/show does not answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused')
      }),
    )
    const ctx = mkCtx()
    const result = await getCommand('/ollama-refresh')!(ctx, [])
    const provider = (ctx as unknown as { config: { providers: any[] } }).config.providers[0]
    expect(
      provider.models.every((m: { contextWindow: number }) => m.contextWindow === 128_000),
    ).toBe(true)
    expect(result.content).toContain('assumed 128k')
  })
})

describe('ultracode mode persistence', () => {
  it('applies the instruction only while the flag is on', () => {
    expect(applyUltracodeMode('SYS', false)).toBe('SYS')
    const on = applyUltracodeMode('SYS', true)
    expect(on).toContain('Ultracode mode is ON')
    expect(on.startsWith('SYS')).toBe(true)
  })

  it('the engine owns the flag (so it survives across turns)', () => {
    const engine = new QueryEngine(undefined, undefined, new Map())
    expect(engine.getUltracodeMode()).toBe(false)
    engine.setUltracodeMode(true)
    expect(engine.getUltracodeMode()).toBe(true)
  })
})
