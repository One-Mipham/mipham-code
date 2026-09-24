import { afterEach, describe, it, expect } from 'vitest'
import type { ToolDefinition } from '../../src/shared'
import { PermissionSystem } from '../../src/core/permission'

/**
 * A recursive `rm` whose target is not a path written in the command cannot be
 * bounded by anything that reasons *about* the command — not an allow rule, not
 * `auto`'s classifier, not `bypassPermissions`. All three read the text and
 * conclude "this deletes something named here"; the text is exactly what is
 * missing.
 *
 * So the guard has to sit **ahead of the allow rules** rather than inside them.
 * The tests below are written as pairs on purpose: each refusal test has a
 * positive control on the same rule set showing that ordinary `rm` still passes,
 * because a guard that refuses everything would satisfy the refusal half alone.
 */

const ENV = 'MIPHAM_DISABLE_DANGEROUS_RM_PROMPT'

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

describe('dangerous-rm guard — outranks what it must', () => {
  it('refuses a substitution target even when an allow rule matches', () => {
    // `Bash(*)`, not `Bash(rm *)`. An allow rule is a grant and is judged with
    // `segmentMode: 'all'` against every flattened segment — so `Bash(rm *)` never
    // covered a substitution command in the first place (`pwd` is a segment too),
    // and using it here would leave this test green with the guard deleted.
    const ps = new PermissionSystem()
    ps.loadConfig({ allow: ['Bash(*)'] })

    // Positive control on the same rule set: the rule really does grant commands,
    // so what follows is the guard refusing, not the rule failing to match.
    expect(ps.check(bash(), command('rm -rf node_modules'))).toBe('bypass')

    expect(ps.check(bash(), command('rm -rf "$(pwd)"'))).toBe('ask')
  })

  it('refuses under bypassPermissions, where no rule and no prompt exists', () => {
    const ps = new PermissionSystem('bypassPermissions')

    expect(ps.check(bash(), command('rm -rf node_modules'))).toBe('bypass')
    expect(ps.check(bash(), command('rm -rf $PWD'))).toBe('ask')
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

    // Positive control: an ordinary command in auto mode really does reach the
    // classifier, so "never called" below is a fact about the guard, not about
    // the classifier being unwired.
    await ps.resolveApproval(bash(), command('rm -rf node_modules'))
    expect(asked.length).toBeGreaterThan(0)

    asked.length = 0
    const decision = await ps.resolveApproval(bash(), command('rm -rf "$(pwd)"'))
    expect(decision.level).toBe('ask')
    expect(decision.denialReason).toBe('dangerous-rm')
    expect(asked).toEqual([])
  })

  it('still reports a human-written deny rule as such', () => {
    const ps = new PermissionSystem()
    ps.loadConfig({ deny: ['Bash(rm *)'] })

    // Deny rules are checked ahead of the guard, so the operator's own message
    // survives instead of being relabelled.
    expect(ps.explainDenial(bash(), command('rm -rf "$(pwd)"'))).toEqual({
      reason: 'deny-rule',
      rulePattern: 'Bash(rm *)',
    })
  })

  it('names the offending target in the denial', () => {
    const ps = new PermissionSystem()
    expect(ps.explainDenial(bash(), command('rm -rf "$(pwd)"'))).toEqual({
      reason: 'dangerous-rm',
      target: '$(pwd)',
    })
  })

  it('leaves every other tool alone', () => {
    const ps = new PermissionSystem()
    // A plain tool-name allow rule: the guard is about a *shell* command line, so
    // a tool that merely happens to take a `command` parameter is none of its
    // business.
    ps.loadConfig({ allow: ['Git'] })
    const git = makeTool('Git')

    expect(ps.check(git, command('rm -rf "$(pwd)"'))).toBe('bypass')
  })

  it('steps aside when the operator sets the escape hatch', () => {
    // Measured under `bypassPermissions` on purpose. An allow rule cannot show
    // this: `Bash(rm *)` is a *grant*, so it is judged with `segmentMode: 'all'`
    // and `flattenCommand` exposes the substitution's own inner segment (`pwd`),
    // which no `rm *` matches — the rule never covers such a command, hatch or no
    // hatch. Where the guard is the *only* thing refusing, the hatch is visible.
    const ps = new PermissionSystem('bypassPermissions')

    expect(ps.check(bash(), command('rm -rf "$(pwd)"'))).toBe('ask')
    expect(ps.explainDenial(bash(), command('rm -rf "$(pwd)"')).reason).toBe('dangerous-rm')

    process.env[ENV] = '1'
    expect(ps.check(bash(), command('rm -rf "$(pwd)"'))).toBe('bypass')

    // Anything other than the exact opt-out value is not an opt-out.
    process.env[ENV] = 'true'
    expect(ps.check(bash(), command('rm -rf ${PWD}'))).toBe('ask')
  })
})
