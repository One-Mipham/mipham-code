/**
 * daemon 侧引擎接线的**行为**证明（ROADMAP T5）。
 *
 * 同目录的 `test/integrity/daemon-capability-parity.test.ts` 守的是「源码对等」——
 * 它证明 `wireDaemonEngine` 调了哪些 setter。但源码对等**分不出「接了」和「接到了
 * 错对象」**：把 `setSkills(skills)` 写成 `setSkills(new SkillsLoader())`（空 loader）
 * 守卫照样绿，而 daemon 的 `Skill` 工具仍然每次调用都返回错误。所以这里补上真刀真枪
 * 跑一遍的那一层。
 *
 * 全部测试**不开端口**（`test/daemon/server.test.ts` 仍是唯一开端口的文件），
 * 直接构造引擎 + 真实工具注册表，走 `engine.process()`。
 */

import { describe, it, expect, afterEach, vi } from 'vitest'

// Isolate from the real ~/.mipham. Two reasons, not one: `createToolRegistry()`
// reads the user-level masking policy there, and the project-hooks gate now
// consults the *trust store*, which also lives under the home directory — a test
// that read the real one would pass or fail according to whether the machine
// running it happens to have the temp root trusted.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-daemon-caps`,
  }
})

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { wireDaemonEngine } from '../../src/daemon/engine-capabilities'
import { getWorkspaceTrust, resetWorkspaceTrust } from '../../src/core/workspace-trust'
import { QueryEngine } from '../../src/core/engine'
import { ContextManager } from '../../src/core/context'
import { createToolRegistry } from '../../src/tools'
import { ProviderRegistry } from '../../src/providers/registry'
import type { StreamChunk, ToolDefinition } from '../../src/shared'

// ── Helpers ──

const created: string[] = []

/**
 * A throwaway workspace. `realpathSync` matters on macOS: `tmpdir()` is a symlink
 * (`/var` → `/private/var`), and cwd-keyed memoization compares raw strings, so a
 * non-canonical path would make "same cwd" tests silently miss the cache.
 */
function makeWorkspace(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mipham-daemon-caps-')))
  created.push(dir)
  return dir
}

afterEach(() => {
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true })
  // The trust store is a module-level singleton over a file in the (mocked)
  // home — without this, a test that trusts its workspace would hand that trust
  // to every later test.
  resetWorkspaceTrust()
  rmSync(join(homedir(), '.mipham'), { recursive: true, force: true })
})

function mockContext(): ContextManager {
  return new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.9 })
}

function conversationText(engine: QueryEngine): string {
  return engine
    .getContext()
    .getMessages()
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n')
}

/**
 * A registry whose provider replays a scripted sequence of turns.
 *
 * The last turn repeats once exhausted — `process()` runs at least two turns when a
 * tool is used (the first yields the `tool_use`, the second is the continuation),
 * and a generator that ran out would otherwise hang the loop.
 */
function scriptedRegistry(turns: Array<() => AsyncGenerator<StreamChunk>>): ProviderRegistry {
  let turn = 0
  const registry = new ProviderRegistry(
    [{ id: 'test', name: 'Test', protocol: 'openai-compatible', apiKey: 'key', models: [] }],
    'test',
    'test-model',
  )
  registry.register('test', {
    config: {
      id: 'test',
      name: 'Test',
      protocol: 'openai-compatible' as const,
      apiKey: 'key',
      models: [],
    },
    chat: () => {
      const pick = turns[Math.min(turn, turns.length - 1)]!
      turn++
      return pick()
    },
    listModels: async () => [],
    healthCheck: async () => true,
  })
  return registry
}

