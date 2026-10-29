import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  isPrMergeCommand,
  ReviewLedger,
  createMergeGateHook,
  registerBuiltinHooks,
  noteToolOutcome,
  REVIEW_WINDOW_MS,
} from '../../src/core/merge-gate'
import { HookEngine } from '../../src/core/hooks'

describe('isPrMergeCommand', () => {
  it('recognizes a plain gh pr merge', () => {
    expect(isPrMergeCommand('gh pr merge 55 --squash --delete-branch')).toBe(true)
  })

  it('recognizes gh pr merge inside a compound command', () => {
    expect(isPrMergeCommand('cd repo && gh pr merge 55')).toBe(true)
  })

  it('recognizes a command preceded by an environment assignment', () => {
    expect(isPrMergeCommand('GH_TOKEN=x gh pr merge 55')).toBe(true)
  })

  it('recognizes a merge behind a wrapper command', () => {
    expect(isPrMergeCommand('sudo gh pr merge 55')).toBe(true)
  })

  it('recognizes a merge behind env with its own assignments', () => {
    expect(isPrMergeCommand('env GH_TOKEN=x gh pr merge 55')).toBe(true)
  })

  it('recognizes a merge after gh global flags', () => {
    expect(isPrMergeCommand('gh -R owner/repo pr merge 55 --squash')).toBe(true)
  })

  it('does not treat other gh subcommands as a merge', () => {
    expect(isPrMergeCommand('gh pr view 55')).toBe(false)
  })

  it('does not treat a bare mention as the command being run', () => {
    expect(isPrMergeCommand('echo gh pr merge 55')).toBe(false)
  })

  it('does not treat a quoted mention as the command being run', () => {
    expect(isPrMergeCommand('echo "gh pr merge 55"')).toBe(false)
  })

  it('does not treat a commit message mentioning a merge as a merge', () => {
    expect(isPrMergeCommand('git commit -m "gh pr merge 55"')).toBe(false)
  })

  it('does not treat a help request as a merge', () => {
    expect(isPrMergeCommand('gh pr merge --help')).toBe(false)
  })
})

describe('ReviewLedger', () => {
  it('has no review until one is marked', () => {
    const ledger = new ReviewLedger()
    expect(ledger.hasReviewed('s1')).toBe(false)
  })

  it('remembers a review per session', () => {
    const ledger = new ReviewLedger()
    ledger.markReviewed('s1')
    expect(ledger.hasReviewed('s1')).toBe(true)
    expect(ledger.hasReviewed('s2')).toBe(false)
  })

  it('forgets a review older than the window', () => {
    const ledger = new ReviewLedger()
    const at = 1_000_000
    ledger.markReviewed('s1', at)
    expect(ledger.hasReviewed('s1', at + REVIEW_WINDOW_MS + 1)).toBe(false)
  })
})

describe('noteToolOutcome', () => {
  it('records a successful review skill run for the session', () => {
    const ledger = new ReviewLedger()
    noteToolOutcome(ledger, 's1', 'Skill', { skill: 'code-review' }, true)
    expect(ledger.hasReviewed('s1')).toBe(true)
  })

  it('does not record a failed skill run', () => {
    const ledger = new ReviewLedger()
    noteToolOutcome(ledger, 's1', 'Skill', { skill: 'code-review' }, false)
    expect(ledger.hasReviewed('s1')).toBe(false)
  })

  it('ignores skills that are not reviews', () => {
    const ledger = new ReviewLedger()
    noteToolOutcome(ledger, 's1', 'Skill', { skill: 'research' }, true)
    expect(ledger.hasReviewed('s1')).toBe(false)
  })

  it('ignores tools other than Skill', () => {
    const ledger = new ReviewLedger()
    noteToolOutcome(ledger, 's1', 'Bash', { command: 'code-review' }, true)
    expect(ledger.hasReviewed('s1')).toBe(false)
  })
})

describe('merge gate hook', () => {
  const mergeCommand = { command: 'gh pr merge 55 --squash' }

  it('blocks a merge when no review has run', async () => {
    const hook = createMergeGateHook(new ReviewLedger())
    const result = await hook.handler({
      event: 'PreToolUse',
      toolName: 'Bash',
      toolInput: mergeCommand,
      sessionId: 's1',
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('/code-review')
  })

  it('allows a merge after a review ran in the same session', async () => {
    const ledger = new ReviewLedger()
    ledger.markReviewed('s1')
    const hook = createMergeGateHook(ledger)
    const result = await hook.handler({
      event: 'PreToolUse',
      toolName: 'Bash',
      toolInput: mergeCommand,
      sessionId: 's1',
    })
    expect(result.allowed).toBe(true)
  })

  it('still blocks a merge in a session that did not review', async () => {
    const ledger = new ReviewLedger()
    ledger.markReviewed('s1')
    const hook = createMergeGateHook(ledger)
    const result = await hook.handler({
      event: 'PreToolUse',
      toolName: 'Bash',
      toolInput: mergeCommand,
      sessionId: 's2',
    })
    expect(result.allowed).toBe(false)
  })

  it('leaves non-merge commands alone', async () => {
    const hook = createMergeGateHook(new ReviewLedger())
    const result = await hook.handler({
      event: 'PreToolUse',
      toolName: 'Bash',
      toolInput: { command: 'git status' },
      sessionId: 's1',
    })
    expect(result.allowed).toBe(true)
  })

  describe('operator waiver', () => {
    const previous = process.env.MIPHAM_SKIP_MERGE_GATE
    beforeEach(() => {
      process.env.MIPHAM_SKIP_MERGE_GATE = '1'
    })
    afterEach(() => {
      if (previous === undefined) delete process.env.MIPHAM_SKIP_MERGE_GATE
      else process.env.MIPHAM_SKIP_MERGE_GATE = previous
    })

    it('allows the merge when the operator waived the gate', async () => {
      const hook = createMergeGateHook(new ReviewLedger())
      const result = await hook.handler({
        event: 'PreToolUse',
        toolName: 'Bash',
        toolInput: mergeCommand,
        sessionId: 's1',
      })
      expect(result.allowed).toBe(true)
    })
  })
})

describe('registerBuiltinHooks', () => {
  it('installs the merge gate into a hook engine', async () => {
    const engine = new HookEngine('/tmp')
    registerBuiltinHooks(engine)
    const result = await engine.executePreToolUse('Bash', { command: 'gh pr merge 9' }, 's1')
    expect(result.allowed).toBe(false)
  })
})
