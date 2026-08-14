import { describe, it, expect } from 'vitest'
import { RedTeam } from '../../src/core/red-team'
import { isBlocked } from '../../src/tools/exec/bash'
import type { ConstitutionLoader } from '../../src/core/constitution-loader'
import type { PreFlightChecker } from '../../src/core/preflight-checker'

describe('RedTeam real-tool coverage', () => {
  it('the real Bash isBlocked blocks the force-push attack', () => {
    expect(isBlocked('git push --force origin main')).toBeTruthy()
    expect(isBlocked('ls -la')).toBeNull()
  })

  it('runs the attack suite and catches force-push via the real Bash tool', () => {
    // Stub the abstraction layer to return "not caught", so the only thing that
    // can catch the attack is the real Bash isBlocked — this proves the red team
    // now exercises the actual tool defense, not just constitution/preflight.
    const constitution = { audit: () => [] } as unknown as ConstitutionLoader
    const preflight = { check: () => ({ action: 'allow' }) } as unknown as PreFlightChecker

    const report = new RedTeam().run(constitution, preflight)
    expect(report.total).toBeGreaterThan(0)

    const forcePush = report.results.find((r) =>
      r.attack.description.toLowerCase().includes('force push'),
    )
    expect(forcePush).toBeDefined()
    expect(forcePush!.blocked).toBe(true)
    expect(forcePush!.caughtBy).toBe('bash-tool')
  })
})
