import { describe, it, expect } from 'vitest'
import { loadHookConfigs } from '../../src/core/hooks-config'

describe('loadHookConfigs', () => {
  it('loads PreToolUse hooks from settings JSON structure', () => {
    const configs = {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command' as const,
              command: '/usr/bin/block-dangerous.sh',
              args: ['$TOOL_NAME'],
            },
          ],
        },
      ],
    }

    const defs = loadHookConfigs(configs)
    expect(defs).toHaveLength(1)
    expect(defs[0]!.event).toBe('PreToolUse')
    expect(defs[0]!.toolName).toBe('Bash')
  })

  it('loads Stop hooks', () => {
    const configs = {
      Stop: [
        {
          matcher: '',
          hooks: [{ type: 'command' as const, command: 'require-tests-pass.sh' }],
        },
      ],
    }

    const defs = loadHookConfigs(configs)
    expect(defs).toHaveLength(1)
    expect(defs[0]!.event).toBe('Stop')
  })

  it('returns empty array for empty config', () => {
    expect(loadHookConfigs({})).toHaveLength(0)
  })

  it('loads multiple event types simultaneously', () => {
    const configs = {
      PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command' as const, command: 'lint.sh' }] }],
      SessionStart: [
        { matcher: '', hooks: [{ type: 'http' as const, url: 'https://api.example.com/start' }] },
      ],
    }

    const defs = loadHookConfigs(configs)
    expect(defs).toHaveLength(2)
  })

  // A matcher is a filter, so a typo in it must not take the whole hook set down.
  // Both callers register the result in a plain `for…of` (`index.tsx:742`,
  // `daemon/engine-capabilities.ts:104`), so a throw here aborts startup — or the
  // session's entire hook wiring — before a single hook is registered.
  it('a malformed matcher does not take the other hooks with it', async () => {
    const configs = {
      PreToolUse: [
        { matcher: 'Write', hooks: [{ type: 'command' as const, command: 'lint.sh' }] },
        // Unbalanced paren — `new RegExp` throws on this.
        { matcher: 'Bash(', hooks: [{ type: 'command' as const, command: 'guard.sh' }] },
      ],
    }

    const defs = loadHookConfigs(configs)
    // The healthy entry is still there, so nothing was aborted…
    expect(defs).toHaveLength(2)
    expect(defs.some((d) => d.toolName === 'Write')).toBe(true)

    // …and the broken one is loaded rather than dropped. It must now match a tool
    // that its (unusable) pattern would never have selected: the handler reaching
    // the spawn is what proves the matcher no longer filters it out. The command
    // does not exist, so reaching the spawn shows up as `hookError`.
    const broken = defs.find((d) => d.toolName === 'Bash(')!
    const result = await broken.handler({
      event: 'PreToolUse',
      toolName: 'SomethingElse',
      sessionId: 's',
    })
    expect(result.hookError).toBeDefined()
  })
})
