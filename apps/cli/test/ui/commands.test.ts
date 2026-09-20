/**
 * Slash Command Tests — bridge commands and forwardToAI mechanism
 *
 * Covers: /code-review, /simplify, /verify, /design, /loop, /goal
 * plus the gitDiffBridgeCmd factory and parseInterval helper.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { formatLoopRows } from '../../src/commands/autoloop-journal'

// ── Mock node:child_process before importing the module under test ──
const mockExecSync = vi.fn()
vi.mock('node:child_process', () => ({ execSync: mockExecSync }))

// ── Mock SessionStore to avoid real on-disk sessions leaking into tests ──
vi.mock('../../src/core/session-store', () => ({
  SessionStore: {
    getLatest: vi.fn(() => null),
    load: vi.fn(() => null),
    list: vi.fn(() => []),
    delete: vi.fn(() => false),
  },
}))

// Dynamic import so the mock takes effect
const commandsModule = await import('../../src/ui/commands')

const { getCommand, getCommandNames, getCommandList, looksLikeSlashCommand, parseSlashCommand } =
  commandsModule as {
    getCommand: (
      name: string,
    ) => ((ctx: unknown, args: string[]) => { content: string; forwardToAI?: string }) | undefined
    getCommandNames: () => string[]
    getCommandList: () => { name: string; description: string }[]
    looksLikeSlashCommand: (input: string) => boolean
    parseSlashCommand: (input: string) => { command: string; args: string[] }
  }

// Minimal CommandContext stub
const mkCtx = (messages: unknown[] = []) =>
  ({
    engine: {
      getTools: () => new Map(),
      getContext: () => ({
        getMessages: () => messages,
        getEstimatedTokens: () => 0,
        getCheckpoints: () => [],
      }),
      getUsageTracker: () => ({ totalApiTokens: 0 }),
      setGoal: vi.fn(),
    },
    config: { providers: {} },
    providerId: 'test',
    modelId: 'test-model',
    version: '0.0.0',
    setSessionTitle: vi.fn(),
    setFastMode: vi.fn(),
    setEffort: vi.fn(),
    setFocusMode: vi.fn(),
    setGoal: vi.fn(),
  }) as unknown as Parameters<NonNullable<ReturnType<typeof getCommand>>>[0]

// ═══════════════════════════════════════════════════════════════
// /cost — prompt-cache line
// ═══════════════════════════════════════════════════════════════

describe('/cost prompt-cache', () => {
  it('shows the prompt-cache line when cache data is available', async () => {
    const ctx = mkCtx()
    ;(ctx as { engine: { getContext: () => unknown } }).engine.getContext = () => ({
      getMessages: () => [],
      getEstimatedTokens: () => 1000,
      getCacheStatus: () => ({ cachedTokens: 400 }),
      getCheckpoints: () => [],
      getMaxTokens: () => 200_000,
    })
    const handler = getCommand('/cost')!
    const result = await handler(ctx, [])
    expect(result.content).toContain('Prompt cache')
    expect(result.content).toContain('400')
    expect(result.content).toContain('40.0')
  })
})

// ═══════════════════════════════════════════════════════════════
// 上下文用量显示 —— 分母必须来自引擎，不得硬编码
// ═══════════════════════════════════════════════════════════════

/**
 * 这批断言用 **1M 窗口** 做输入：硬编码 `200_000` 的实现会同时漏掉
 * `1,000,000` 并印出 `200,000`，故**两个方向都能红**。
 *
 * 引擎侧的真值来自 `ContextManager`：`getMaxTokens()` 是模型注册表里声明的窗口
 * （1M/256K/128K/32K 都有），`getCompactionThreshold()` 是 `max(0.9, 1 − 50000/w)`
 * —— 即 200K/500K→90%、1M→95%。显示与执行是两份数时，「显示面的诚实边界比执行面窄」。
 */
