import { describe, expect, it } from 'vitest'
import { runPreToolGate, toolAuditSurface, type ToolGateDeps } from '../../src/core/tool-gate'
import type { ProviderRegistry } from '../../src/providers/registry'
import type { HookEngine } from '../../src/core/hooks'
import type { ExperienceRuleEngine } from '../../src/core/rule-engine'
import type { ConstitutionLoader } from '../../src/core/constitution-loader'
import type { ConstitutionalPrinciple } from '../../src/core/constitution-loader'
import alignmentVocabulary from '../../src/core/alignment-vocabulary.json'

const registry = {} as ProviderRegistry

/**
 * The shipped principle, not a hand-copied pattern. The copy in this file used to
 * mirror the vocabulary "verbatim" — which is exactly how a rule that never fired
 * kept a green test: the copy and the original agreed with each other, and both
 * disagreed with the tool params.
 */
const CREDENTIAL_PRINCIPLE = alignmentVocabulary.principles.find(
  (p) => p.id === 'no-credential-leak',
) as ConstitutionalPrinciple

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

describe('toolAuditSurface', () => {
  it('renders string values verbatim, without JSON escaping', () => {
    const text = toolAuditSurface({ content: 'const apiKey = "sk-live-1"' })
    expect(text).toBe('content=const apiKey = "sk-live-1"')
    // The escaped spelling is precisely what made the double-quoted case unmatchable.
    expect(text).not.toContain('\\"')
  })

  it('joins several parameters so a key in one and a value in another stay visible', () => {
    expect(toolAuditSurface({ file_path: 'x.ts', content: 'a' })).toBe('file_path=x.ts\ncontent=a')
  })

  it('stringifies non-string values rather than printing [object Object]', () => {
    expect(toolAuditSurface({ nested: { a: 1 }, empty: undefined })).toBe(
      'nested={"a":1}\nempty=undefined',
    )
  })
})

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
      deps({ constitution: () => fakeConstitution([CREDENTIAL_PRINCIPLE]) }),
      's1',
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('no-credential-leak')
  })

  // The rule is advertised as "blocks credential leaks". Four spellings of the
  // same leak used to reach it — only the single-quoted one was ever blocked,
  // because the params were matched as `JSON.stringify(...)` (which escapes the
  // double quote the pattern's `['"]` class was written for) and because the
  // pattern demanded a quote where Bash and YAML do not use one.
  it.each([
    ['JS double-quoted', { file_path: 'x.ts', content: 'const apiKey = "sk-live-123456789"' }],
    ['JS single-quoted', { file_path: 'x.ts', content: "const apiKey = 'sk-live-123456789'" }],
    ['YAML / config unquoted', { file_path: 'c.yml', content: 'apiKey: sk-live-123456789' }],
    ['Bash assignment', { command: 'API_KEY=sk-live-123456789 npm run build' }],
  ])('blocks a leaked credential written as %s', async (_label, params) => {
    const outcome = await runPreToolGate(
      'Write',
      params,
      deps({ constitution: () => fakeConstitution([CREDENTIAL_PRINCIPLE]) }),
      's1',
    )
    expect(outcome.ok, `not blocked: ${JSON.stringify(params)}`).toBe(false)
  })

  // Without this control, "everything is blocked" would also pass the four cases
  // above — and a block-level rule that fires on `password = getPassword()`
  // would make the tool unusable.
  it.each([
    ['a function call', { file_path: 'x.ts', content: 'const password = getPassword()' }],
    ['an env reference', { file_path: 'x.ts', content: 'const token = process.env.TOKEN' }],
    ['a constant name', { file_path: 'c.yml', content: 'credential: SOME_CONSTANT_NAME_ABC' }],
  ])('does not block ordinary code that only mentions the word (%s)', async (_label, params) => {
    const outcome = await runPreToolGate(
      'Write',
      params,
      deps({ constitution: () => fakeConstitution([CREDENTIAL_PRINCIPLE]) }),
      's1',
    )
    expect(outcome.ok, `false positive: ${JSON.stringify(params)}`).toBe(true)
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
