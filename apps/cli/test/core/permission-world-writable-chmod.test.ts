import { afterEach, describe, it, expect } from 'vitest'
import type { ToolDefinition } from '../../src/shared'
import { PermissionSystem } from '../../src/core/permission'

/**
 * A recursive `chmod` that grants world-write to a target the command does not
 * bound is the widest coin-flip the `auto` gate has been measured making
 * (2026-09-30: reasoning 1/5 allow, fast 4/5, same call, same minute). The
 * ruling is decidable from the text, so it must not be *asked* of a model at
 * all — the same argument `dangerous-rm` already makes, and the reason this
 * reason is deliberately absent from `CLASSIFIABLE`.
 *
 * The tests below are written as pairs on purpose: each refusal has a positive
 * control on the same rule set showing the ordinary form still passes, because a
 * guard that refused everything would satisfy the refusal half alone.
 */

const ENV = 'MIPHAM_DISABLE_CHMOD_PROMPT'

afterEach(() => {
  delete process.env[ENV]
})

function makeTool(
  name: string,
  permission: ToolDefinition['permission'] = 'ask',
  category: ToolDefinition['category'] = 'exec',
): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    category,
    permission,
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ success: true, content: '' }),
  }
}

const bash = () => makeTool('Bash')
const command = (c: string) => ({ command: c })

const GUARDED = 'chmod -R 777 $DIR'
const ORDINARY = 'chmod -R 777 ./dist'

describe('world-writable chmod guard — outranks what it must', () => {
  it('refuses an unbounded target even when an allow rule matches', () => {
    const ps = new PermissionSystem()
    ps.loadConfig({ allow: ['Bash(*)'] })

    // Positive control on the same rule set: the rule really does grant commands,
    // so what follows is the guard refusing, not the rule failing to match.
    expect(ps.check(bash(), command(ORDINARY))).toBe('bypass')

    expect(ps.check(bash(), command(GUARDED))).toBe('ask')
  })

  it('refuses under bypassPermissions, where no rule and no prompt exists', () => {
    const ps = new PermissionSystem('bypassPermissions')

    expect(ps.check(bash(), command(ORDINARY))).toBe('bypass')
    expect(ps.check(bash(), command(GUARDED))).toBe('ask')
  })

  it('refuses under auto without consulting the classifier', async () => {
    const ps = new PermissionSystem('auto')
    const asked: string[] = []
    ps.setClassifier({
      version: 'test',
      classify: async (req) => {
        asked.push(`${req.tool}:${req.reason}`)
        return { allow: true }
      },
    })

    // Positive control: a call the guard does not cover really does reach the
    // classifier, so "never called" below is a fact about the guard rather than
    // about the classifier being unwired.
    await ps.resolveApproval(bash(), command(ORDINARY))
    expect(asked.length).toBeGreaterThan(0)

    asked.length = 0
    const decision = await ps.resolveApproval(bash(), command(GUARDED))
    expect(decision.level).toBe('ask')
    expect(decision.denialReason).toBe('world-writable-chmod')
    expect(asked).toEqual([])
  })

  it('still reports a human-written deny rule as such', () => {
    const ps = new PermissionSystem()
    ps.loadConfig({ deny: ['Bash(chmod *)'] })

    // Deny rules are checked ahead of the guard, so the operator's own message
    // survives instead of being relabelled.
    expect(ps.explainDenial(bash(), command(GUARDED))).toEqual({
      reason: 'deny-rule',
      rulePattern: 'Bash(chmod *)',
    })
  })

  it('names the offending target in the denial', () => {
    const ps = new PermissionSystem()
    expect(ps.explainDenial(bash(), command('chmod -R 777 /tmp/shared'))).toEqual({
      reason: 'world-writable-chmod',
      target: '/tmp/shared',
    })
  })

  it('leaves every other tool alone', () => {
    const ps = new PermissionSystem()
    // A plain tool-name allow rule: the guard is about a *shell* command line,
    // so a tool that merely happens to take a `command` parameter is none of
    // its business.
    ps.loadConfig({ allow: ['Git'] })
    const git = makeTool('Git')

    expect(ps.check(git, command(GUARDED))).toBe('bypass')
  })

  it('steps aside when the operator sets the escape hatch', () => {
    // Measured under `bypassPermissions` on purpose: that is the one place the
    // guard is the *only* thing refusing, so the hatch is visible. Under an
    // allow rule the rule itself already decides and the hatch would be hidden.
    const ps = new PermissionSystem('bypassPermissions')

    expect(ps.check(bash(), command(GUARDED))).toBe('ask')
    expect(ps.explainDenial(bash(), command(GUARDED)).reason).toBe('world-writable-chmod')

    process.env[ENV] = '1'
    expect(ps.check(bash(), command(GUARDED))).toBe('bypass')

    // Anything other than the exact opt-out value is not an opt-out.
    process.env[ENV] = 'true'
    expect(ps.check(bash(), command('chmod -R o+w $DIR'))).toBe('ask')
  })
})