const mkCtxWithWindow = (maxTokens: number, threshold: number, tokens: number) => {
  const ctx = mkCtx()
  const e = ctx as unknown as {
    engine: {
      getContext: () => unknown
      getRegistry: () => undefined
      getUsageTracker: () => unknown
    }
    config: { providers: unknown[] }
  }
  e.engine.getContext = () => ({
    getMessages: () => [],
    getEstimatedTokens: () => tokens,
    getCheckpoints: () => [],
    getSystemPrompt: () => '',
    getCacheStatus: () => ({ cachedTokens: 0 }),
    getMaxTokens: () => maxTokens,
    getCompactionThreshold: () => threshold,
  })
  e.engine.getRegistry = () => undefined
  e.engine.getUsageTracker = () => ({
    getSummary: () => ({ apiInputTokens: 0, apiOutputTokens: 0, tools: {} }),
  })
  e.config.providers = []
  return ctx
}

describe('上下文用量显示跟随引擎的窗口与阈值', () => {
  /**
   * 六个命令**全都**印「已用 / 窗口」两端 ⇒ 断言一律照全套跑。
   *
   * 曾把这份名单按「我以为谁印窗口」手工二分（把 `/stats` 划了出去），结果漏掉了
   * 它的硬编码 —— 那个 `200,000` 不在 `commands.ts` 里，是**抄进 i18n 文案**的
   * （`commands.stats.tokens`）。**手工维护的豁免名单就是下一处漏网**，故不设名单。
   */
  const CMDS = ['/context', '/status', '/cost', '/usage', '/doctor', '/stats']

  const run = (cmd: string) => getCommand(cmd)!(mkCtxWithWindow(1_000_000, 0.95, 100_000), [])

  it.each(CMDS)('%s 的分母是引擎窗口（1M），不是写死的 200,000', async (cmd) => {
    const { content } = await run(cmd)
    expect(content).toContain('1,000,000')
    expect(content).not.toContain('200,000')
  })

  // `/status` 只印窗口两端、不印百分比，故单列。
  it.each(CMDS.filter((c) => c !== '/status'))(
    '%s 的百分比按引擎窗口算（100K / 1M ⇒ 10.0%，非写死的 50.0%）',
    async (cmd) => {
      const { content } = await run(cmd)
      expect(content).toContain('10.0')
      expect(content).not.toContain('50.0')
    },
  )

  it('/context 的压缩点取自引擎阈值（1M ⇒ 95%），不是写死的 90%', async () => {
    const { content } = await run('/context')
    expect(content).toContain('95%')
    expect(content).toContain('950,000')
    expect(content).not.toContain('180,000')
  })
})

// ═══════════════════════════════════════════════════════════════
// /mcp connect — HTTP disclosure
// ═══════════════════════════════════════════════════════════════

describe('/mcp connect disclosure', () => {
  it('shows URL and header keys (not values) for an HTTP server', async () => {
    const ctx = mkCtx()
    ;(ctx as { config: Record<string, unknown> }).config = {
      skills: {
        mcpServers: [
          {
            name: 'myserver',
            url: 'https://evil.example.com/mcp',
            headers: { Authorization: 'Bearer supersecret' },
          },
        ],
      },
    }
    const handler = getCommand('/mcp')!
    const result = await handler(ctx, ['connect', 'myserver'])
    expect(result.content).toContain('https://evil.example.com/mcp')
    expect(result.content).toContain('Authorization')
    expect(result.content).not.toContain('supersecret')
  })
})

// ═══════════════════════════════════════════════════════════════
// /mcp reconnect — the recovery path for a lost connection
// ═══════════════════════════════════════════════════════════════

