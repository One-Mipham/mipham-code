/**
 * Slash Command Tests — bridge commands and forwardToAI mechanism
 *
 * Covers: /code-review, /simplify, /verify, /design, /loop, /goal
 * plus the gitDiffBridgeCmd factory and parseInterval helper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { formatLoopRows } from '../../src/commands/autoloop-journal'
import { extractCrsiLessonSummaries, selectResidentLessons } from '../../src/core/crsi-producer'
import { initTelemetry, resetTelemetryState } from '../../src/telemetry/index'
import { resetCrashState } from '../../src/telemetry/crash'
import { getTasks, taskTool } from '../../src/tools/exec/task'

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
      // The permission system the reports read their mode from. A stub that
      // omits it only fails once a command reads it — "the method is missing"
      // is luck, not a design.
      getPermission: () => ({ getMode: () => 'default' as const }),
      setGoal: vi.fn(),
    },
    // An array, as in a real context: `/status` and `/doctor` count providers.
    config: { providers: [] },
    providerId: 'test',
    modelId: 'test-model',
    version: '0.0.0',
    setSessionTitle: vi.fn(),
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
// /crsi lessons —— 常驻档名册（selectResidentLessons 唯一给人看的读者）
//
// 这一族的病根是「有定义、无施加点」：函数写好了、没人调用。所以这里钉的是
// **施加点本身** —— 注册了没有、跑起来读的是不是真账本、跑完有没有改到东西。
// ═══════════════════════════════════════════════════════════════

describe('/crsi lessons（常驻档名册）', () => {
  const CLI_DIR = join(import.meta.dirname, '..', '..')
  const LESSONS = join(CLI_DIR, 'crsi-lessons.md')
  /**
   * 处理器拼的是 `join(git 根, LESSONS_FILE)`，而 `LESSONS_FILE` 是**仓库根相对**的
   * `apps/cli/crsi-lessons.md`（`src/core/crsi-producer.ts:22`）。夹具要造的正是这个后缀。
   */
  const IN_ROOT = join('apps', 'cli', 'crsi-lessons.md')

  let gitRoot: string | undefined

  // 本文件的 `execSync` 是 `vi.fn()`（默认返回 undefined）⇒ 处理器里的 git 分支会抛、
  // 被 try/catch 吃掉、回退到 cwd ⇒ 找不到账本。要跑到**真账本的内容**，就得让这个 mock
  // 给出一个「拼得上」的根。
  //
  // 不喂真仓库根：`pnpm mutate` 的沙箱把仓库**压平**成 `apps/cli`（沙箱根 = apps/cli 的副本），
  // 那种环境下**没有任何根**能让 `join(root, 'apps/cli/crsi-lessons.md')` 落到账本上 —— 上一级
  // 是 `.stryker-tmp`、再上一级才是真 apps/cli。这正是干跑红在这两条上的原因（原来那条
  // 「mock 的前提成立」断言的**主语是布局本身**，而布局正是被压平的那件事）。
  //
  // 故改为**现造一棵长度对的树**，把账本字节原样放进去：生产侧那句 join 在真仓库与沙箱里
  // 读到同一份内容。副作用是**更安全**：账本在真仓库里那份不再落在「处理器万一会写」的
  // 爆炸半径里 —— 处理器只认得夹具这棵树（下面「只读」一格钉的就是它）。
  beforeEach(() => {
    gitRoot = mkdtempSync(join(tmpdir(), 'mipham-crsi-root-'))
    mkdirSync(join(gitRoot, 'apps', 'cli'), { recursive: true })
    copyFileSync(LESSONS, join(gitRoot, IN_ROOT))
    mockExecSync.mockReturnValue(`${gitRoot}\n`)
  })

  afterEach(() => {
    if (gitRoot) rmSync(gitRoot, { recursive: true, force: true })
    gitRoot = undefined
  })

  it('已注册 —— 「有定义、无施加点」正是这一族的复发形态', () => {
    expect(getCommand('/crsi lessons')).toBeDefined()
    expect(getCommandNames()).toContain('/crsi lessons')
  })

  it('夹具的前提成立：mock 的根 + 仓库根相对的账本路径，拼出的是**账本的字节**', () => {
    // 没有这一条，下面几条可能在断言「一个不存在的路径被正确处理了」。
    // 它同时钉住了 `LESSONS_FILE` 的**取值**：那个字面量在这里写第二遍（`IN_ROOT`），
    // 于是常量被改成别的路径时，处理器去找的文件不在夹具里 ⇒ 下面几条立刻红。
    expect(readFileSync(join(gitRoot!, IN_ROOT), 'utf-8')).toBe(readFileSync(LESSONS, 'utf-8'))
    expect(readFileSync(LESSONS, 'utf-8')).toContain('CRSI Lessons')
  })

  it('跑起来报的常驻集 == 择点选出的那一个（报告不与对象脱节）', async () => {
    const result = await getCommand('/crsi lessons')!({} as never, [])
    const sel = selectResidentLessons(extractCrsiLessonSummaries(readFileSync(LESSONS, 'utf-8')))
    expect(sel.resident.length).toBeGreaterThan(0) // 正对照
    // 报的必须是它**真读的那一份**（夹具那棵树的路径），不是别处的同名文件。
    expect(result.content).toContain(join(gitRoot!, IN_ROOT))
    expect(result.content).toContain(`常驻 **${sel.resident.length}** 条`)
    for (const s of sel.resident) expect(result.content).toContain(s.title)
  })

  it('只读：跑完账本逐字节未变', async () => {
    const seeded = join(gitRoot!, IN_ROOT)
    const before = readFileSync(seeded, 'utf-8')
    // **正对照（不可省）**：没有它，这一格在夹具已被写坏时会**恒真** —— 「跑前跑后都是 x」
    // 比一遍就绿，而它要检的正是「处理器有没有写」。实测过：一次偷写变异把它变成这样。
    expect(before).toContain('CRSI Lessons')
    expect(before).toContain('严重度')
    await getCommand('/crsi lessons')!({} as never, [])
    expect(readFileSync(seeded, 'utf-8')).toBe(before)
  })

  it('账本找不到时给一句话，不抛', async () => {
    mockExecSync.mockReturnValue('/nonexistent-root\n')
    const result = await getCommand('/crsi lessons')!({} as never, [])
    expect(result.content).toContain('教训文件不存在')
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

  it('both autonomous prompts ask for a visible line and name no uncallable export', async () => {
    // The journal's per-iteration row is the assistant's **visible text**, so a
    // loop that only calls tools logs iterations with nothing in them. And the
    // prompts used to name `logAutoloopIteration(...)` — a module export inside
    // this CLI, not a tool, so the model could never call it (the one sentence
    // was both unfollowable and, being prose, unguarded).
    const handler = getCommand('/loop')!
    for (const args of [
      ['auto', 'monitor CI'], // explicit /loop auto
      ['xyz', 'monitor CI'], // auto-detected branch
    ]) {
      const { forwardToAI } = await handler(mkCtx(), args)
      expect(forwardToAI).toContain('one line of plain text')
      expect(forwardToAI).not.toContain('logAutoloopIteration')
      // the CLI owns that file (iteration count, token totals, status)
      expect(forwardToAI).not.toContain('reading/writing the journal')
      expect(forwardToAI).toContain('Do not edit ~/.mipham/autoloop/')
    }
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
// /tasks — 面板对历史**无反应**（判据是登记表，见下方「显示登记表里的任务」）
// ═══════════════════════════════════════════════════════════════
//
// 这一组此前测的是「历史扫描认得 Task 调用」。扫描已删（它把「历史里见过几次
// 调用」当成「有没有任务」），而**「历史不改变输出」这条性质本身仍值得钉**：
// 它是这个面板唯一正确的输入来源。断言从「有 Task 就不同」翻成「一律相同」。

/** 造一条带 tool_use 块的助手消息。 */
const toolUseMessage = (name: string) => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'tu_1', name, input: {} }],
})

