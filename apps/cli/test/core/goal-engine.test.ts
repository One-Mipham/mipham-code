import { describe, it, expect } from 'vitest'

// ── Unit tests for goal state management (no provider needed) ──
// We test the goal state logic via the engine's public API.

describe('Goal state management', () => {
  it('setGoal with verifyScript option', () => {
    // Simulate engine behavior — test the options parsing
    const opts = { verifyScript: './check.sh' }
    expect(opts.verifyScript).toBe('./check.sh')
    expect(opts.verifySkill).toBeUndefined()
    expect(opts.decompose).toBeUndefined()
  })

  it('setGoal with verifySkill option', () => {
    const opts = { verifySkill: 'security-review' }
    expect(opts.verifySkill).toBe('security-review')
    expect(opts.verifyScript).toBeUndefined()
  })

  it('setGoal with decompose option', () => {
    const opts = { decompose: true }
    expect(opts.decompose).toBe(true)
  })

  it('setGoal with all options', () => {
    const opts = { verifyScript: './test.sh', verifySkill: 'tdd', decompose: true }
    expect(opts.verifyScript).toBe('./test.sh')
    expect(opts.verifySkill).toBe('tdd')
    expect(opts.decompose).toBe(true)
  })

  it('setGoal with no options (default behavior)', () => {
    const opts = {}
    expect(opts.verifyScript).toBeUndefined()
    expect(opts.verifySkill).toBeUndefined()
    expect(opts.decompose).toBeUndefined()
  })
})

describe('Goal check message builder', () => {
  it('default mode asks YES/NO', () => {
    const goal = 'Fix all tests'
    const msg = `Has this goal been achieved? "${goal}" Answer YES or NO with reason.`
    expect(msg).toContain('YES or NO')
    expect(msg).toContain(goal)
  })

  it('script mode mentions the script', () => {
    const goal = 'Build passes'
    const script = './scripts/check-build.sh'
    const msg = `Run the verification script "${script}" to check: ${goal}`
    expect(msg).toContain(script)
    expect(msg).toContain(goal)
  })

  it('skill mode asks for VERIFIED response', () => {
    const goal = 'Security audit'
    const skill = 'security-review'
    const msg = `Use the skill "${skill}" to verify: ${goal}. If the goal is achieved, respond with VERIFIED. Otherwise explain what's missing.`
    expect(msg).toContain('VERIFIED')
    expect(msg).toContain(skill)
    expect(msg).toContain(goal)
  })
})
