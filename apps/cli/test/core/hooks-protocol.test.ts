import { describe, it, expect } from 'vitest'
import { buildHookStdin, parseHookStdout } from '../../src/core/hooks-executor'
import type { HookContext } from '../../src/shared/index.ts'

const preCtx = {
  event: 'PreToolUse',
  toolName: 'Bash',
  toolInput: { command: 'npm test' },
  sessionId: 's1',
} as HookContext

describe('buildHookStdin', () => {
  it('builds the Claude-protocol stdin JSON for a PreToolUse hook', () => {
    const stdin = buildHookStdin(preCtx, '/proj')
    expect(stdin.session_id).toBe('s1')
    expect(stdin.hook_event_name).toBe('PreToolUse')
    expect(stdin.tool_name).toBe('Bash')
    expect(stdin.tool_input).toEqual({ command: 'npm test' })
    expect(stdin.cwd).toBe('/proj')
  })

  it('includes tool_response for PostToolUse events', () => {
    const ctx = {
      event: 'PostToolUse',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      toolResult: { success: true, content: 'a\nb' },
      sessionId: 's2',
    } as HookContext
    const stdin = buildHookStdin(ctx, '/proj')
    expect(stdin.hook_event_name).toBe('PostToolUse')
    expect(stdin.tool_response).toEqual({ success: true, content: 'a\nb' })
  })

  it('omits tool_name/tool_input for non-tool events', () => {
    const ctx = { event: 'Stop', sessionId: 's3' } as HookContext
    const stdin = buildHookStdin(ctx, '/proj')
    expect(stdin.hook_event_name).toBe('Stop')
    expect(stdin.tool_name).toBeUndefined()
    expect(stdin.tool_input).toBeUndefined()
  })
})

describe('parseHookStdout', () => {
  it('deny → allowed:false with reason', () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Destructive command blocked',
      },
    })
    const r = parseHookStdout(stdout, preCtx)
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('Destructive command blocked')
  })

  it('allow + updatedInput → allowed:true with modifiedInput', () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { command: 'npm run lint' },
      },
    })
    const r = parseHookStdout(stdout, preCtx)
    expect(r.allowed).toBe(true)
    expect(r.modifiedInput).toEqual({ command: 'npm run lint' })
  })

  it('legacy decision:block → allowed:false', () => {
    const stdout = JSON.stringify({ decision: 'block', reason: 'Lint failed' })
    const r = parseHookStdout(stdout, preCtx)
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('Lint failed')
  })

  it('continue:false → allowed:false with stopReason', () => {
    const stdout = JSON.stringify({ continue: false, stopReason: 'Not done yet' })
    const r = parseHookStdout(stdout, preCtx)
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('Not done yet')
  })

  it('permissionDecision ask → allowed:true, permissionDecision preserved', () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' },
    })
    const r = parseHookStdout(stdout, preCtx)
    expect(r.allowed).toBe(true)
    expect(r.permissionDecision).toBe('ask')
  })

  it('additionalContext is carried through', () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext: 'extra context here',
      },
    })
    const r = parseHookStdout(stdout, preCtx)
    expect(r.allowed).toBe(true)
    expect(r.additionalContext).toBe('extra context here')
  })

  it('returns allowed:true for empty or non-JSON stdout', () => {
    expect(parseHookStdout('', preCtx).allowed).toBe(true)
    expect(parseHookStdout('not json', preCtx).allowed).toBe(true)
  })
})