describe('/tasks 对历史无反应', () => {
  it('历史里有 Task 调用块 ⇒ 输出与没有历史时逐字相同', () => {
    const handler = getCommand('/tasks')!
    const withTask = handler(mkCtx([toolUseMessage('Task')]), []).content
    const withoutTask = handler(mkCtx([]), []).content
    expect(withTask).toBe(withoutTask)
  })

  it('其他工具的调用同样不改变输出', () => {
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
 * ⚠️ **非空转保证**在下面 (a) 条：handler 的第一行是 `if (hasPending())` 早退，而 (a) 断言返回文案
 * 含 `✅ 已生成散文提议并跑过测试` ⇒ 一旦早退即**红**（关门实验：把 `hasPending` 钉成 `true`，
 * 两条同时红 —— 不是「静默地什么都没断言」）。
 *
 * 因此这里**刻意不覆盖 `hasPending`**：它是 `return pendingSandbox !== null`，一个**模块内存单例**
 * （不是磁盘状态），而本文件已把 `runCrsiModification` mock 掉 ⇒ 该单例在本文件内不可能被置位，
 * 覆盖它只会让本文件少走一道真实的闸门，换不来任何隔离。
 */
const h = vi.hoisted(() => ({
  measure: vi.fn(),
  appendImprovement: vi.fn(),
  setPendingVerdict: vi.fn(),
  readImprovements: vi.fn((): unknown[] => []),
  appendProseProposal: vi.fn(),
  runCrsiModification: vi.fn(),
  produceProseProposal: vi.fn(),
  collectSkillFiles: vi.fn(),
  selectCrsiSignal: vi.fn(),
  proseProposalId: vi.fn(() => 'prose-id-1'),
  hasProposedProse: vi.fn(() => false),
  prefilterProposal: vi.fn(() => ({ pass: true, reasons: [] })),
}))

vi.mock('../../src/core/crsi-modify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/crsi-modify')>()),
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
  readImprovements: h.readImprovements,
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

    // ── 判别力的另一半：ε 必须是**跟着提议走的值**，而不是一个恰好等于 7 的常数 ──
    // 只跑 ε=7 时，「读 `proposal.expectedEffect`」与「写死字面量 7」**不可区分**
    // （fixture、断言常量、算出的 deltaMean 三者同为 7）⇒ 写死 ε 的变异体存活。
    // 换成 ε=9 再跑一次：任何写死常量的生产实现都会红，而边界用例（上面 ε=7 那半）不丢。
    // ε=9 与 deltaMean 7.0 的关系：真身判据是 `deltaMean >= predicted`、**刻意不叠 minEffect 容差**
    // （见 improvement-track 的 predictionHit 注释）⇒ 7 >= 9 为假，故这里断言的是**布尔值本身**，
    // 而不是退让成 `!== undefined`。
    h.appendImprovement.mockClear()
    h.produceProseProposal.mockResolvedValue({ ...PROSE_PROPOSAL, expectedEffect: 9 })

    const second = await handler(mkProseCtx(), ['--prose'])
    const secondRecord = h.appendImprovement.mock.calls[0]?.[0] as {
      predictedDelta?: number
      predictionHit?: boolean
    }
    expect(secondRecord.predictedDelta).toBe(9)
    expect(secondRecord.predictionHit).toBe(false)
    expect(second.content).toContain('未命中 ⚠️')
  })
})