describe('/mcp reconnect', () => {
  // Imported lazily: importing the client statically would be hoisted above
  // `mockExecSync`, and the node:child_process mock factory would run too early.
  const loadClient = async () => (await import('../../src/mcp/client')).McpClient

  it('routes to McpClient.reconnect rather than the status listing', async () => {
    const client = (await loadClient()).getInstance()
    const spy = vi.spyOn(client, 'reconnect').mockResolvedValue(undefined)
    try {
      const result = await getCommand('/mcp')!(mkCtx(), ['reconnect', 'myserver'])

      expect(spy).toHaveBeenCalledWith('myserver')
      expect(result.content).toContain('myserver')
    } finally {
      spy.mockRestore()
    }
  })

  it('reports a failed reconnect instead of throwing', async () => {
    const client = (await loadClient()).getInstance()
    const spy = vi.spyOn(client, 'reconnect').mockRejectedValue(new Error('no such server'))
    try {
      const result = await getCommand('/mcp')!(mkCtx(), ['reconnect', 'ghost'])

      expect(result.content).toContain('ghost')
      expect(result.content).toMatch(/no such server|failed/i)
    } finally {
      spy.mockRestore()
    }
  })

  it('asks for a server name when none is given', async () => {
    const result = await getCommand('/mcp')!(mkCtx(), ['reconnect'])

    expect(result.content).toMatch(/usage/i)
  })
})

// ═══════════════════════════════════════════════════════════════
// Registry — all four bridge commands are registered
// ═══════════════════════════════════════════════════════════════

describe('slash command registry', () => {
  it('registers /code-review', () => {
    expect(getCommand('/code-review')).toBeDefined()
  })

  it('registers /simplify', () => {
    expect(getCommand('/simplify')).toBeDefined()
  })

  it('registers /verify', () => {
    expect(getCommand('/verify')).toBeDefined()
  })

  it('registers /design', () => {
    expect(getCommand('/design')).toBeDefined()
  })

  it('registers /loop', () => {
    expect(getCommand('/loop')).toBeDefined()
  })

  it('registers /goal', () => {
    expect(getCommand('/goal')).toBeDefined()
  })

  it('all four bridge commands appear in getCommandNames()', () => {
    const names = getCommandNames()
    expect(names).toContain('/code-review')
    expect(names).toContain('/simplify')
    expect(names).toContain('/verify')
    expect(names).toContain('/design')
  })

  it('all four bridge commands have descriptions', () => {
    const list = getCommandList()
    const byName = Object.fromEntries(list.map((e) => [e.name, e.description]))
    expect(byName['/code-review']).toBeTruthy()
    expect(byName['/simplify']).toBeTruthy()
    expect(byName['/verify']).toBeTruthy()
    expect(byName['/design']).toBeTruthy()
  })
})

// ═══════════════════════════════════════════════════════════════
// /code-review, /simplify, /verify — gitDiffBridgeCmd factory
// ═══════════════════════════════════════════════════════════════

describe('git-diff bridge commands (/code-review, /simplify, /verify)', () => {
  const bridgeCommands = ['/code-review', '/simplify', '/verify'] as const

  for (const cmd of bridgeCommands) {
    describe(cmd, () => {
      it('returns forwardToAI when git diff has changes', async () => {
        mockExecSync.mockReturnValue(
          ' file.ts | 5 +++--\n 1 file changed, 3 insertions(+), 2 deletions(-)',
        )
        const handler = getCommand(cmd)!
        const result = await handler(mkCtx(), [])
        expect(result.forwardToAI).toBeDefined()
        expect(result.forwardToAI!.length).toBeGreaterThan(50)
        expect(result.content).toContain('Changed files:')
      })

      it('does NOT return forwardToAI when there are no changes', async () => {
        mockExecSync.mockReturnValue('')
        const handler = getCommand(cmd)!
        const result = await handler(mkCtx(), [])
        expect(result.forwardToAI).toBeUndefined()
        expect(result.content).toContain('No uncommitted changes')
      })

      it('does NOT return forwardToAI on git error', async () => {
        mockExecSync.mockImplementation(() => {
          throw new Error('not a git repository')
        })
        const handler = getCommand(cmd)!
        const result = await handler(mkCtx(), [])
        expect(result.forwardToAI).toBeUndefined()
        expect(result.content).toContain('git repository')
      })
    })
  }
})

// ═══════════════════════════════════════════════════════════════
// /design — no git dependency, always forwards
// ═══════════════════════════════════════════════════════════════

