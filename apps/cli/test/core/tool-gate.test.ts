import { describe, expect, it } from 'vitest'
import { runPreToolGate, type ToolGateDeps } from '../../src/core/tool-gate'
import type { ProviderRegistry } from '../../src/providers/registry'
import type { HookEngine } from '../../src/core/hooks'
import type { ExperienceRuleEngine } from '../../src/core/rule-engine'
import type { ConstitutionLoader } from '../../src/core/constitution-loader'

const registry = {} as ProviderRegistry

function deps(over: Partial<ToolGateDeps> = {}): ToolGateDeps {
  return { crsiPreToolHook: true, registry, ...over }
}

function fakeHookEngine(result: Awaited<ReturnType<HookEngine['executePreToolUse']>>): HookEngine {
  return { executePreToolUse: async () => result } as unknown as HookEngine
}

function fakeConstitution(
  principles: Array<{
    id: string
    text: string
    enforce: 'block' | 'warn' | 'auto'
    audit_pattern?: string
  }>,
): ConstitutionLoader {
  return {
    getPrinciplesForTool: () => principles,
  } as unknown as ConstitutionLoader
}

describe('runPreToolGate', () => {
  it('returns the same params object when nothing rewrites it', async () => {
    const params = { command: 'ls' }
    const outcome = await runPreToolGate('Bash', params, deps(), 's1')
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      // Identity is the caller's signal that no stage rewrote the call, which
      // is what decides whether the permission gate has to rule again.
      expect(outcome.params).toBe(params)
      expect(outcome.warnings).toEqual([])
    }
  })

  it('stops at a blocking PreToolUse hook', async () => {
    const outcome = await runPreToolGate(
      'Bash',
      { command: 'rm -rf /' },
      deps({
        hookEngine: fakeHookEngine({ allowed: false, reason: 'policy' }),
      }),
      's1',
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error).toBe('policy')
      expect(outcome.notRun).toBe(true)
    }
  })

  it('treats a hook `ask` decision as a refusal, never as approval', async () => {
    const outcome = await runPreToolGate(
      'Bash',
      { command: 'ls' },
      deps({
        hookEngine: fakeHookEngine({ allowed: true, permissionDecision: 'ask' }),
      }),
      's1',
    )
    expect(outcome.ok).toBe(false)
  })

  it("keeps a hook's additionalContext as a warning on an allowed call", async () => {
    const outcome = await runPreToolGate(
      'Bash',
      { command: 'ls' },
      deps({
        hookEngine: fakeHookEngine({ allowed: true, additionalContext: 'note from hook' }),
      }),
      's1',
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.warnings).toContain('note from hook')
  })

  it('applies the CRSI rule rewrite and keeps its warning', async () => {
    const ruleEngine = {
      intercept: () => ({ modified: { command: 'ls -la' }, warnings: ['[rule:x] careful'] }),
    } as unknown as ExperienceRuleEngine
    const outcome = await runPreToolGate('Bash', { command: 'ls' }, deps({ ruleEngine }), 's1')
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.params).toEqual({ command: 'ls -la' })
      expect(outcome.warnings).toContain('[rule:x] careful')
    }
  })

  it('does not consult the rule engine when crsi.preToolHook is false', async () => {
    let called = false
    const ruleEngine = {
      intercept: () => {
        called = true
        return { modified: {}, warnings: [] }
      },
    } as unknown as ExperienceRuleEngine
    await runPreToolGate(
      'Bash',
      { command: 'ls' },
      deps({ ruleEngine, crsiPreToolHook: false }),
      's1',
    )
    expect(called).toBe(false)
  })

  it('blocks a constitution violation before the tool runs', async () => {
    const outcome = await runPreToolGate(
      'Write',
      { file_path: 'x.ts', content: "const apiKey = 'sk-live-123456789'" },
      deps({
        constitution: () =>
          fakeConstitution([
            {
              id: 'no-credential-leak',
              text: 'no keys',
              enforce: 'block',
              // Verbatim from `src/core/alignment-vocabulary.json`, because the
              // parameters reach this check as `JSON.stringify(...)` and the
              // pattern has to match that spelling, not the source text.
              audit_pattern:
                '(apiKey|api_key|password|secret|token|credential)\\s*[=:]\\s*[\'"][^\'"]{8,}',
            },
          ]),
      }),
      's1',
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('no-credential-leak')
  })

  it('turns a warn-level principle into a warning, not a block', async () => {
    const outcome = await runPreToolGate(
      'Write',
      { file_path: 'x.ts' },
      deps({
        constitution: () =>
          fakeConstitution([{ id: 'minimal-change', text: 'keep diffs small', enforce: 'warn' }]),
      }),
      's1',
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.warnings.join('\n')).toContain('minimal-change')
  })

  it('weaves every stage into one warning list instead of replacing it', async () => {
    const ruleEngine = {
      intercept: () => ({ modified: {}, warnings: ['from-rules'] }),
    } as unknown as ExperienceRuleEngine
    const outcome = await runPreToolGate(
      'Write',
      { file_path: 'x.ts' },
      deps({
        hookEngine: fakeHookEngine({ allowed: true, additionalContext: 'from-hook' }),
        ruleEngine,
        constitution: () =>
          fakeConstitution([{ id: 'minimal-change', text: 'small diffs', enforce: 'warn' }]),
      }),
      's1',
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.warnings).toEqual([
        'from-hook',
        'from-rules',
        expect.stringContaining('minimal-change'),
      ])
    }
  })
})