// ═══════════════════════════════════════════════════════════════
// B2 代价维 —— **两条渲染路径**都得接
// ═══════════════════════════════════════════════════════════════

/**
 * 记在报告上（`formatCostLine` 的纯函数测试在 `test/core/improvement-track.test.ts`）不等于
 * 用户看得见。`/crsi` 有**两条**渲染路径 —— 手工 `modify` 的审阅面板与 prose `propose` 的提案回执 ——
 * 只接一条就是本仓库记过的「局部正确全局遗漏」，故这一段**两条路径各一条**，任一条漏接即红。
 *
 * 夹具取 1000ms → 2900ms：倍数 2.9 与均值都是 `formatCostLine` 自己算出来的，不是抄下来的断言常量。
 * （ctx 用 `mkProseCtx`：它相对 `mkCtx` 只多一项 `engine.getLlm`，而手工路径在 `commands.ts:894`
 * 同样要它 —— 那个名字说的是它当初为谁而写，不是说它只能给谁用。）
 */
const COST_SAMPLE = {
  ...SAMPLE,
  baselineDurations: [1000, 1000, 1000],
  postDurations: [2900, 2900, 2900],
}
const COST_LINE = '⏱️ 代价: 均值 1000ms → 2900ms（×2.9）'

describe('B2 代价维的展示接线', () => {
  it('手工路径 /crsi modify：审阅面板上打出代价行', async () => {
    h.measure.mockResolvedValue(COST_SAMPLE)
    const handler = getCommand('/crsi modify')!
    const result = await handler(mkProseCtx(), ['d', PROSE_FILE, '新正文'])
    expect(result.content).toContain(COST_LINE)
  })

  it('prose 路径 /crsi propose --prose：提案回执上打出代价行', async () => {
    h.measure.mockResolvedValue(COST_SAMPLE)
    const handler = getCommand('/crsi propose')!
    const result = await handler(mkProseCtx(), ['--prose'])
    expect(result.content).toContain(COST_LINE)
  })

  it('样本没有代价维 → 两条路径都整行不打印（不是打一行 0ms）', async () => {
    // 缺席必须表现为**没有这一行**：写成「均值 0ms → 0ms」会让「没测代价」与
    // 「测了、耗时为零」在回执上同形 —— 与 B1 的 `results` 键同一条承重判据。
    h.measure.mockResolvedValue(SAMPLE) // SAMPLE 无 durations 两个键
    const manual = await getCommand('/crsi modify')!(mkProseCtx(), ['d', PROSE_FILE, '新正文'])
    expect(manual.content).not.toContain('⏱️ 代价')
    const prose = await getCommand('/crsi propose')!(mkProseCtx(), ['--prose'])
    expect(prose.content).not.toContain('⏱️ 代价')
  })
})

// ═══════════════════════════════════════════════════════════════
// 事前声明风险（R）的展示接线 —— 它此前**零落点**
// ═══════════════════════════════════════════════════════════════

/**
 * R 与 ε 同源（同一行 JSON、同一段提示词），但 ε 有④落点（进 `improvements.jsonl`）与
 * ⑤读回（`predictionHitRate` 在 `/crsi stats` 显示），R 两环皆无 —— 它在 `commands.ts:1025`
 * 与 `expectedEffect` **同一作用域**里被丢掉，连沙箱都到不了（`CrsiModification` 无 risk 字段）。
 * 这一段钉的是**它唯一的落点**（prose 回执），不是它的措辞。
 *
 * 三条用例各钉一个方向：
 *  ① 有 R ⇒ 打印，且**带「未验证」** —— 缺这三个字，这一行就成了「风险已被处理」的假象，
 *     比不打印更坏（仓库存档：**按键有反应而世界不变 > 按键不存在**）。
 *  ② 无 R ⇒ **整行不打**（不是打一行空的）—— 与代价维同一条承重判据。
 *  ③ R 为空串 ⇒ 同样整行不打。这条不是臆想的边界：`parseProsePrediction` 收 R 的判据是
 *     `typeof rec.risk === 'string'` ⇒ `""` 会被一路携带到渲染处。
 *
 * ②③ 的夹具**逐字段写出、不写 `risk` 键**（而不是 `risk: undefined`）—— 缺席与「有键但无值」
 * 在这条断言上必须同形，故夹具也照缺席的形状给。
 */
