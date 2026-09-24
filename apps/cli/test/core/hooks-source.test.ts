import { describe, it, expect } from 'vitest'
import { HookEngine } from '../../src/core/hooks'
import { executeHook } from '../../src/core/hooks-executor'
import type { HookDefinition } from '../../src/shared/index'

/**
 * A failing hook has to say *whose* it is. Once plugins can register hooks, the
 * operator is no longer the only author of the ones that fire, and a message that
 * names only the command leaves them guessing which plugin to look at.
 *
 * The same identity has to reach the engine's own bookkeeping. Health is tracked
 * per hook, but the key was `event` (or `event:toolName`) — so every hook on the
 * same event shared one failure counter. Five failures from a plugin's broken hook
 * could auto-disable an unrelated hook that had never failed at all.
 */

function failHook(source?: string): HookDefinition {
  return {
    event: 'PreToolUse',
    source,
    handler: async () => {
      throw new Error('handler exploded')
    },
  }
}

describe('a failing hook names the source that declared it', () => {
  it('names the plugin in the failure text of a command hook', async () => {
    const result = await executeHook(
      { type: 'command', command: 'mipham-no-such-binary-xyz' },
      { event: 'PreToolUse', toolName: 'Bash', sessionId: 's' },
      'my-plugin',
    )

    expect(result.additionalContext).toContain('my-plugin')
  })

  it('leaves the text alone for a hook with no source, which is the operator’s own', async () => {
    // The operator's own hooks come from settings and have no plugin to name. The
    // label must not appear as "undefined" — an unattributed hook is not a hook
    // from a plugin called undefined.
    const result = await executeHook(
      { type: 'command', command: 'mipham-no-such-binary-xyz' },
      { event: 'PreToolUse', toolName: 'Bash', sessionId: 's' },
    )

    expect(result.additionalContext).toContain('Hook error')
    expect(result.additionalContext).not.toContain('undefined')
    expect(result.additionalContext).not.toContain('from plugin')
  })
})

describe('health is tracked per hook, not per event', () => {
  it('does not let one source’s failures disable another source’s hook', async () => {
    const engine = new HookEngine()
    engine.register(failHook('broken-plugin'))

    // Past MAX_CONSECUTIVE_FAILURES (5), so the broken hook is auto-disabled. The
    // key was the event alone, so what actually got disabled was the *event*.
    for (let i = 0; i < 6; i++) await engine.executePreToolUse('Bash', {}, 's')

    // Registered only now, and observed only now: a healthy hook that was running
    // alongside the broken one would have kept resetting the shared failure
    // counter, hiding the collision behind its own success.
    let healthyRuns = 0
    engine.register({
      event: 'PreToolUse',
      source: 'working-plugin',
      handler: async () => {
        healthyRuns++
        return { allowed: true }
      },
    })
    await engine.executePreToolUse('Bash', {}, 's')

    expect(healthyRuns).toBe(1)
  })

  it('names the source in the auto-disable notice', async () => {
    const engine = new HookEngine()
    engine.register(failHook('broken-plugin'))
    for (let i = 0; i < 6; i++) await engine.executePreToolUse('Bash', {}, 's')

    const keys = engine.getHookHealth().map((h) => h.key)
    expect(keys.join('\n')).toContain('broken-plugin')
  })

  it('keeps the operator’s own key format unchanged', async () => {
    // `/hooks enable "<key>"` takes these strings, and for a hook with no source
    // they are the same strings they have always been — a plugin-aware key must not
    // renumber the keys of hooks that have no plugin.
    const engine = new HookEngine()
    const failing: HookDefinition = {
      event: 'PreToolUse',
      toolName: 'Bash',
      handler: async () => {
        throw new Error('boom')
      },
    }
    engine.register(failing)
    await engine.executePreToolUse('Bash', {}, 's')

    expect(engine.getHookHealth().map((h) => h.key)).toEqual(['PreToolUse:Bash'])
  })
})

describe('removal is scoped to what asked for it', () => {
  it('unregisters only the named source’s hooks', async () => {
    const engine = new HookEngine()
    let ours = 0
    let theirs = 0
    // plugin-a's hook fails, so that a removal that did not happen leaves a mark in
    // the health table as well as in the run count. A hook that merely succeeded
    // would leave neither — and this test would pass against a no-op.
    engine.register({
      event: 'SessionStart',
      source: 'plugin-a',
      handler: async () => {
        ours++
        throw new Error('gone but not forgotten')
      },
    })
    engine.register({
      event: 'SessionStart',
      source: 'plugin-b',
      handler: async () => {
        theirs++
        return { allowed: true }
      },
    })

    engine.unregisterSource('plugin-a')
    await engine.executeSessionStart('s')

    expect(ours).toBe(0)
    expect(theirs).toBe(1)
    expect(engine.getHookHealth().map((h) => h.key)).not.toContain('plugin-a:SessionStart')
  })
})
