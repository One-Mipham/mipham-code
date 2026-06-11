import { describe, it, expect, vi } from 'vitest'
import type { HookDefinition, HookResult, ToolResult } from '@mipham/shared'
import { HookEngine } from '../../src/core/hooks'

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
})