/** Active provider always fails; a healthy default is available to fall back to. */
function failingActiveRegistry(calls: { active: number; fallback: number }): ProviderRegistry {
  const registry = new ProviderRegistry([], 'good', 'good-model')
  registry.register('good', {
    config: {
      id: 'good',
      name: 'Good',
      protocol: 'openai-compatible' as const,
      apiKey: 'k',
      models: [
        {
          id: 'good-model',
          name: 'Good Model',
          providerId: 'good',
          contextWindow: 1000,
          maxOutput: 100,
          vision: false,
          status: 'active' as const,
        },
      ],
    },
    chat: async function* () {
      calls.fallback++
      yield { type: 'text', content: 'fallback response' }
      yield { type: 'stop' }
    },
    listModels: async () => [],
    healthCheck: async () => true,
  })
  registry.register('bad', {
    config: {
      id: 'bad',
      name: 'Bad',
      protocol: 'openai-compatible' as const,
      apiKey: 'k',
      models: [],
    },
    chat: async function* () {
      calls.active++
      throw new Error('ECONNREFUSED: connection refused')
    },
    listModels: async () => [],
    healthCheck: async () => true,
  })
  registry.switchProvider('bad', 'bad-model')
  return registry
}

function newEngine(registry: ProviderRegistry, tools?: Map<string, ToolDefinition>): QueryEngine {
  // Default: `createToolRegistry()` with no context — exactly what the daemon does.
  // That is what makes D1 meaningful: the registry really does carry the `Skill` tool.
  // `tools` is only overridden by the rules tests, see `readToolTouching`.
  return new QueryEngine(registry, mockContext(), tools ?? createToolRegistry())
}

/**
 * A `Read` tool that only *reports* touching `filePath` — no filesystem access.
 *
 * The rules tests (D3 / D7) must not use the real `Read` from `createToolRegistry()`:
 * it enforces a **workspace boundary against `process.cwd()`**, and a `mkdtempSync`
 * workspace is outside it. Worse, it *throws* — and `engine.ts:1222`
 * `trackTouchedFile()` sits **after** `tool.execute()`, so a throwing tool means no
 * touched file, no rule injection, and a red test that says nothing about
 * `setRulesLoader`. The rules seam is what D3/D7 are about; the reader is scaffolding.
 */
function readToolTouching(filePath: string): ToolDefinition {
  return {
    name: 'Read',
    description: 'Read a file',
    category: 'system',
    permission: 'auto',
    parameters: {},
    execute: async () => ({ success: true, content: `read ${filePath}` }),
  }
}

function makeToolMap(tools: ToolDefinition[]): Map<string, ToolDefinition> {
  const map = new Map<string, ToolDefinition>()
  for (const t of tools) map.set(t.name, t)
  return map
}

/** The scripted two-turn shape shared by D3 / D7: one `Read`, then a closing text turn. */
function readTurn(target: string): Array<() => AsyncGenerator<StreamChunk>> {
  return [
    async function* () {
      yield {
        type: 'tool_use',
        toolUse: { type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: target } },
      }
      yield { type: 'stop' }
    },
    async function* () {
      yield { type: 'text', content: 'done' }
      yield { type: 'stop' }
    },
  ]
}

async function drain(engine: QueryEngine, prompt: string): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of engine.process(prompt)) chunks.push(chunk)
  return chunks
}

/** Write `<workspace>/extra-skills/probe.SKILL.md`. */
function writeProbeSkill(workspace: string): string {
  const dir = join(workspace, 'extra-skills')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'probe.SKILL.md'),
    '---\nname: probe\ndescription: daemon wiring probe\n---\n\nPROBE-BODY-MARKER\n',
  )
  return dir
}

// ── Tests ──

