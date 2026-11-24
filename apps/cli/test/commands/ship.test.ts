import { describe, it, expect } from 'vitest'
import { buildShipPlan } from '../../src/commands/git'

function ctx(overrides: Partial<Parameters<typeof buildShipPlan>[0]> = {}) {
  return {
    branch: 'feat/x',
    defaultBranch: 'main',
    staged: 1,
    unstaged: 0,
    untracked: 0,
    ahead: '1',
    gh: true,
    args: '',
    ...overrides,
  }
}

describe('buildShipPlan', () => {
  it('refuses to plan on a detached HEAD', () => {
    const plan = buildShipPlan(ctx({ branch: '' }))
    expect(plan.forwardToAI).toBeUndefined()
    expect(plan.content).toContain('detached')
  })

  it('does not forward anything when there is nothing to ship', () => {
    const plan = buildShipPlan(ctx({ staged: 0, unstaged: 0, untracked: 0, ahead: '0' }))
    expect(plan.forwardToAI).toBeUndefined()
    expect(plan.content).toContain('Nothing to ship')
  })

  it('treats an unreadable ahead count as unknown work, not as nothing to ship', () => {
    // No origin / no upstream makes `rev-list` return '' — that is "unknown",
    // and saying "nothing to ship" there would hide local commits.
    const plan = buildShipPlan(ctx({ staged: 0, unstaged: 0, untracked: 0, ahead: '' }))
    expect(plan.forwardToAI).toBeDefined()
    expect(plan.content).toContain('unknown')
  })

  it('forwards the full loop and keeps the no-merge rule explicit', () => {
    const plan = buildShipPlan(ctx({ args: '--draft' }))
    const prompt = plan.forwardToAI ?? ''
    expect(plan.content).toContain('Branch:   feat/x')
    expect(prompt).toContain('Conventional Commits')
    expect(prompt).toContain('git push -u origin <branch>')
    expect(prompt).toContain('gh pr create')
    expect(prompt).toContain('--draft')
    expect(prompt).toContain('code-review skill')
    // PR Steward borrow: a failing check or a conflict is part of "ship", not a
    // reason to hand back a half-done PR.
    expect(prompt).toContain('gh pr checks')
    expect(prompt).toContain('conflicts')
    expect(prompt).toContain('Never force-push')
    expect(prompt).toContain('Never merge, approve, or change branch protection')
    // The undo instruction is the PR Steward borrow: every push says how to take
    // itself back, not just what it changed.
    expect(prompt).toContain('git revert <sha>')
  })

  it('warns when it is on the default branch and forbids committing there', () => {
    const plan = buildShipPlan(ctx({ branch: 'main', staged: 2 }))
    expect(plan.content).toContain('default branch')
    expect(plan.content).toContain('create a feature branch')
    expect(plan.forwardToAI).toContain('Never commit directly to main')
  })

  it('says the PR will not be opened when gh is missing', () => {
    const plan = buildShipPlan(ctx({ gh: false }))
    expect(plan.content).toContain('gh')
    expect(plan.content).toContain('no PR will be opened')
    expect(plan.forwardToAI).toContain('stop after the push')
  })
})
