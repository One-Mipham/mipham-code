import { describe, it, expect, vi } from 'vitest'
import type { HookDefinition, HookResult, ToolResult } from '@mipham/shared'
import { HookEngine } from '../../src/core/hooks'
import { loadHookConfigs } from '../../src/core/hooks-config'

// ── Helpers ──

function makeHook(
  event: HookDefinition['event'],
  handler: HookDefinition['handler'],
  toolName?: string,
): HookDefinition {
  return { event, handler, toolName }
}

function makePassHandler(result: Partial<HookResult> = {}): HookDefinition['handler'] {
  return vi.fn().mockResolvedValue({ allowed: true, ...result })
}

function makeDenyHandler(reason = 'blocked'): HookDefinition['handler'] {
  return vi.fn().mockResolvedValue({ allowed: false, reason })
}

function makeResult(success = true, content = 'test output'): ToolResult {
  return { success, content }
}

// ── Tests ──

describe('HookEngine', () => {
  // ═══════════════════════════════════════════
  // Register / List / Unregister
  // ═══════════════════════════════════════════

  it('should register and list hooks', () => {
    const engine = new HookEngine()
    const hook = makeHook('PreToolUse', makePassHandler())

    engine.register(hook)
    expect(engine.listHooks()).toHaveLength(1)
    expect(engine.listHooks()[0]).toBe(hook)
  })

  it('should unregister hooks by event', () => {
    const engine = new HookEngine()
    const hook1 = makeHook('PreToolUse', makePassHandler())
    const hook2 = makeHook('PostToolUse', makePassHandler())

    engine.register(hook1)
    engine.register(hook2)
    engine.unregister('PreToolUse')

    expect(engine.listHooks()).toHaveLength(1)
    expect(engine.listHooks()[0]!.event).toBe('PostToolUse')
  })

  it('should unregister hooks by event and toolName', () => {
    const engine = new HookEngine()
    const hook1 = makeHook('PreToolUse', makePassHandler(), 'read')
    const hook2 = makeHook('PreToolUse', makePassHandler(), 'write')

    engine.register(hook1)
    engine.register(hook2)
    engine.unregister('PreToolUse', 'read')

    expect(engine.listHooks()).toHaveLength(1)
    expect(engine.listHooks()[0]!.toolName).toBe('write')
  })

  it('should return a copy from listHooks', () => {
    const engine = new HookEngine()
    engine.register(makeHook('PreToolUse', makePassHandler()))

    const hooks = engine.listHooks()
    hooks.pop()
    expect(engine.listHooks()).toHaveLength(1)
  })

  // ═══════════════════════════════════════════
  // PreToolUse
  // ═══════════════════════════════════════════

  it('should execute PreToolUse hook and allow', async () => {
    const engine = new HookEngine()
    const handler = makePassHandler()
    engine.register(makeHook('PreToolUse', handler))

    const result = await engine.executePreToolUse('read', { file: 'a.ts' }, 's1')

    expect(result.allowed).toBe(true)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'PreToolUse',
        toolName: 'read',
        toolInput: { file: 'a.ts' },
        sessionId: 's1',
      }),
    )
  })

  it('should execute PreToolUse hook and deny', async () => {
    const engine = new HookEngine()
    const handler = makeDenyHandler('not allowed')
    engine.register(makeHook('PreToolUse', handler))

    const result = await engine.executePreToolUse('dangerous', {}, 's2')

    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('not allowed')
  })

  it('should merge modifiedInput from hook', async () => {
    const engine = new HookEngine()
    const handler = makePassHandler({ modifiedInput: { safe: true } })
    engine.register(makeHook('PreToolUse', handler))

    const result = await engine.executePreToolUse('read', {}, 's1')

    expect(result.allowed).toBe(true)
    expect(result.modifiedInput).toEqual({ safe: true })
  })

  // ═══════════════════════════════════════════
  // PostToolUse
  // ═══════════════════════════════════════════

  it('should execute PostToolUse hook with tool result', async () => {
    const engine = new HookEngine()
    const handler = makePassHandler()
    engine.register(makeHook('PostToolUse', handler))

    const toolResult = makeResult(true, 'file contents')
    const result = await engine.executePostToolUse('read', { file: 'a.ts' }, toolResult, 's1')

    expect(result.allowed).toBe(true)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'PostToolUse',
        toolName: 'read',
        toolResult,
      }),
    )
  })

  it('should deny PostToolUse if hook returns false', async () => {
    const engine = new HookEngine()
    engine.register(makeHook('PostToolUse', makeDenyHandler('post-deny')))

    const result = await engine.executePostToolUse('read', {}, makeResult(), 's1')

    expect(result.allowed).toBe(false)
  })

  // ═══════════════════════════════════════════
  // Session Lifecycle
  // ═══════════════════════════════════════════

  it('should execute SessionStart hook', async () => {
    const engine = new HookEngine()
    const handler = makePassHandler()
    engine.register(makeHook('SessionStart', handler))

    const result = await engine.executeSessionStart('s1')

    expect(result.allowed).toBe(true)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'SessionStart', sessionId: 's1' }),
    )
  })

  it('should execute SessionEnd hook', async () => {
    const engine = new HookEngine()
    const handler = makePassHandler()
    engine.register(makeHook('SessionEnd', handler))

    const result = await engine.executeSessionEnd('s1')

    expect(result.allowed).toBe(true)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'SessionEnd', sessionId: 's1' }),
    )
  })

  it('should execute Notification hook with message in toolInput', async () => {
    const engine = new HookEngine()
    const handler = makePassHandler()
    engine.register(makeHook('Notification', handler))

    const result = await engine.executeNotification('New message', 's1')

    expect(result.allowed).toBe(true)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'Notification',
        toolInput: { message: 'New message' },
      }),
    )
  })

  // ═══════════════════════════════════════════
  // Hook matching
  // ═══════════════════════════════════════════

  it('should only run hooks matching the event', async () => {
    const engine = new HookEngine()
    const preHandler = makePassHandler()
    const postHandler = makePassHandler()

    engine.register(makeHook('PreToolUse', preHandler))
    engine.register(makeHook('PostToolUse', postHandler))

    await engine.executePreToolUse('read', {}, 's1')

    expect(preHandler).toHaveBeenCalled()
    expect(postHandler).not.toHaveBeenCalled()
  })

  it('should only run hooks matching the toolName', async () => {
    const engine = new HookEngine()
    const readHandler = makePassHandler()
    const writeHandler = makePassHandler()

    engine.register(makeHook('PreToolUse', readHandler, 'read'))
    engine.register(makeHook('PreToolUse', writeHandler, 'write'))

    await engine.executePreToolUse('read', {}, 's1')

    expect(readHandler).toHaveBeenCalled()
    expect(writeHandler).not.toHaveBeenCalled()
  })

  it('should run hooks without toolName restriction for any tool', async () => {
    const engine = new HookEngine()
    const globalHandler = makePassHandler()

    engine.register(makeHook('PreToolUse', globalHandler)) // no toolName

    await engine.executePreToolUse('read', {}, 's1')

    expect(globalHandler).toHaveBeenCalled()
  })

  // ═══════════════════════════════════════════
  // Block on first deny
  // ═══════════════════════════════════════════

  it('should stop at first deny and not execute subsequent hooks', async () => {
    const engine = new HookEngine()
    const firstHandler = makeDenyHandler('first denies')
    const secondHandler = makePassHandler()

    engine.register(makeHook('PreToolUse', firstHandler))
    engine.register(makeHook('PreToolUse', secondHandler))

    const result = await engine.executePreToolUse('read', {}, 's1')

    expect(result.allowed).toBe(false)
    expect(firstHandler).toHaveBeenCalled()
    expect(secondHandler).not.toHaveBeenCalled()
  })

  // ═══════════════════════════════════════════
  // Modified input merging across hooks
  // ═══════════════════════════════════════════

  it('should merge modifiedInput from multiple hooks', async () => {
    const engine = new HookEngine()
    const handler1 = makePassHandler({ modifiedInput: { field1: 'a' } })
    const handler2 = makePassHandler({ modifiedInput: { field2: 'b' } })

    engine.register(makeHook('PreToolUse', handler1))
    engine.register(makeHook('PreToolUse', handler2))

    const result = await engine.executePreToolUse('read', {}, 's1')

    expect(result.allowed).toBe(true)
    expect(result.modifiedInput).toEqual({ field1: 'a', field2: 'b' })
  })

  it('should let later hook override earlier modifiedInput keys', async () => {
    const engine = new HookEngine()
    const handler1 = makePassHandler({ modifiedInput: { field: 'old' } })
    const handler2 = makePassHandler({ modifiedInput: { field: 'new' } })

    engine.register(makeHook('PreToolUse', handler1))
    engine.register(makeHook('PreToolUse', handler2))

    const result = await engine.executePreToolUse('read', {}, 's1')

    expect(result.modifiedInput).toEqual({ field: 'new' })
  })

  // ═══════════════════════════════════════════
  // Hook failure tolerance
  // ═══════════════════════════════════════════

  it('should tolerate hook handler throwing and continue', async () => {
    const engine = new HookEngine()
    const badHandler = vi.fn().mockRejectedValue(new Error('boom'))
    const goodHandler = makePassHandler({ modifiedInput: { ok: true } })

    engine.register(makeHook('PreToolUse', badHandler))
    engine.register(makeHook('PreToolUse', goodHandler))

    const result = await engine.executePreToolUse('read', {}, 's1')

    expect(result.allowed).toBe(true)
    expect(result.modifiedInput).toEqual({ ok: true })
  })

  it('should return allowed:true when all hooks throw', async () => {
    const engine = new HookEngine()
    engine.register(makeHook('PreToolUse', vi.fn().mockRejectedValue(new Error('boom'))))

    const result = await engine.executePreToolUse('read', {}, 's1')

    expect(result.allowed).toBe(true)
  })

  // ═══════════════════════════════════════════
  // Edge cases
  // ═══════════════════════════════════════════

  it('should return allowed:true when no hooks registered', async () => {
    const engine = new HookEngine()

    const result = await engine.executePreToolUse('read', {}, 's1')

    expect(result).toEqual({ allowed: true })
  })

  it('should return allowed:true for SessionStart with no hooks', async () => {
    const engine = new HookEngine()
    const result = await engine.executeSessionStart('s1')
    expect(result).toEqual({ allowed: true })
  })

  // ═══════════════════════════════════════════
  // PreInference
  // ═══════════════════════════════════════════

  it('should execute PreInference with messages and tool calls', async () => {
    const engine = new HookEngine()
    const handler = vi.fn().mockResolvedValue({ allowed: true })
    engine.register(makeHook('PreInference', handler))

    const messages = [{ role: 'user', content: 'test' }]
    const toolCalls = [{ name: 'Read', input: { file_path: '/f' }, resultPreview: 'content' }]
    const result = await engine.executePreInference(
      messages,
      toolCalls,
      's1',
      'anthropic',
      'claude-sonnet-5',
    )

    expect(result.allowed).toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)
    const ctx = handler.mock.calls[0]![0]
    expect(ctx.event).toBe('PreInference')
    expect(ctx.messages).toEqual(messages)
    expect(ctx.toolCalls).toEqual(toolCalls)
    expect(ctx.provider).toBe('anthropic')
    expect(ctx.model).toBe('claude-sonnet-5')
  })

  it('should block on PreInference deny', async () => {
    const engine = new HookEngine()
    engine.register(makeHook('PreInference', makeDenyHandler('PII detected')))

    const result = await engine.executePreInference(
      [{ role: 'user', content: 'test' }],
      [],
      's1',
      'a',
      'm',
    )

    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('PII detected')
  })

  it('should return allowed:true when no PreInference hooks registered', async () => {
    const engine = new HookEngine()
    const result = await engine.executePreInference(
      [{ role: 'user', content: 'test' }],
      [],
      's1',
      'a',
      'm',
    )

    expect(result.allowed).toBe(true)
  })

  // ═══════════════════════════════════════════
  // Subagent matchers — the matcher is the agent type
  // ═══════════════════════════════════════════

  describe('subagent event matchers', () => {
    it('runs a SubagentStart hook only for the agent type it matches', async () => {
      const engine = new HookEngine()
      const exploreHandler = makePassHandler()
      const generalHandler = makePassHandler()

      engine.register(makeHook('SubagentStart', exploreHandler, 'Explore'))
      engine.register(makeHook('SubagentStart', generalHandler, 'general'))

      await engine.executeSubagentStart('Explore', 'find the parser', 's1')

      expect(exploreHandler).toHaveBeenCalledTimes(1)
      expect(generalHandler).not.toHaveBeenCalled()
    })

    it('runs a SubagentStop hook only for the agent type it matches', async () => {
      const engine = new HookEngine()
      const exploreHandler = makePassHandler()
      const generalHandler = makePassHandler()

      engine.register(makeHook('SubagentStop', exploreHandler, 'Explore'))
      engine.register(makeHook('SubagentStop', generalHandler, 'general'))

      await engine.executeSubagentStop('general', 'write the doc', 's1', true, 'done')

      expect(generalHandler).toHaveBeenCalledTimes(1)
      expect(exploreHandler).not.toHaveBeenCalled()
    })

    it('honours a regex matcher over agent types', async () => {
      // loadHookConfigs compiles the matcher as a RegExp, so an alternation must
      // select more than one agent type.
      const engine = new HookEngine()
      const handler = makePassHandler()

      engine.register(makeHook('SubagentStart', handler, 'Explore|Plan'))

      await engine.executeSubagentStart('Plan', 'plan the work', 's1')
      expect(handler).toHaveBeenCalledTimes(1)

      await engine.executeSubagentStart('general', 'do the work', 's1')
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('still runs an unrestricted SubagentStart hook for every agent type', async () => {
      const engine = new HookEngine()
      const handler = makePassHandler()

      engine.register(makeHook('SubagentStart', handler)) // no matcher

      await engine.executeSubagentStart('general', 'do the work', 's1')

      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('passes the agent type to the hook as the tool name', async () => {
      const engine = new HookEngine()
      const handler = makePassHandler()

      engine.register(makeHook('SubagentStart', handler))

      await engine.executeSubagentStart('Explore', 'find the parser', 's1')

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'SubagentStart', toolName: 'Explore' }),
      )
    })

    it('filters through the settings.json path, matcher wrapper included', async () => {
      // The real path: loadHookConfigs wraps each hook with the matcher test.
      // A command hook that always exits 2 makes "did it run" observable.
      const engine = new HookEngine()
      const defs = loadHookConfigs({
        SubagentStart: [
          {
            matcher: 'Explore|Plan',
            hooks: [{ type: 'command' as const, command: '/bin/sh', args: ['-c', 'exit 2'] }],
          },
        ],
      })
      expect(defs).toHaveLength(1)
      engine.register(defs[0]!)

      const matched = await engine.executeSubagentStart('Plan', 'plan the work', 's1')
      expect(matched.allowed).toBe(false)

      const unmatched = await engine.executeSubagentStart('general', 'do the work', 's1')
      expect(unmatched.allowed).toBe(true)
    })
  })

  // ═══════════════════════════════════════════
  // Stop hook block signal
  // ═══════════════════════════════════════════

  describe('Stop hook blocking', () => {
    it('surfaces a blocking hook as a block decision', async () => {
      // engine.ts continues the turn on `decision === 'block'`. A hook that says
      // "do not stop" returns allowed:false, so the decision must be derived.
      const engine = new HookEngine()
      engine.register(makeHook('Stop', makeDenyHandler('tests are failing')))

      const result = await engine.executeStop('s1')

      expect(result.decision).toBe('block')
      expect(result.reason).toBe('tests are failing')
    })

    it('leaves a non-blocking Stop hook without a decision', async () => {
      const engine = new HookEngine()
      engine.register(makeHook('Stop', makePassHandler()))

      const result = await engine.executeStop('s1')

      expect(result.decision).toBeUndefined()
      expect(result.allowed).toBe(true)
    })

    it('does not turn a PreToolUse deny into a Stop block', async () => {
      // The decision is a Stop-only signal — a denied tool must not be read as
      // "keep working" by the engine's Stop path.
      const engine = new HookEngine()
      engine.register(makeHook('PreToolUse', makeDenyHandler('no')))

      const result = await engine.executePreToolUse('Bash', {}, 's1')

      expect(result.allowed).toBe(false)
      expect(result.decision).toBeUndefined()
    })
  })

  // ═══════════════════════════════════════════
  // Session cwd
  // ═══════════════════════════════════════════

  describe('session cwd', () => {
    it('stamps the engine cwd onto every hook context', async () => {
      const engine = new HookEngine('/sessions/probe')
      const seen: Array<string | undefined> = []
      engine.register(
        makeHook('PreToolUse', async (c) => {
          seen.push(c.cwd)
          return { allowed: true }
        }),
      )

      await engine.executePreToolUse('Bash', {}, 's1')

      expect(seen).toEqual(['/sessions/probe'])
    })

    it('defaults to this process’ cwd, which is the session cwd for the one-shot CLI', async () => {
      const engine = new HookEngine()
      const seen: Array<string | undefined> = []
      engine.register(
        makeHook('PreToolUse', async (c) => {
          seen.push(c.cwd)
          return { allowed: true }
        }),
      )

      await engine.executePreToolUse('Bash', {}, 's1')

      expect(seen).toEqual([process.cwd()])
    })
  })
})