describe('/design', () => {
  it('always returns forwardToAI (no git check)', async () => {
    const handler = getCommand('/design')!
    const result = await handler(mkCtx(), [])
    expect(result.forwardToAI).toBeDefined()
    expect(result.forwardToAI).toContain('design the architecture')
  })

  it('includes the topic in forwardToAI when args are provided', async () => {
    const handler = getCommand('/design')!
    const result = await handler(mkCtx(), ['the', 'auth', 'module'])
    expect(result.forwardToAI).toContain('the auth module')
  })

  it('uses default topic when no args', async () => {
    const handler = getCommand('/design')!
    const result = await handler(mkCtx(), [])
    expect(result.forwardToAI).toContain('the current task')
  })

  it('is synchronous (no async keyword)', () => {
    const handler = getCommand('/design')!
    const result = handler(mkCtx(), ['test'])
    // If it were async, result would be a Promise; synchronous returns the object directly
    expect(result).toHaveProperty('content')
    expect(result).toHaveProperty('forwardToAI')
  })
})

// ═══════════════════════════════════════════════════════════════
// /save — bridge to the save-to-wiki skill
// ═══════════════════════════════════════════════════════════════

describe('/save', () => {
  it('registers /save', () => {
    expect(getCommand('/save')).toBeDefined()
  })

  it('always returns forwardToAI that names the save-to-wiki skill', async () => {
    const handler = getCommand('/save')!
    const result = await handler(mkCtx(), [])
    expect(result.forwardToAI).toBeDefined()
    expect(result.forwardToAI).toContain('save-to-wiki')
  })

  it('passes an explicit type/title override through to forwardToAI', async () => {
    const handler = getCommand('/save')!
    const result = await handler(mkCtx(), ['concept', 'module-boundaries'])
    expect(result.forwardToAI).toContain('concept module-boundaries')
  })

  it('has no override when called without args', async () => {
    const handler = getCommand('/save')!
    const result = await handler(mkCtx(), [])
    expect(result.forwardToAI).not.toContain('User override')
  })

  it('shows a content message', async () => {
    const handler = getCommand('/save')!
    const result = await handler(mkCtx(), [])
    expect(result.content).toContain('Save to Wiki')
  })

  it('has a description in getCommandList()', () => {
    const list = getCommandList()
    const byName = Object.fromEntries(list.map((e) => [e.name, e.description]))
    expect(byName['/save']).toBeTruthy()
  })
})

// ═══════════════════════════════════════════════════════════════
// /loop
// ═══════════════════════════════════════════════════════════════

describe('/loop', () => {
  it('shows usage when fewer than 2 args', async () => {
    const handler = getCommand('/loop')!
    const result = await handler(mkCtx(), ['5m'])
    expect(result.forwardToAI).toBeUndefined()
    expect(result.content).toContain('Usage')
  })

  it('auto-starts autonomous loop when interval is not recognised', async () => {
    const handler = getCommand('/loop')!
    const result = await handler(mkCtx(), ['xyz', 'do something'])
    // 'xyz' is not a valid interval — auto-detected as autonomous mode
    expect(result.content).toContain('Autonomous Loop')
    expect(result.forwardToAI).toBeDefined()
  })

  it('schedules via ScheduleWakeup for valid interval', async () => {
    const handler = getCommand('/loop')!
    const result = await handler(mkCtx(), ['5m', 'check deploy'])
    // Now directly invokes ScheduleWakeup, returns content (not forwardToAI)
    expect(result.content).toBeDefined()
    expect(result.content).toContain('5m')
    expect(result.content).toContain('check deploy')
  })

  it('parses seconds correctly', async () => {
    const handler = getCommand('/loop')!
    const result = await handler(mkCtx(), ['2m', 'ping']) // 120s — within [60,3600]
    expect(result.content).toContain('2m')
    expect(result.content).toContain('ping')
  })

  it('parses hours correctly', async () => {
    const handler = getCommand('/loop')!
    const result = await handler(mkCtx(), ['30min', 'full audit']) // 1800s — within [60,3600]
    expect(result.content).toContain('30m')
    expect(result.content).toContain('full audit')
  })

  it('parses alternate formats (min, sec, hr)', async () => {
    const handler = getCommand('/loop')!
    const r1 = await handler(mkCtx(), ['10sec', 'a'])
    expect(r1.content).toContain('a') // prompt is included
    const r2 = await handler(mkCtx(), ['3min', 'b'])
    expect(r2.content).toContain('b')
    const r3 = await handler(mkCtx(), ['1hr', 'c'])
    expect(r3.content).toContain('c')
  })
})