describe('wireDaemonEngine — behaviour', () => {
  it('D1: the Skill tool actually works (a real skills loader reaches the tool context)', async () => {
    const cwd = makeWorkspace()
    const skillsPaths = [writeProbeSkill(cwd)]
    const registry = scriptedRegistry([
      async function* () {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'c1', name: 'Skill', input: { skill: 'probe' } },
        }
        yield { type: 'stop' }
      },
      async function* () {
        yield { type: 'text', content: 'done' }
        yield { type: 'stop' }
      },
    ])

    const engine = newEngine(registry)
    wireDaemonEngine(engine, { cwd, registry, skillsPaths })
    await drain(engine, 'invoke the probe skill')

    const text = conversationText(engine)
    // 这条是本文件最强的一条：文本对等的守卫分不出「接了」与「接到了空 loader」，
    // 只有真跑一次才知道 `ctx.skillsLoader` 里是不是**装着 probe 的那个** loader。
    expect(text).toContain('── Skill Invoked: probe ──')
    expect(text).toContain('PROBE-BODY-MARKER')
    expect(text).not.toContain('SkillsLoader not available')
  })

  it('D2: provider fallback still works on the daemon path (wiring setLlm did not disable it)', async () => {
    const cwd = makeWorkspace()
    const calls = { active: 0, fallback: 0 }
    const registry = failingActiveRegistry(calls)

    const engine = newEngine(registry)
    wireDaemonEngine(engine, { cwd, registry })
    const chunks = await drain(engine, 'hi')

    // `wireDaemonEngine` 注入的正是 registry 本人 —— 修 `chatWithFallback` 判据之前，
    // 这一步会让 daemon 唯一还活着的 provider 回退**静默消失**（引擎只剩一个 error 块）。
    // 这条把「先修语义再对等」的顺序约束变成机械的：先落步 2 后落步 1 必红。
    expect(chunks.some((c) => c.type === 'warning')).toBe(true)
    expect(chunks.some((c) => c.type === 'text' && c.content === 'fallback response')).toBe(true)
    expect(registry.getActive().config.id).toBe('good')
    expect(calls).toEqual({ active: 1, fallback: 1 })
  })

  it('D3: path-scoped rules load from the session cwd (absolute tool paths still match)', async () => {
    const cwd = makeWorkspace()
    mkdirSync(join(cwd, '.mipham', 'rules'), { recursive: true })
    writeFileSync(
      join(cwd, '.mipham', 'rules', 'probe.md'),
      '---\npaths: "*.ts"\ndescription: probe rule\n---\n\nRULE-BODY-MARKER\n',
    )
    // 规则匹配是**按后缀**的（`rules-loader.ts:120-140` 自述不锚定规则目录），所以
    // 绝对 `file_path` 也必须命中 —— 这正是 daemon 场景（工具上下文里 cwd 是 daemon
    // 根，而 file_path 是绝对的）。用桩 Read 而非真 Read，理由见 `readToolTouching`。
    const target = join(cwd, 'probe-target.ts')

    const registry = scriptedRegistry(readTurn(target))
    const engine = newEngine(registry, makeToolMap([readToolTouching(target)]))
    wireDaemonEngine(engine, { cwd, registry })
    await drain(engine, 'read the file')

    expect(conversationText(engine)).toContain('[Rule: probe]')
  })

  it('D4: settings.json hooks are registered for this cwd', async () => {
    const cwd = makeWorkspace()
    // Trust first: project-level hooks are repository-controlled code execution,
    // so the loader reads them only when the caller vouches for the workspace.
    // This test is the *trusted* half; D4b is the other.
    getWorkspaceTrust().trust(cwd)
    mkdirSync(join(cwd, '.mipham'), { recursive: true })
    // matcher 用一个**全局唯一**的字面量：`loadSettingsJson` 同时读 `<cwd>/.mipham`
    // 与 `MIPHAM_HOME`（`config/loader.ts:238`），而 setup 把 homedir mock 成所有测试
    // **共用**的临时目录，别的测试文件可能往里写 settings.json。唯一字面量让「看见了
    // 它」只可能是读了本 cwd 那份，不需要靠「home 是干净的」这个不可控前提。
    writeFileSync(
      join(cwd, '.mipham', 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'DaemonCapsProbeTool', hooks: [{ type: 'code' }] }],
        },
      }),
    )

    const registry = scriptedRegistry([
      async function* () {
        yield { type: 'stop' }
      },
    ])
    const engine = newEngine(registry)
    wireDaemonEngine(engine, { cwd, registry })

    const hooks = engine.getHookEngine()
    expect(hooks).toBeDefined()

    // `listHooks()` 是这里**唯一**诚实的观测点。曾想用 `getHookHealth()`（跑一次就看
    // 到痕迹），但它做不到：`recordSuccess` 是 get-then-update
    // （`hooks.ts:225-233`，`const h = this.health.get(key); if (h) {...}`），
    // **从不新建**条目 —— 只有 `recordFailure` 会。健康表因此证明不了「跑过」。
    expect(hooks!.listHooks().map((h) => `${h.event}:${h.toolName ?? '*'}`)).toEqual([
      'PreToolUse:DaemonCapsProbeTool',
    ])

    // 这条是**冒烟**不是证明：`type: 'code'` 走 `executeHook` 的 `default` 分支直接返回
    // `{ allowed: true }`（`hooks-executor.ts:13-30`），全程不 spawn、也不留任何痕迹 ——
    // command / http 两个真会出境的类型都没被这条 fixture 用到。它能证明的只是「按这条
    // matcher 执行不会炸」，注册本身由上面的 `listHooks()` 负责。
    const result = await hooks!.executePreToolUse('DaemonCapsProbeTool', {}, 's1')
    expect(result.allowed).toBe(true)
  })

  // N1's daemon half. `isCwdAllowed` admits any session cwd inside the daemon's
  // own root without consulting trust (`workspace-guard.ts:27`), and this path
  // never runs the interactive prompt — so before the gate landed, a daemon
  // started in an untrusted clone would spawn that repo's hook commands on
  // request. The claim under test is asymmetric on purpose: the *project* hook
  // must be gone while the *user-level* hook survives, so this cannot pass by
  // registering nothing at all.
  it('D4b: project hooks are dropped for an untrusted cwd, user hooks kept', async () => {
    const cwd = makeWorkspace()
    mkdirSync(join(cwd, '.mipham'), { recursive: true })
    writeFileSync(
      join(cwd, '.mipham', 'settings.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'UntrustedProjectProbe', hooks: [{ type: 'code' }] }] },
      }),
    )
    mkdirSync(join(homedir(), '.mipham'), { recursive: true })
    writeFileSync(
      join(homedir(), '.mipham', 'settings.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'TrustedUserProbe', hooks: [{ type: 'code' }] }] },
      }),
    )

    const registry = scriptedRegistry([
      async function* () {
        yield { type: 'stop' }
      },
    ])
    const engine = newEngine(registry)
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      wireDaemonEngine(engine, { cwd, registry })

      const registered = engine
        .getHookEngine()!
        .listHooks()
        .map((h) => `${h.event}:${h.toolName ?? '*'}`)

      expect(registered).toEqual(['PreToolUse:TrustedUserProbe'])
      expect(registered).not.toContain('PreToolUse:UntrustedProjectProbe')

      // The skip is not silent — a gate that fails quietly is indistinguishable
      // from one that passed.
      expect(write.mock.calls.map((c) => String(c[0])).join('')).toContain('skipped hooks from')
    } finally {
      write.mockRestore()
    }
  })

  // The other half of the same judgement: a workspace with no hooks at all is
  // not a workspace whose hooks were skipped. Warning there would be a claim
  // about an object that never existed.
  it('D4c: an untrusted cwd with no project hooks warns about nothing', () => {
    const cwd = makeWorkspace()

    const registry = scriptedRegistry([
      async function* () {
        yield { type: 'stop' }
      },
    ])
    const engine = newEngine(registry)
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      wireDaemonEngine(engine, { cwd, registry })

      expect(write.mock.calls.map((c) => String(c[0])).join('')).not.toContain('skipped hooks')
    } finally {
      write.mockRestore()
    }
  })

  // A hook runs *for a session*, so "where am I" has to mean that session's cwd.
  // The daemon serves many sessions from one process, and `process.cwd()` is the
  // directory the daemon itself was started in — which belongs to none of them.
  // Observed through the handler rather than through a new getter: what matters
  // is the value that actually reaches a hook, not one stored beside it.
  it('D4d: hooks run for the session cwd, not the daemon’s own', async () => {
    const cwd = makeWorkspace()
    const registry = scriptedRegistry([
      async function* () {
        yield { type: 'stop' }
      },
    ])
    const engine = newEngine(registry)
    wireDaemonEngine(engine, { cwd, registry })

    const seen: Array<string | undefined> = []
    engine.getHookEngine()!.register({
      event: 'PreToolUse',
      toolName: 'DaemonCwdProbe',
      handler: async (c) => {
        seen.push(c.cwd)
        return { allowed: true }
      },
    })

    await engine.getHookEngine()!.executePreToolUse('DaemonCwdProbe', {}, 's1')

    expect(seen).toEqual([cwd])
    // The regression this pins: `makeWorkspace()` is a temp dir, so before the
    // fix this read the *daemon's* cwd. Asserting `not.toBe` keeps the test
    // honest if the two ever coincide by accident.
    expect(seen[0]).not.toBe(process.cwd())
  })

  it('D5: project agents load from the session cwd', () => {
    const cwd = makeWorkspace()
    mkdirSync(join(cwd, '.mipham', 'agents'), { recursive: true })
    const agentPath = join(cwd, '.mipham', 'agents', 'probe.md')
    writeFileSync(agentPath, '---\nname: probe\ndescription: probe agent\n---\n\nYou are probe.\n')

    const registry = scriptedRegistry([
      async function* () {
        yield { type: 'stop' }
      },
    ])
    const engine = newEngine(registry)
    wireDaemonEngine(engine, { cwd, registry })

    // 钉的是「接线」，不是「可达性」：`Agent` 工具在 daemon 的默认权限档下仍然是
    // `ask`（daemon 钳到 4 档是设计，见 server.ts 的 DAEMON_PERMISSION_MODES）。
    const resolved = engine.getAgentRegistry()?.resolve('probe')
    expect(resolved?.name).toBe('probe')
    expect(resolved?.filePath).toBe(agentPath)
    expect(resolved?.source).toBe('project')
  })

  it('D6: per-cwd memoization — same cwd shares, different cwd does not', () => {
    const cwdA = makeWorkspace()
    const cwdB = makeWorkspace()
    const registry = scriptedRegistry([
      async function* () {
        yield { type: 'stop' }
      },
    ])

    const first = newEngine(registry)
    wireDaemonEngine(first, { cwd: cwdA, registry })
    const second = newEngine(registry)
    wireDaemonEngine(second, { cwd: cwdA, registry })
    const other = newEngine(registry)
    wireDaemonEngine(other, { cwd: cwdB, registry })

    // 记忆化是有意的决策（daemon 长命、cwd 受 workspace-guard 约束），钉住它以免
    // 日后被「简化」成全局单例 —— 那会让所有会话共用第一个 cwd 的 hooks 与 agents。
    expect(second.getHookEngine()).toBe(first.getHookEngine())
    expect(second.getAgentRegistry()).toBe(first.getAgentRegistry())
    expect(other.getHookEngine()).not.toBe(first.getHookEngine())
    expect(other.getAgentRegistry()).not.toBe(first.getAgentRegistry())
  })

  it('D7: the rules loader is per-session, NOT memoized (a long-lived daemon must see new rules)', async () => {
    const cwd = makeWorkspace()
    const rulesDir = join(cwd, '.mipham', 'rules')
    mkdirSync(rulesDir, { recursive: true })
    writeFileSync(join(rulesDir, 'first.md'), '---\npaths: "*.ts"\n---\n\nFIRST-RULE-BODY\n')
    const target = join(cwd, 'probe-target.ts')
    const tools = () => makeToolMap([readToolTouching(target)])

    const earlyRegistry = scriptedRegistry(readTurn(target))
    const early = newEngine(earlyRegistry, tools())
    wireDaemonEngine(early, { cwd, registry: earlyRegistry })

    // 会话期间新增一条规则，然后为同一 cwd 接第二个会话。
    writeFileSync(join(rulesDir, 'second.md'), '---\npaths: "*.ts"\n---\n\nSECOND-RULE-BODY\n')
    const lateRegistry = scriptedRegistry(readTurn(target))
    const late = newEngine(lateRegistry, tools())
    wireDaemonEngine(late, { cwd, registry: lateRegistry })

    await drain(late, 'read the file')
    expect(conversationText(late)).toContain('[Rule: second]')

    // 关键的一条：`early` 必须**看不见**后加的规则。如果 loader 是按 cwd 记忆化的，
    // `late` 接线时 `setRulesLoader` 的那次 `load()` 会把**共享的那一只**重新载入，
    // `early` 于是也会看见 second —— 这条断言就是用来排除那种实现的。
    await drain(early, 'read the file')
    const earlyText = conversationText(early)
    expect(earlyText).toContain('[Rule: first]')
    expect(earlyText).not.toContain('[Rule: second]')
  })
})
