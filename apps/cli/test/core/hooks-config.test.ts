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
})