describe('事前声明风险（R）的展示接线', () => {
  it('prose 回执上打出风险行，且带「未验证」', async () => {
    const result = await getCommand('/crsi propose')!(mkProseCtx(), ['--prose'])
    expect(result.content).toContain(`📋 事前声明风险（未验证）: ${PROSE_PROPOSAL.risk}`)
  })

  it('R 缺席 → 整行不打（不是打一行空的）', async () => {
    h.produceProseProposal.mockResolvedValue({
      filePath: PROSE_PROPOSAL.filePath,
      newContent: PROSE_PROPOSAL.newContent,
      originalContent: PROSE_PROPOSAL.originalContent,
      description: PROSE_PROPOSAL.description,
      expectedEffect: PROSE_PROPOSAL.expectedEffect,
    })
    const result = await getCommand('/crsi propose')!(mkProseCtx(), ['--prose'])
    expect(result.content).not.toContain('事前声明风险')
  })

  it('R 为空串 → 同样整行不打', async () => {
    h.produceProseProposal.mockResolvedValue({ ...PROSE_PROPOSAL, risk: '' })
    const result = await getCommand('/crsi propose')!(mkProseCtx(), ['--prose'])
    expect(result.content).not.toContain('事前声明风险')
  })

  it('操作提示自成一行（不被粘在风险行尾部）', async () => {
    // 本笔实测到的形状缺陷：`predictionLine` / `riskLine` 都**不以换行结尾**，而提示串此前是
    // 直接拼接 ⇒ 末行曾是 `📋 事前声明风险（未验证）: 可能让 skill 变长/crsi modify --approve 合并`。
    // 这条不是预防性的 —— 探针断言先于修复跑过一次、红在 `DIFF\n\n\n…` 上，故它钉的是**修好之前
    // 真实存在的形状**。判据只认「提示前紧邻一个换行」，不认提示文案（文案改了不该红）。
    const result = await getCommand('/crsi propose')!(mkProseCtx(), ['--prose'])
    expect(result.content).toMatch(/\n\/crsi modify --approve/)
  })
})

// ═══════════════════════════════════════════════════════════════
// 净变化（#20 simplicity 可机械化的那一半）的展示接线
// ═══════════════════════════════════════════════════════════════

/**
 * `#20 simplicity: 未要求的功能是负债` 唯一可机械化的那一半是**净变化**。回执上已有一个
 * 「只呈现、不判定」的家族（ε 命中 / 代价行 / 风险声明），这里是同一纪律的第四个成员 ——
 * 但它落在**人类批准 diff 的那一刻**，是**代码算出来的事实**，不靠提示词说服。
 *
 * 与 `riskLine` 有一处**刻意不同**：R 缺席 ⇒ 整行不打（它是一句声明，没声明就没有）；
 * 而净变化**永远可算**（手上就是那两份文本）⇒ 恒打印，含为零的那一态 ——
 * 「这份改写是等量的」本身就是批准时要看的信息。
 *
 * 判据取真身 `formatNetChange`（不 mock）：对纯函数做桩等于断言自己的桩。
 */
describe('净变化的展示接线', () => {
  it('prose 回执上打出净变化行', async () => {
    h.produceProseProposal.mockResolvedValue({
      ...PROSE_PROPOSAL,
      originalContent: 'a\nb\nc\n',
      newContent: 'a\nb\nc\nd\ne\n',
    })
    const result = await getCommand('/crsi propose')!(mkProseCtx(), ['--prose'])
    expect(result.content).toContain('📐 净变化（未判定）: 字符 +4，行 +2')
  })

  it('净变化为零也照打（与 riskLine 的「缺席就不打」刻意相反）', async () => {
    // 默认夹具两侧同形 ⇒ 恰好是零态。零不是「没测到」，是「这份改写等量」。
    const result = await getCommand('/crsi propose')!(mkProseCtx(), ['--prose'])
    expect(result.content).toContain('📐 净变化（未判定）: 字符 0，行 0')
  })

  it('事实在前、声明在后：净变化落在风险行与操作提示之前', async () => {
    const result = await getCommand('/crsi propose')!(mkProseCtx(), ['--prose'])
    const net = result.content.indexOf('📐 净变化')
    expect(net).toBeGreaterThan(-1) // 正对照：找不到时下面两条会各自恒真
    expect(net).toBeLessThan(result.content.indexOf('📋 事前声明风险'))
    expect(net).toBeLessThan(result.content.indexOf('/crsi modify --approve'))
  })
})

// ═══════════════════════════════════════════════════════════════
// 常驻教训的送达接线 —— 生成算子此前收到**零条**
// ═══════════════════════════════════════════════════════════════

/**
 * 这一段与上面几段不同：它的证据只能是**静态的**。原因是硬的 —— `commands.test.ts` 里
 * `produceProseProposal` 被 mock 掉了，所以「第 5 个实参是不是真的常驻块」在行为层看不见
 * （传 `''` 与传真块在本文件里读数相同）。而 `''` 正是本仓库反复吃过的那个失效模式：
 * 有定义、无施加点。故用**区间性质**钉住调用点（同 `crsi-gate-note.test.ts` 钉
 * `renderGateNote` 的形状）：只断言「那个调用点之后的代码里出现了取常驻块的调用」，
 * 不断言文案、不断言参数个数 —— 措辞改了不该红。
 */
describe('常驻教训的送达接线', () => {
  it('生产调用点把常驻块传给了 produceProseProposal', () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'src', 'ui', 'commands.ts'),
      'utf-8',
    )
    const segs = src.split('await produceProseProposal(')
    // 正对照：切法错了、或调用点被删/改名，这里先红 —— 否则下面那条会静默全绿。
    expect(segs.length - 1).toBe(1)
    expect(segs[1]).toContain('loadAlwaysOnLessonsBlock(')
  })
})

