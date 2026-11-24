import { describe, it, expect, vi } from 'vitest'
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

  // `settings.json` 接受这两个事件，但生产代码里**没有任何派发点**（ROADMAP D18：
  // `HookEngine.executeConfigChange` / `executePreInference` 在 `src/` + `bin/` 里零引用）。
  // 注册进去的后果不是「静默不生效」那么轻：`/hooks` 遍历的是配置文件本身，于是用户看到
  // 自己那条 hook 被列出来、计入 `hooks.found N`，读起来是「已安装」，实际一次都不会跑。
  // 装载层只做了一半；另一半在 `ui/commands.ts` 的 `/hooks` —— 它读的是配置文件本身、
  // 不读注册表，故必须用同一个集合给这些条目打标记并排除计数。这里先钉住「不注册 + 说出口」。
  it('does not register events with no dispatch point, and says why', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const defs = loadHookConfigs({
        ConfigChange: [{ matcher: '', hooks: [{ type: 'command' as const, command: 'audit.sh' }] }],
        PreInference: [{ matcher: '', hooks: [{ type: 'command' as const, command: 'dlp.sh' }] }],
        Stop: [
          { matcher: '', hooks: [{ type: 'command' as const, command: 'require-tests-pass.sh' }] },
        ],
      })

      // 只有可派发的那个被注册 —— 另外两个既不在返回里，也不会被 `/hooks` 数进去。
      expect(defs.map((d) => d.event)).toEqual(['Stop'])

      const warnings = write.mock.calls.map((c) => String(c[0])).join('')
      expect(warnings).toContain('ConfigChange')
      expect(warnings).toContain('PreInference')
    } finally {
      write.mockRestore()
    }
  })
})

// CC 2.1.122-017: one group without a `hooks` array used to throw and take the
// entire hook wiring down with it.
describe('malformed hook groups', () => {
  it('skips a group with no hooks array and still loads the rest', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const defs = loadHookConfigs({
      PreToolUse: [
        { matcher: 'Bash' } as never,
        null as never,
        { matcher: 'Edit', hooks: [{ type: 'command' as const, command: 'true' }] },
      ],
    })
    expect(defs).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('has no "hooks" array'))
    warn.mockRestore()
  })
})