// ═══════════════════════════════════════════════════════════════
// /goal
// ═══════════════════════════════════════════════════════════════

describe('/goal', () => {
  it('shows usage when no args', () => {
    const handler = getCommand('/goal')!
    const result = handler(mkCtx(), [])
    expect(result.content).toContain('Usage')
  })

  it('sets goal when text provided', () => {
    const ctx = mkCtx()
    const handler = getCommand('/goal')!
    const result = handler(ctx, ['Fix', 'all', 'TypeScript', 'errors'])
    expect(result.content).toContain('✓ Goal set')
    expect(result.content).toContain('Fix all TypeScript errors')
  })
})

// ═══════════════════════════════════════════════════════════════
// /tasks — 任务工具历史扫描（/todos 是转交 AI 的旧版入口，不扫历史）
// ═══════════════════════════════════════════════════════════════

/** 造一条带 tool_use 块的助手消息。 */
const toolUseMessage = (name: string) => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'tu_1', name, input: {} }],
})

describe('/tasks', () => {
  it('识别历史里真实的 Task 工具调用', () => {
    const handler = getCommand('/tasks')!
    const withTask = handler(mkCtx([toolUseMessage('Task')]), []).content
    const withoutTask = handler(mkCtx([]), []).content
    // 修复前过滤条件找的是一组不存在的工具名，故两种情况渲染结果相同（永远是「无任务」）
    expect(withTask).not.toBe(withoutTask)
  })

  it('其他工具的调用不算任务操作', () => {
    const handler = getCommand('/tasks')!
    const withBash = handler(mkCtx([toolUseMessage('Bash')]), []).content
    const withoutTask = handler(mkCtx([]), []).content
    expect(withBash).toBe(withoutTask)
  })

  it('非数组 content 的历史消息不会导致崩溃', () => {
    const handler = getCommand('/tasks')!
    const textOnly = handler(mkCtx([{ role: 'user', content: 'hello' }]), []).content
    expect(textOnly).toBe(handler(mkCtx([]), []).content)
  })
})

describe('/todos forwardToAI 指向真实工具', () => {
  it('create 转交的提示词使用 Task 工具与 action 参数', () => {
    const result = getCommand('/todos')!(mkCtx(), ['create', 'Add', 'auth']) as {
      forwardToAI?: string
    }
    expect(result.forwardToAI).toContain('Task')
    expect(result.forwardToAI).toContain('"create"')
  })

  it('list 转交的提示词使用 Task 工具与 action 参数', () => {
    const result = getCommand('/todos')!(mkCtx(), ['list']) as { forwardToAI?: string }
    expect(result.forwardToAI).toContain('Task')
    expect(result.forwardToAI).toContain('"list"')
  })
})

describe('/goal --decompose 指向真实工具', () => {
  it('拆解提示词使用 Task 工具与 action 参数', () => {
    const ctx = mkCtx()
    const result = getCommand('/goal')!(ctx, ['Ship', 'it', '--decompose']) as {
      forwardToAI?: string
    }
    expect(result.forwardToAI).toContain('Task')
    expect(result.forwardToAI).toContain('"create"')
  })
})