/**
 * 档位迁移那一行的接线 —— 与上一条同样只能静态证，但**区间更紧**。
 *
 * 为什么不行为测试：`--crossover` 分支要先从磁盘读真 `crsi-lessons.md`，读不到就早退成
 * 「教训文件为空，无可合并。」⇒ 拿真仓库文件当 fixture 会让本格随工作区状态变红
 *（本仓库记过这个陷阱：`crsi-sandbox` 曾拿真 `README.md` 当 fixture，有未提交改动即恒红）。
 * 而这一行要防的失效模式是**接线被删**（有定义、无施加点），静态区间足以钉住它；
 * 行**内容**由 `formatSeverityShift` 的单测负责（5 条）。
 *
 * 区间取法：从调用点切到**下一个**回执尾提示为止 —— 两条路径用的是同一句尾提示，
 * 故第一次出现即 crossover 回执的结尾。不这么切的话，`segs[1]` 会一直延伸到文件尾，
 * 「后面的默认教训路径里也有这行」就能让本格静默通过。
 */
describe('档位迁移的送达接线', () => {
  it('crossover 回执上打了档位行，且落在回执区间内', () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'src', 'ui', 'commands.ts'),
      'utf-8',
    )
    const segs = src.split('await produceCrossoverProposal(')
    // 正对照：调用点被删/改名 ⇒ 这里先红，否则下面那条会静默全绿。
    expect(segs.length - 1).toBe(1)
    const receipt = segs[1]!.split('/crsi modify --approve 合并')[0]!
    expect(receipt).toContain('formatSeverityShift(')
    // 三个实参都要来自本次提议（写死或传错档位即在此红）。
    expect(receipt).toContain('proposal.severityA')
    expect(receipt).toContain('proposal.severityB')
    expect(receipt).toContain('proposal.mergedSeverity')
  })
})

// ═══════════════════════════════════════════════════════════════
// /crsi stats —— ε 命中率段与**作废条款**
// ═══════════════════════════════════════════════════════════════

/**
 * 作废条款（「样本不足就不下结论；台账满了而判定样本仍很小 ⇒ 机制本身坏了」）是 ε 值得
 * 登记的全部理由，所以这一段有**三条支路**，其中两条的比较恰好是边界：`pred.total < 5`
 * 与 `records.length >= 20`。只跑一条成功路径的话，把 `<` 写成 `<=`、或整段删掉那道 20 条闸，
 * 都会**全绿**上线 —— 下面的 19/20 与判定侧多读数两组夹具就是为了让这两个方向的变异体都能死
 * （19 与 20 成对钉 `>=`；判定侧取 **2 / 4 / 5 / 6** 四个读数，是为了让「写死一个数字」的
 * 变异体在**消息文本**里也活不下来 —— 详见第一条用例上的注释）。
 *
 * 判据取真身 `predictionHitRate`（**刻意不 mock 它** —— 对判定侧做桩，等于断言自己的桩），
 * 只 mock `readImprovements`：它是这一段里唯一会读真实 home 目录
 * （`~/.mipham/crsi/improvements.jsonl`）的一环。engine 只取真值 + 空规则表，
 * 让前面那段规则统计走空、命令一定会走到 ε 段。
 *
 * **一个夹具喂两个数**：`readImprovements()` 返回的是**原始数组** ⇒ 它的 `length` 就是作废条款里的
 * `records.length`；`predictionHitRate` 再从这同一个数组里 filter 出「有 ε 预登记」的记录作分母。
 * `n` / `judged` / `hits` 三个数各自独立传入，故断言值**跟着夹具走**，而不是跟着写死的字面量走。
 * 命中率刻意用两组不同的 (judged, hits)：生产端若把某个数写死，两条不可能同时绿
 * （同批 T4 的教训 —— fixture、断言常量、算出的值三者同为 7 时，写死常量的变异体存活）。
 */
const mkRecords = (n: number, judged: number, hits: number): unknown[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    skillName: 'research',
    changeSet: [],
    causal: true,
    baselineScores: [],
    postScores: [],
    deltaMean: 0,
    noise: 0,
    minEffect: 0,
    verdict: 'inconclusive',
    // 同生同灭：真源 `buildImprovementReport` 里两条键要么一起写、要么都不写，本夹具照抄这个形状。
    // 理由**不是**「`predictionHit: false` 会被算进分母」—— 分母只认 `predictedDelta !== undefined`
    // （只写 `predictionHit: false` 而不写 `predictedDelta` 会被整条忽略）。真正的风险是**反过来的半条**：
    // 有 `predictedDelta` 而无 `predictionHit` ⇒ 该条进了分母，却永远不可能被算成命中
    //（分子只认 `predictionHit === true`），等于一条静默的「未命中」。
    ...(i < judged ? { predictedDelta: 1, predictionHit: i < hits } : {}),
  }))

/** `getActiveRules()` 空表 ⇒ 规则统计段不进；`getEffectivenessTracker()` 缺席 ⇒ effs 为空、跳过后进 ε 段。 */
const mkCrsiStatsCtx = () => {
  const ctx = mkCtx()
  const e = ctx as unknown as { engine: Record<string, unknown> }
  e.engine.getRuleEngine = () => ({ getActiveRules: () => [] })
  e.engine.getEffectivenessTracker = () => undefined
  return ctx
}