// ═══════════════════════════════════════════════════════════════
// Public API helpers
// ═══════════════════════════════════════════════════════════════
describe('slash command public API', () => {
  it('looksLikeSlashCommand detects slash-prefixed input', () => {
    expect(looksLikeSlashCommand('/help')).toBe(true)
    expect(looksLikeSlashCommand('hello')).toBe(false)
    expect(looksLikeSlashCommand(' /help')).toBe(true)
  })

  it('parseSlashCommand splits command and args', () => {
    expect(parseSlashCommand('/code-review')).toEqual({
      command: '/code-review',
      args: [],
    })
    expect(parseSlashCommand('/design auth module')).toEqual({
      command: '/design',
      args: ['auth', 'module'],
    })
  })

  it('getCommand returns undefined for unknown commands', () => {
    expect(getCommand('/nonexistent-command-xyz')).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════
// /resume, /resume last, /resume delete (Task 2.2)
// ═══════════════════════════════════════════════════════════════

describe('/resume commands (Task 2.2)', () => {
  it('registers /resume', () => {
    expect(getCommand('/resume')).toBeDefined()
  })

  it('registers /resume last', () => {
    expect(getCommand('/resume last')).toBeDefined()
  })

  it('registers /resume delete', () => {
    expect(getCommand('/resume delete')).toBeDefined()
  })

  it('all three resume commands appear in getCommandNames()', () => {
    const names = getCommandNames()
    expect(names).toContain('/resume')
    expect(names).toContain('/resume last')
    expect(names).toContain('/resume delete')
  })

  it('all three resume commands have descriptions', () => {
    const list = getCommandList()
    const byName: Record<string, string> = {}
    for (const e of list) {
      byName[e.name] = e.description
    }
    expect(byName['/resume']).toBeTruthy()
    expect(byName['/resume last']).toBeTruthy()
    expect(byName['/resume delete']).toBeTruthy()
  })

  it('/resume handles "last" sub-command', async () => {
    const handler = getCommand('/resume')!
    const result = await handler(mkCtx(), ['last'])
    // Without actual SessionStore data, should return "no saved sessions"
    expect(result.content).toContain('No saved sessions')
  })

  it('/resume handles "delete" sub-command', async () => {
    const handler = getCommand('/resume')!
    const result = await handler(mkCtx(), ['delete'])
    // Without a name arg, should show usage
    expect(result.content).toContain('Usage')
    expect(result.content).toContain('/resume delete')
  })

  it('/resume delete requires a session name', async () => {
    const handler = getCommand('/resume')!
    const result = await handler(mkCtx(), ['delete', 'nonexistent-session'])
    // Session doesn't exist, so it won't delete
    expect(result.content).toContain('not found')
  })

  it('/resume last standalone handler returns no-sessions message', async () => {
    const handler = getCommand('/resume last')!
    const result = await handler(mkCtx(), [])
    expect(result.content).toContain('No saved sessions')
  })

  it('/resume delete standalone handler shows usage without name', async () => {
    const handler = getCommand('/resume delete')!
    const result = await handler(mkCtx(), [])
    expect(result.content).toContain('Usage')
  })
})

// ═══════════════════════════════════════════════════════════════
// /usage Loops section (formatLoopRows)
// ═══════════════════════════════════════════════════════════════

describe('formatLoopRows', () => {
  it('formatLoopRows shows iterations/totalTokens/tokensPerRun/lastRun', () => {
    const rows = formatLoopRows([
      {
        sessionId: 's1',
        prompt: 'monitor CI',
        status: 'active',
        iterations: 4,
        startedAt: new Date().toISOString(),
        logs: [],
        totalTokens: 800,
        maxIterations: 100,
      },
    ])
    expect(rows[0]).toContain('4 iterations')
    expect(rows[0]).toContain('800 tokens')
    expect(rows[0]).toContain('200 /run')
  })
})

// ═══════════════════════════════════════════════════════════════
// /upgrade — registry 够不着时不得说成「已是最新」
// ═══════════════════════════════════════════════════════════════

describe('/upgrade when the registry cannot be reached', () => {
  it('says the check failed, instead of "Already up to date"', async () => {
    // 走**真实链路**，不 mock 自家模块：execSync('npm view …') 三次尝试全抛
    // ⇒ fetchLatestVersion 抛 ⇒ checkForUpdates 的 catch ⇒ checked: false。
    // 缺陷原形：`available: false` 被当成「查过且是最新」，于是离线时印
    // 「✓ Already up to date (vX → vX)」，连「查过一次」都没有透露。
    const { getCurrentVersion } = await import('../../src/shared/update')
    mockExecSync.mockImplementation(() => {
      throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org')
    })
    const handler = getCommand('/upgrade')!
    const result = await handler(mkCtx(), [])
    expect(result.content).toContain('Could not reach the npm registry')
    // 负控：删掉 `if (!update.checked)` 那段早期 return，本行即红。
    expect(result.content).not.toContain('Already up to date')
    // {current} 必须真填进去（t() 把没给的占位符换成空串，不会报错）
    expect(result.content).toContain(getCurrentVersion())
  })

  it('still says "Already up to date" when the check really succeeded', async () => {
    const { getCurrentVersion } = await import('../../src/shared/update')
    // 判别力的另一半：不能连「查过了、确实是最新」也一起吞掉 ——
    // 若把判据写成「拿不到新版就报查不到」，这条会红。
    mockExecSync.mockReturnValue(`"${getCurrentVersion()}"`)
    const handler = getCommand('/upgrade')!
    const result = await handler(mkCtx(), [])
    expect(result.content).toContain('Already up to date')
    expect(result.content).not.toContain('Could not reach')
  })
})

// ═══════════════════════════════════════════════════════════════
// /crsi propose --prose —— ε 的**登记侧**必须与**判定侧**相遇
// ═══════════════════════════════════════════════════════════════

/**
 * 缺陷原形：`measureSkillDeltaRepeated` 全仓库只有手工路径一个调用点，四条 producer 路径
 * 调完 `runCrsiModification` 就返回 ⇒ ε 曾在一个流程登记、判定侧在另一个流程，两端永不相遇。
 * 因此「整段测量被删掉」原本是**全绿**的 —— 本文件就是补上那道覆盖。
 *
 * **不 mock 被测对象**：`buildImprovementReport` 取真身（它才是把 ε 带进记录的那一环，
 * 对它做断言等于断言自己的桩）。只 mock「刻意不测的东西」：LLM 生成提议、以及
 * `runCrsiModification` 的真 worktree + 全量测试开销，外加两个**会写真实 home 目录**的落盘函数。
 *
 * ⚠️ `hasPending()` 是 handler 的第一行，读**真实磁盘状态**：本机若存有待批准提案，handler
 * 会提前返回，本文件就**静默地什么都没断言**。故它必须被钉成 false。
 */
const h = vi.hoisted(() => ({
  measure: vi.fn(),
  appendImprovement: vi.fn(),
  setPendingVerdict: vi.fn(),
  appendProseProposal: vi.fn(),
  runCrsiModification: vi.fn(),
  hasPending: vi.fn(() => false),
  produceProseProposal: vi.fn(),
  collectSkillFiles: vi.fn(),
  selectCrsiSignal: vi.fn(),
  proseProposalId: vi.fn(() => 'prose-id-1'),
  hasProposedProse: vi.fn(() => false),
  prefilterProposal: vi.fn(() => ({ pass: true, reasons: [] })),
}))

vi.mock('../../src/core/crsi-modify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/crsi-modify')>()),
  hasPending: h.hasPending,
  runCrsiModification: h.runCrsiModification,
}))