const runCrsiStats = async () => {
  const handler = getCommand('/crsi stats')!
  return (await handler(mkCrsiStatsCtx(), [])).content
}

describe('/crsi stats 的 ε 段与作废条款', () => {
  beforeEach(() => {
    h.readImprovements.mockReturnValue([])
  })

  // 负控 N10（删掉内层 `if (records.length >= 20)` 整块）：**只有「机制失效」那条**红。
  // 负控 N11（把分支放宽成 `pred.total < 0`）：**三条「样本不足」用例**同时红。
  //
  // 本条取 judged = **2**（而非 brief 表格里的 4）：两条「样本不足」用例若都取 4，则那句里的
  // 数字只有一个读数，「把 `${pred.total}` 写成字面量 4」的变异体**实测存活**（N13，4 条全绿）。
  // 判定门槛那一侧由 2 / 4 / 5 / 6 四个读数一起钉住：`< 5` 要 5 条为真、4 条为假；
  // `< 4` 那种再偏一位的变异体由后面两条（judged = 4）杀死。
  it('样本不足：判定 2 条 / 台账 19 条 ⇒ 只报「样本不足」，不报机制失效', async () => {
    const ledger = 19
    const judged = 2
    h.readImprovements.mockReturnValue(mkRecords(ledger, judged, 0))

    const content = await runCrsiStats()
    // 非空转保证：先钉住确实走到了 ε 段，否则下面两条 not.toContain 会因「整段不存在」而假绿。
    expect(content).toContain('### ε 预测命中（prose 路径）')
    expect(content).toContain(`样本不足（判定记录 ${judged} 条，需 ≥ 5）—— 不下结论。`)
    // 台账 19 条还差一条 ⇒ 尚未到「机制失效」的门槛（20 是门槛，19 与 20 成对钉住 `>=`）。
    expect(content).not.toContain('机制失效')
    expect(content).not.toContain('命中率:')
  })

  // 机制失效是**合取**（台账 ≥ 20 **且** total < 5）。本条钉的是它的**左下角**：台账差一条、
  // 判定数又够不到门槛 ⇒ 两条消息都不该出现。judged 取 **4**（而不是 2）是刻意的：
  // 它是 `total < 5` 判据的**边界值**（4 假 / 5 真），故「判据偏一位成 `< 4`」的变异体（N14）
  // 会在本条与「机制失效」那条同时红 —— 红集由此与 N10（只红「机制失效」）**分开**。
  it('样本不足（边界另一角）：台账 19 条、判定 4 条 ⇒ 仍然只报「样本不足」', async () => {
    h.readImprovements.mockReturnValue(mkRecords(19, 4, 0))

    const content = await runCrsiStats()
    expect(content).toContain('样本不足（判定记录 4 条，需 ≥ 5）—— 不下结论。')
    expect(content).not.toContain('机制失效')
  })

  it('机制失效：台账满 20 条而判定样本仍 4 条 ⇒ 样本不足与机制失效同时出现', async () => {
    const ledger = 20
    const judged = 4
    h.readImprovements.mockReturnValue(mkRecords(ledger, judged, 0))

    const content = await runCrsiStats()
    expect(content).toContain(`样本不足（判定记录 ${judged} 条，需 ≥ 5）—— 不下结论。`)
    expect(content).toContain('⚠️ ε 机制失效：prose 路径使用率过低')
  })

  it('命中率：判定 5 条命中 4 ⇒ 打印 4/5、80% 与 Wilson 区间', async () => {
    h.readImprovements.mockReturnValue(mkRecords(5, 5, 4))

    const content = await runCrsiStats()
    expect(content).toContain('命中率: 4/5 (80%, Wilson 95% [38%, 96%])')
    // 5 条正好落在门槛上 ⇒ 必须是命中率支路，不能是「样本不足」那一侧。
    expect(content).not.toContain('样本不足')
    expect(content).not.toContain('机制失效')
  })

  it('命中率跟着夹具走：换一组判定 6 条命中 2 ⇒ 4/5 那组数不可能同时出现', async () => {
    h.readImprovements.mockReturnValue(mkRecords(9, 6, 2))

    const content = await runCrsiStats()
    expect(content).toContain('命中率: 2/6 (33%, Wilson 95% [10%, 70%])')
    expect(content).not.toContain('4/5')
  })
})

// ═══════════════════════════════════════════════════════════════
// 报告面读的是引擎所在的档，不是 `config.permission`
// ═══════════════════════════════════════════════════════════════
//
// 与页脚 / 系统提示那次修（把「近似的替身」换成 live 权限系统）同一形状：配置文件
// 只是几扇门里的一扇（Shift+Tab 转盘、组织级 `maxAllowedMode` 钳制、用户
// `settings.json` 都会移动真正生效的那一档），所以打印配置值的报告面可以点名一个
// **不是**正在拒绝调用的档。
//
// 夹具把两个值设成**不同**的档，判据才分得清谁到了输出里。
describe('报告面读引擎所在的档（`config.permission` 只是其中一扇门）', () => {
  const configSays = 'bypassPermissions'
  const live = 'plan'

  const ctxWithMode = () => {
    const ctx = mkCtx([])
    const raw = ctx as unknown as { engine: Record<string, unknown>; config: unknown }
    raw.engine = {
      ...raw.engine,
      getContext: () => ({
        getMessages: () => [],
        getEstimatedTokens: () => 0,
        getCheckpoints: () => [],
        getMaxTokens: () => 200_000,
      }),
      getPermission: () => ({ getMode: () => live }),
      getRegistry: () => undefined,
    }
    raw.config = { providers: [], permission: configSays }
    return ctx
  }

  const cases: [string, RegExp][] = [
    ['/status', /Permission:\s+plan\b/],
    ['/doctor', /Permission\s+plan\b/],
    ['/stats', /Permission:\s+plan\b/],
  ]

  for (const [name, line] of cases) {
    it(`${name} 报的是引擎所在的档`, async () => {
      const { content } = await getCommand(name)!(ctxWithMode(), [])

      expect(content).toMatch(line)
      // 负锚：配置里那一档一个字都不能出现 —— 只断「live 那一档在场」的话，
      // 两个值都印出来的实现（例如「Current: plan (config: bypassPermissions)」）
      // 仍是绿的。
      expect(content).not.toContain(configSays)
    })
  }
})