vi.mock('../../src/core/crsi-producer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/crsi-producer')>()),
  produceProseProposal: h.produceProseProposal,
  collectSkillFiles: h.collectSkillFiles,
  selectCrsiSignal: h.selectCrsiSignal,
  proseProposalId: h.proseProposalId,
  hasProposedProse: h.hasProposedProse,
  appendProseProposal: h.appendProseProposal,
}))

vi.mock('../../src/core/proposal-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/proposal-guard')>()),
  prefilterProposal: h.prefilterProposal,
}))

vi.mock('../../src/core/task-performance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/task-performance')>()),
  measureSkillDeltaRepeated: h.measure,
}))

vi.mock('../../src/core/improvement-track', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/improvement-track')>()),
  appendImprovement: h.appendImprovement,
  setPendingVerdict: h.setPendingVerdict,
}))

const PROSE_FILE = 'apps/cli/skills/research/SKILL.md'

const PROSE_PROPOSAL = {
  filePath: PROSE_FILE,
  newContent: '---\nname: research\n---\n\n新正文\n',
  originalContent: '---\nname: research\n---\n\n旧正文\n',
  description: '把这条教训写进 skill 散文',
  expectedEffect: 7,
  risk: '可能让 skill 变长',
}

/**
 * deltaMean = mean([57,57,57]) − mean([50,50,50]) = **7.0**，与 ε 相等。
 * 取这个数是为了让 `predictionHit(7, 7.0)` 落在判据的**边界上**（`>=` 为真、`>` 为假），
 * 且它由真身 `buildImprovementReport` 算出，不是我们写死的判定结果。
 */
const SAMPLE = { skillName: 'research', baselineScores: [50, 50, 50], postScores: [57, 57, 57] }

const mkProseCtx = () => {
  const ctx = mkCtx()
  ;(ctx as unknown as { engine: Record<string, unknown> }).engine.getLlm = () => ({})
  return ctx
}

beforeEach(() => {
  h.hasPending.mockReturnValue(false)
  h.measure.mockResolvedValue(SAMPLE)
  h.runCrsiModification.mockResolvedValue({ applied: true, phase: 'done', diff: 'DIFF' })
  h.produceProseProposal.mockResolvedValue(PROSE_PROPOSAL)
  h.collectSkillFiles.mockReturnValue([PROSE_FILE])
  h.selectCrsiSignal.mockReturnValue({
    category: 'c',
    title: 't',
    suggestion: 's',
    evidence: ['e'],
  })
  h.proseProposalId.mockReturnValue('prose-id-1')
  h.hasProposedProse.mockReturnValue(false)
  h.prefilterProposal.mockReturnValue({ pass: true, reasons: [] })
  h.appendProseProposal.mockReturnValue(undefined)
  h.appendImprovement.mockReturnValue(undefined)
  h.setPendingVerdict.mockReturnValue(undefined)
})

describe('/crsi propose --prose 把 ε 送进判定侧', () => {
  // 负控 N-A（删掉整段测量）：本条与下一条**同时**红。
  it('成功提案之后真的跑了测量（用的是这份提议的路径与内容）', async () => {
    const handler = getCommand('/crsi propose')!
    const result = await handler(mkProseCtx(), ['--prose'])

    // 先钉住「走到了测量那一步」—— 否则 handler 一旦提前返回，下面几条会以
    // 「mock 没被调用」的形式红，读起来像是测量写错了。
    expect(result.content).toContain('✅ 已生成散文提议并跑过测试')
    expect(h.measure).toHaveBeenCalledWith(expect.anything(), {
      filePath: PROSE_PROPOSAL.filePath,
      originalContent: PROSE_PROPOSAL.originalContent,
      newContent: PROSE_PROPOSAL.newContent,
    })
    expect(h.setPendingVerdict).toHaveBeenCalled()
  })

  // 负控 N-B（第三个实参改传 undefined）：**只有**本条红 —— 这才证明「登记过的那个 ε」
  // 本身在旅行，而不只是「有东西被测量了」。
  it('进台账的那条记录带的是登记过的那一个 ε，且判定已经算出', async () => {
    const handler = getCommand('/crsi propose')!
    const result = await handler(mkProseCtx(), ['--prose'])

    const record = h.appendImprovement.mock.calls[0]?.[0] as {
      predictedDelta?: number
      predictionHit?: boolean
      changeSet?: string[]
    }
    expect(record.predictedDelta).toBe(7)
    expect(record.predictionHit).toBe(true)
    expect(record.changeSet).toEqual([PROSE_PROPOSAL.filePath])
    expect(result.content).toContain('🎯 ε 预测命中: 命中 ✅')
  })
})