// ═══════════════════════════════════════════════════════════════
// /rewind — 回退后屏幕必须重新装上回退到的那份历史
//
// `clearMessages` 单用是 `/clear` 的形状（屏幕上没有该留的东西）；回退不一样 ——
// 留到那一点为止的历史仍然算数，只是屏幕上的旧了。只带 `clearMessages` 会在
// `app.tsx` 里把消息列表清成空、且**没有任何回填路径**：模型看得见回退后的历史，
// 用户看见一片空白，两边从此不同步。
// ═══════════════════════════════════════════════════════════════

describe('/rewind 前送恢复后的历史', () => {
  type RewindResult = { content: string; clearMessages?: boolean; forwardedMessages?: unknown[] }

  const ctxWithRestored = (restored: unknown[]) => {
    const ctx = mkCtx()
    ;(ctx as { engine: { getContext: () => unknown } }).engine.getContext = () => ({
      getMessages: () => restored,
      getEstimatedTokens: () => 0,
      getCheckpoints: () => [{ id: 1 }],
      restoreCheckpoint: () => ({ restored: true, messageCount: restored.length, label: 'cp' }),
    })
    return ctx
  }

  it('带上 forwardedMessages，且它就是恢复出来的那份历史', async () => {
    const restored = [{ role: 'user', content: 'kept' }]
    const res = (await getCommand('/rewind')!(ctxWithRestored(restored), [])) as RewindResult

    expect(res.clearMessages).toBe(true)
    expect(res.forwardedMessages).toEqual(restored)
  })

  it('负控：恢复出的历史为空时，不能凭空造出非空的前送', async () => {
    const res = (await getCommand('/rewind')!(ctxWithRestored([]), [])) as RewindResult
    expect(res.forwardedMessages).toEqual([])
  })

  it('没有检查点时不动消息列表（不返回 clearMessages）', async () => {
    const ctx = mkCtx()
    ;(ctx as { engine: { getContext: () => unknown } }).engine.getContext = () => ({
      getMessages: () => [{ role: 'user', content: 'live' }],
      getEstimatedTokens: () => 0,
      getCheckpoints: () => [],
    })
    const res = (await getCommand('/rewind')!(ctx, [])) as RewindResult
    expect(res.clearMessages).toBeUndefined()
    expect(res.forwardedMessages).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════
// /telemetry status — the withheld-key line
// ═══════════════════════════════════════════════════════════════
//
// `homedir()` is mocked globally (vitest.setup.ts), so the user scope here is a
// temp dir with no settings.json: telemetry resolves off and nothing flushes.
// Only the *project* file is written, which is exactly the half under test.
describe('/telemetry status — 项目级被忽略的键', () => {
  const PROJECT = `${tmpdir()}/mipham-test-cmd-telemetry`
  const PROJECT_SETTINGS = join(PROJECT, '.mipham', 'settings.json')

  function writeProject(doc: unknown): void {
    mkdirSync(join(PROJECT, '.mipham'), { recursive: true })
    writeFileSync(PROJECT_SETTINGS, JSON.stringify(doc))
  }

  const status = async (): Promise<string> => {
    const res = await getCommand('/telemetry')!(mkCtx(), ['status'])
    return (res as { content: string }).content
  }

  beforeEach(() => {
    rmSync(PROJECT, { recursive: true, force: true })
    mkdirSync(PROJECT, { recursive: true })
  })

  afterEach(() => {
    resetTelemetryState()
    resetCrashState()
    rmSync(PROJECT, { recursive: true, force: true })
  })

  it('names the ignored key and says which way the asymmetry runs', async () => {
    writeProject({ telemetry: { endpoint: 'https://evil.example/x' } })
    initTelemetry(PROJECT)
    const content = await status()
    expect(content).toContain('Ignored from project')
    expect(content).toContain('telemetry.endpoint')
    // The reason, on the same line — "ignored" alone invites "so how do I set
    // it?", and the answer is the direction of the asymmetry, not the key name.
    expect(content).toContain('veto, not grant')
  })

  it('negative control: nothing withheld, no row at all', async () => {
    // Paired with the case above: without this one, a version that always
    // printed the row would pass it.
    initTelemetry(PROJECT)
    expect(await status()).not.toContain('Ignored from project')
  })
})

// ═══════════════════════════════════════════════════════════════
// /tasks — 面板读登记表，不读历史计数
// ═══════════════════════════════════════════════════════════════
//
// 命令自称 "Background tasks"（`registry.set` 上方那张描述表），标题写
// 「── 后台任务 ──」，空态写「尚未跟踪任何任务」—— 全是**登记表**词汇。
// 但它此前数的是历史里 `Task` 工具调用块的个数：两者可以不一致（压缩会
// 把块丢掉而登记表还在），而「N 次任务操作」这句话本身也没回答「现在有
// 哪些任务」。同名的真登记表 `getTasks()` 早就存在、且已被 `GoalProgress`
// 消费 —— 这个面板是唯一没接上的读者。
describe('/tasks —— 显示登记表里的任务', () => {
  const runTasks = async (messages: unknown[] = []): Promise<string> =>
    ((await getCommand('/tasks')!(mkCtx(messages), [])) as { content: string }).content

  /** 每个用例自带清理：登记表是模块级状态，跨用例会互相看见。 */
  afterEach(async () => {
    for (const task of getTasks()) {
      await taskTool.execute({ action: 'delete', taskId: task.id }, {} as never)
    }
  })

  it('列出会话里真实存在的任务（含状态图标）', async () => {
    await taskTool.execute({ action: 'create', subject: 'panel-subject-alpha' }, {} as never)

    const content = await runTasks()
    expect(content).toContain('panel-subject-alpha')
    expect(content).toContain('📋')
  })

  it('负控：登记表为空时说「尚未跟踪任何任务」', async () => {
    expect(await runTasks()).toContain('No tasks tracked yet')
  })
})

// ═══════════════════════════════════════════════════════════════
// tool-search 的「没有服务器」提示 —— 它指的必须是 /mcp 真有的子命令
// ═══════════════════════════════════════════════════════════════

describe('tool-search hint points at a subcommand that exists', () => {
  it('每个 `/mcp <sub>` 都在 /mcp 自己的帮助里', async () => {
    // 两处**独立**的读数必须一致：模型读到的提示（tools/system/tool-search.ts）
    // 与 /mcp 真正分支的子命令。提示曾写成 `/mcp add <name> <url>` —— 一个从来没
    // 存在过的子命令，照着敲只会落到状态页。
    const { McpClient } = await import('../../src/mcp/client')
    await McpClient.getInstance().closeAll()
    McpClient.resetInstance()

    const { toolSearchTool } = await import('../../src/tools/system/tool-search')
    const hint = (await toolSearchTool.execute!({ query: '' }, {} as never)).content
    const named = [...hint.matchAll(/\/mcp\s+([a-z-]+)/g)].map((m) => m[1]!)

    // 前件：提示里确实点名了子命令 —— 否则下面的循环一次都不跑，恒绿。
    expect(named.length).toBeGreaterThan(0)

    const help = (await getCommand('/mcp')!(mkCtx(), [])).content
    for (const sub of named) {
      expect(help).toContain(`/mcp ${sub}`)
    }
  })
})

// ═══════════════════════════════════════════════════════════════
// /login —— 认得 config.yml 里的 key，不只是环境变量
// ═══════════════════════════════════════════════════════════════
//
// 原先判据是 `!!process.env[envVar]`：一个通过 config.yml（含加密的 `enc:v1:`）
// 配好、完全可用的 provider，在状态读数里被印成 ⬜（未登录）—— 一次**假阴性**。
// 判据改成「环境变量 **或** config 里有 key」，且沿用 `/switch` 的 `isApiKeyMissing`
// 谓词，保证「有行但 key 为空」仍是 ⬜。

describe('/login 认得 config.yml 里的 provider key', () => {
  const provider = (over: Record<string, unknown> = {}) => ({
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai',
    models: [],
    status: 'active',
    apiKey: '',
    ...over,
  })

  const runLogin = async (providers: unknown[]): Promise<string> => {
    const ctx = mkCtx()
    ;(ctx as unknown as { config: unknown }).config = { providers }
    return (await getCommand('/login')!(ctx, [])).content
  }

  /** 每个用例自带环境隔离：DEEPSEEK_API_KEY 的现值在跑完原样还原。 */
  const withEnvUnset = async (fn: () => Promise<void>): Promise<void> => {
    const prev = process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    try {
      await fn()
    } finally {
      if (prev === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = prev
    }
  }

  it('config 里的字面 key ⇒ ✅（修复前这一格恒为 ⬜）', async () => {
    await withEnvUnset(async () => {
      const content = await runLogin([provider({ apiKey: 'sk-config-literal' })])
      expect(content).toContain('✅')
      expect(content).not.toContain('⬜')
    })
  })

  it('加密存储（enc:v1:）也算已配置', async () => {
    await withEnvUnset(async () => {
      const content = await runLogin([provider({ apiKey: 'enc:v1:deadbeef' })])
      expect(content).toContain('✅')
    })
  })

  it('负控：有行但 key 为空 ⇒ 仍是 ⬜', async () => {
    await withEnvUnset(async () => {
      const content = await runLogin([provider({ apiKey: '' })])
      expect(content).toContain('⬜')
      expect(content).not.toContain('✅')
    })
  })

  it('环境变量那条路仍然有效（config key 为空也报 ✅）', async () => {
    await withEnvUnset(async () => {
      process.env.DEEPSEEK_API_KEY = 'sk-from-env'
      const content = await runLogin([provider({ apiKey: '' })])
      expect(content).toContain('✅')
    })
  })
})
