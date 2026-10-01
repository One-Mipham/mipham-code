import { describe, it, expect } from 'vitest'
import type { StreamChunk, ToolDefinition, ToolResult } from '../../src/shared/index.ts'
import { QueryEngine, filterExpiredMessages } from '../../src/core/engine'
import { SelfCritique } from '../../src/core/self-critique'
import {
  AgentMessageBus,
  formatInboundMessage,
  type AgentMessage,
} from '../../src/agent/message-bus'
import { ContextManager } from '../../src/core/context'
import { PermissionSystem } from '../../src/core/permission'
import { HookEngine } from '../../src/core/hooks'
import { ProviderRegistry, type ChatRequest } from '../../src/providers/registry'
import { Context } from '../../src/vajra'
import type { Llm } from '../../src/providers/llm'
import { mountLlm } from '../../src/providers/llm'
import { recordLlm, replayLlm } from '../../src/providers/llm-replay'
import { SessionLog, replayChunks } from '../../src/core/session-log'
import { RulesLoader } from '../../src/core/rules-loader'
import { InstructionsLoader } from '../../src/core/instructions'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── Helpers ──

/** Make a workspace holding `.mipham/rules/<name>.md`; returns its root. */
function makeRulesWorkspace(rules: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mipham-rules-')))
  const dir = join(root, '.mipham', 'rules')
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(rules)) {
    writeFileSync(join(dir, name), body)
  }
  return root
}

/** Flatten every message in the conversation to text, for substring assertions. */
function conversationText(context: ContextManager): string {
  return context
    .getMessages()
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n')
}

/** A `Read` tool that touches `filePath` — `Read` is one of the file tools the
 *  engine tracks for path-scoped rule matching. */
function readToolTouching(filePath: string, onExecute: () => void): ToolDefinition {
  return {
    ...mockTool('Read'),
    execute: async () => {
      onExecute()
      return { success: true, content: `read ${filePath}` }
    },
  }
}

function mockProviderRegistry(chatImpl?: () => AsyncGenerator<StreamChunk>) {
  const registry = new ProviderRegistry(
    [{ id: 'test', name: 'Test', protocol: 'openai-compatible', apiKey: 'key', models: [] }],
    'test',
    'test-model',
  )

  const mockProvider = {
    config: {
      id: 'test',
      name: 'Test',
      protocol: 'openai-compatible' as const,
      apiKey: 'key',
      models: [],
    },
    chat:
      chatImpl ||
      async function* () {
        yield { type: 'text' as const, content: 'Hello!' }
        yield { type: 'stop' as const }
      },
    listModels: async () => [],
    healthCheck: async () => true,
  }
  registry.register('test', mockProvider)
  return registry
}

function mockContext(): ContextManager {
  return new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.9 })
}

/**
 * A registry whose **active** provider always fails, with a healthy default to
 * fall back to. Counts attempts per side so a test can assert *how many* chats ran
 * (a fallback that retries when it shouldn't is as wrong as one that never fires).
 */
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

function mockTool(
  name: string,
  impl?: (params: Record<string, unknown>) => Promise<ToolResult>,
): ToolDefinition {
  return {
    name,
    description: `Tool: ${name}`,
    category: 'system',
    permission: 'self',
    parameters: {},
    execute: impl || (async () => ({ success: true, content: `${name} done` })),
  }
}

function makeToolMap(tools: ToolDefinition[]): Map<string, ToolDefinition> {
  const map = new Map<string, ToolDefinition>()
  for (const t of tools) map.set(t.name, t)
  return map
}

// ── Tests ──

describe('QueryEngine inbound message draining', () => {
  it('drains unread bus messages addressed to "main" into the conversation', () => {
    const registry = mockProviderRegistry()
    const context = mockContext()
    const engine = new QueryEngine(registry, context, makeToolMap([]))

    const bus = new AgentMessageBus()
    bus.post('bg-1', 'main', 'Task done', 'The background task finished.')

    const injected = engine.drainInboundMessages(bus)

    expect(injected).toBe(1)
    expect(context.getMessages()).toContainEqual({
      role: 'user',
      content: 'Message from @bg-1: Task done',
    })
  })

  it('drains unread bus messages addressed to the session id into the conversation', () => {
    const registry = mockProviderRegistry()
    const context = mockContext()
    const engine = new QueryEngine(registry, context, makeToolMap([]))
    engine.setSessionId('session-abc')

    const bus = new AgentMessageBus()
    bus.post('other-session', 'session-abc', 'Hello', 'Cross-session reply.')

    const injected = engine.drainInboundMessages(bus)

    expect(injected).toBe(1)
    expect(context.getMessages()).toContainEqual({
      role: 'user',
      content: 'Message from @other-session: Hello',
    })
  })

  it('marks drained messages read so they are not re-injected', () => {
    const registry = mockProviderRegistry()
    const context = mockContext()
    const engine = new QueryEngine(registry, context, makeToolMap([]))

    const bus = new AgentMessageBus()
    bus.post('bg-1', 'main', 'Once', 'Only once.')

    expect(engine.drainInboundMessages(bus)).toBe(1)
    expect(engine.drainInboundMessages(bus)).toBe(0)
    expect(context.getMessages()).toHaveLength(1)
  })

  it('formatInboundMessage formats from / summary / message', () => {
    expect(
      formatInboundMessage({
        id: 'm1',
        from: 'alice',
        to: 'main',
        summary: 'Heads up',
        message: 'Body text',
        timestamp: new Date(),
        read: false,
        type: 'message',
      }),
    ).toBe('Message from @alice: Heads up')
  })
})

describe('QueryEngine', () => {
  describe('constructor and accessors', () => {
    it('should create engine with required dependencies', () => {
      const registry = mockProviderRegistry()
      const context = mockContext()
      const tools = makeToolMap([])
      const engine = new QueryEngine(registry, context, tools)

      expect(engine.getContext()).toBe(context)
      expect(engine.getTools()).toBe(tools)
      expect(engine.getPermission()).toBeInstanceOf(PermissionSystem)
    })

    it('should accept custom permission system', () => {
      const registry = mockProviderRegistry()
      const context = mockContext()
      const tools = makeToolMap([])
      const permission = new PermissionSystem('ask')
      const engine = new QueryEngine(registry, context, tools, permission)

      expect(engine.getPermission().getDefaultLevel()).toBe('ask')
    })

    it('should switch provider', () => {
      const registry = mockProviderRegistry()
      // Register a second provider
      registry.register('other', {
        config: {
          id: 'other',
          name: 'Other',
          protocol: 'openai-compatible',
          apiKey: 'k',
          models: [],
        },
        chat: async function* () {
          yield { type: 'stop' as const }
        },
        listModels: async () => [],
        healthCheck: async () => true,
      })

      const engine = new QueryEngine(registry, mockContext(), makeToolMap([]))
      expect(() => engine.switchProvider('other')).not.toThrow()
    })

    it('should throw switching to unknown provider', () => {
      const engine = new QueryEngine(mockProviderRegistry(), mockContext(), makeToolMap([]))
      expect(() => engine.switchProvider('nonexistent')).toThrow()
    })

    it('switchProvider propagates the model context window to the context manager', () => {
      const registry = mockProviderRegistry()
      registry.register('one-m', {
        config: {
          id: 'one-m',
          name: 'One M',
          protocol: 'openai-compatible',
          apiKey: 'k',
          models: [
            {
              id: 'model-1m',
              name: 'Model 1M',
              providerId: 'one-m',
              contextWindow: 1_000_000,
              maxOutput: 128_000,
              vision: false,
              status: 'active',
            },
          ],
        },
        chat: async function* () {
          yield { type: 'stop' as const }
        },
        listModels: async () => [],
        healthCheck: async () => true,
      })

      const context = mockContext() // no contextWindow → threshold stays at initial 0.9
      expect(context.getCompactionThreshold()).toBe(0.9)

      const engine = new QueryEngine(registry, context, makeToolMap([]))
      engine.switchProvider('one-m', 'model-1m')

      // maxTokens reflects the 1M window…
      expect(context.getMaxTokens()).toBe(1_000_000)
      // …and the adaptive compaction threshold recomputes to 1 - 50K/1M = 0.95
      expect(context.getCompactionThreshold()).toBe(0.95)
    })
  })

  describe('skills seam — setSkills', () => {
    it('setSkills overrides the skills provider injected into tool context', async () => {
      const fakeSkills = {
        get: () => undefined,
        list: () => [],
        has: () => false,
        buildSystemReminder: () => '',
      }

      // 捕获工具执行时注入的 ToolContext，验证 setSkills 覆盖默认 loader
      let capturedSkills: unknown
      const tool: ToolDefinition = {
        ...mockTool('capture-skills'),
        execute: async (_params, ctx) => {
          capturedSkills = ctx.skillsLoader
          return { success: true, content: 'captured' }
        },
      }

      const registry = mockProviderRegistry(async function* () {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'call_1', name: 'capture-skills', input: {} },
        }
        yield { type: 'stop' }
      })

      const engine = new QueryEngine(registry, mockContext(), makeToolMap([tool]))
      engine.setSkills(fakeSkills)

      for await (const _ of engine.process('capture skills provider')) {
        /* drain */
      }

      expect(capturedSkills).toBe(fakeSkills)
    })
  })

  describe('rules seam — setRulesLoader', () => {
    /** Provider whose n-th chat call emits a Read of `paths[n]`, then stops. */
    function readPathPerTurn(paths: string[]) {
      let turn = 0
      return mockProviderRegistry(async function* () {
        const n = turn++
        const file = paths[n]
        if (file) {
          yield {
            type: 'tool_use',
            toolUse: { type: 'tool_use', id: `c${n}`, name: 'Read', input: { file_path: file } },
          }
        }
        yield { type: 'stop' }
      })
    }

    it('injects path-scoped rules for files touched by the first tool round', async () => {
      const root = makeRulesWorkspace({ 'a.md': '---\npaths: "a.ts"\n---\nRULE-A\n' })
      const context = mockContext()
      const engine = new QueryEngine(
        readPathPerTurn(['src/a.ts']),
        context,
        makeToolMap([readToolTouching('src/a.ts', () => {})]),
      )
      engine.setRulesLoader(new RulesLoader(root))

      for await (const _ of engine.process('read a')) {
        /* drain */
      }

      expect(conversationText(context)).toContain('RULE-A')
      rmSync(root, { recursive: true, force: true })
    })

    it('injects rules for files touched in later tool rounds of the same turn', async () => {
      // Two tool rounds in one user turn: round 1 (from process()) touches a.ts,
      // round 2 (from continueWithTools()) touches b.ts. Both paths must inject —
      // wiring only the first is the "two render paths, one wired" failure mode
      // this repo has already fixed once (see CLAUDE.md 完整覆盖闸).
      const root = makeRulesWorkspace({ 'b.md': '---\npaths: "b.ts"\n---\nRULE-B\n' })
      const context = mockContext()
      const engine = new QueryEngine(
        readPathPerTurn(['src/a.ts', 'src/b.ts']),
        context,
        makeToolMap([readToolTouching('src/b.ts', () => {})]),
      )
      engine.setRulesLoader(new RulesLoader(root))

      for await (const _ of engine.process('read a then b')) {
        /* drain */
      }

      expect(conversationText(context)).toContain('RULE-B')
      rmSync(root, { recursive: true, force: true })
    })

    it('injects nothing when no rule matches the touched file', async () => {
      const root = makeRulesWorkspace({ 'b.md': '---\npaths: "b.ts"\n---\nRULE-B\n' })
      const context = mockContext()
      const engine = new QueryEngine(
        readPathPerTurn(['docs/readme.md']),
        context,
        makeToolMap([readToolTouching('docs/readme.md', () => {})]),
      )
      engine.setRulesLoader(new RulesLoader(root))

      for await (const _ of engine.process('read docs')) {
        /* drain */
      }

      expect(conversationText(context)).not.toContain('RULE-B')
      rmSync(root, { recursive: true, force: true })
    })
  })

  describe('CRSI recall nudge — setInstructions', () => {
    /** Workspace holding `apps/cli/crsi-lessons.md` — where `loadAll` reads lessons from. */
    function makeLessonsWorkspace(severity: 'warning' | 'critical'): string {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'mipham-lessons-')))
      mkdirSync(join(root, 'apps', 'cli'), { recursive: true })
      writeFileSync(
        join(root, 'apps', 'cli', 'crsi-lessons.md'),
        `# CRSI Lessons\n\n## 教训标题\n\n- 建议: 建议正文。\n- 严重度: ${severity}\n`,
      )
      return root
    }

    function loaderFor(root: string): InstructionsLoader {
      const loader = new InstructionsLoader()
      loader.loadAll(root)
      return loader
    }

    /** Provider emitting one `probe` call per round for `rounds` rounds, then a stop. */
    function failingToolPerTurn(rounds: number) {
      let turn = 0
      return mockProviderRegistry(async function* () {
        const n = turn++
        if (n < rounds) {
          yield {
            type: 'tool_use',
            toolUse: { type: 'tool_use', id: `c${n}`, name: 'probe', input: {} },
          }
        }
        yield { type: 'stop' }
      })
    }

    /** A tool that reports failure the way this repo's eight failure returns do. */
    const failingProbe = () =>
      mockTool('probe', async () => ({ success: false, content: '', error: 'probe failed' }))

    const NUDGE = '[可回顾]'
    const countOf = (haystack: string, needle: string): number => haystack.split(needle).length - 1

    it('工具失败且存在未常驻教训时，注入扳机并给出文件路径', async () => {
      const root = makeLessonsWorkspace('warning')
      const context = mockContext()
      const engine = new QueryEngine(failingToolPerTurn(1), context, makeToolMap([failingProbe()]))
      engine.setInstructions(loaderFor(root))

      for await (const _ of engine.process('go')) {
        /* drain */
      }

      expect(conversationText(context)).toContain(NUDGE)
      expect(conversationText(context)).toContain(join(root, 'apps', 'cli', 'crsi-lessons.md'))
      rmSync(root, { recursive: true, force: true })
    })

    it('全部常驻（无未常驻教训）时不注入 —— 没有指针就没有扳机', async () => {
      const root = makeLessonsWorkspace('critical')
      const context = mockContext()
      const engine = new QueryEngine(failingToolPerTurn(1), context, makeToolMap([failingProbe()]))
      engine.setInstructions(loaderFor(root))

      for await (const _ of engine.process('go')) {
        /* drain */
      }

      expect(conversationText(context)).not.toContain(NUDGE)
      rmSync(root, { recursive: true, force: true })
    })

    it('没接装载器时不注入 —— 证明这一行接线是承重的，不是装饰', async () => {
      const context = mockContext()
      const engine = new QueryEngine(failingToolPerTurn(1), context, makeToolMap([failingProbe()]))

      for await (const _ of engine.process('go')) {
        /* drain */
      }

      expect(conversationText(context)).not.toContain(NUDGE)
    })

    it('工具成功时不注入 —— 扳机挂在失败事件上', async () => {
      const root = makeLessonsWorkspace('warning')
      const context = mockContext()
      const registry = mockProviderRegistry(async function* () {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'c0', name: 'probe', input: {} },
        }
        yield { type: 'stop' }
      })
      const engine = new QueryEngine(
        registry,
        context,
        makeToolMap([mockTool('probe', async () => ({ success: true, content: 'ok' }))]),
      )
      engine.setInstructions(loaderFor(root))

      for await (const _ of engine.process('go')) {
        /* drain */
      }

      expect(conversationText(context)).not.toContain(NUDGE)
      rmSync(root, { recursive: true, force: true })
    })

    it('多轮失败只注入一次 —— 失败循环里同一条命令重试十次不该是十次注入', async () => {
      const root = makeLessonsWorkspace('warning')
      const context = mockContext()
      const engine = new QueryEngine(failingToolPerTurn(2), context, makeToolMap([failingProbe()]))
      engine.setInstructions(loaderFor(root))

      for await (const _ of engine.process('go')) {
        /* drain */
      }

      // 前提自证：确实跑了两轮（否则「只注入一次」可能只是因为只失败了一轮）
      expect(context.getMessages().length).toBeGreaterThan(0)
      expect(countOf(conversationText(context), NUDGE)).toBe(1)
      rmSync(root, { recursive: true, force: true })
    })

    it('第一轮成功、第二轮才失败 —— continueWithTools 那个调用点也接了', async () => {
      // 与 `injectRules` 同形的「两条渲染路径只接一条」缺口：只接 `process()` 那一处，
      // 本条会红而其余全绿。断言看着像同一个东西，钉的是**另一个**调用点。
      const root = makeLessonsWorkspace('warning')
      const context = mockContext()
      let calls = 0
      const flaky = mockTool('probe', async () => {
        calls++
        return calls === 1
          ? { success: true, content: 'ok' }
          : { success: false, content: '', error: 'boom' }
      })
      const engine = new QueryEngine(failingToolPerTurn(2), context, makeToolMap([flaky]))
      engine.setInstructions(loaderFor(root))

      for await (const _ of engine.process('go')) {
        /* drain */
      }

      expect(calls).toBe(2) // 前提自证：第二轮确实跑了，且是它失败的
      expect(conversationText(context)).toContain(NUDGE)
      rmSync(root, { recursive: true, force: true })
    })
  })

  describe('process — input guards', () => {
    it('should ignore whitespace-only input without calling the provider', async () => {
      let called = false
      const registry = mockProviderRegistry(async function* () {
        called = true
        yield { type: 'text', content: 'should not happen' }
        yield { type: 'stop' }
      })

      const engine = new QueryEngine(registry, mockContext(), makeToolMap([]))

      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('   \n\t ')) {
        chunks.push(chunk)
      }

      expect(chunks).toHaveLength(0)
      expect(called).toBe(false)
    })
  })

  describe('process — provider fallback', () => {
    it('should degrade to default provider when active provider fails', async () => {
      const goodChat = async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'text', content: 'fallback response' }
        yield { type: 'stop' }
      }
      const badChat = async function* (): AsyncGenerator<StreamChunk> {
        throw new Error('ECONNREFUSED: connection refused')
      }

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
        chat: goodChat,
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
        chat: badChat,
        listModels: async () => [],
        healthCheck: async () => true,
      })
      registry.switchProvider('bad', 'bad-model')

      const engine = new QueryEngine(registry, mockContext(), makeToolMap([]))
      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('hi')) {
        chunks.push(chunk)
      }

      expect(chunks.some((c) => c.type === 'warning')).toBe(true)
      expect(chunks.some((c) => c.type === 'text' && c.content === 'fallback response')).toBe(true)
      // Active provider should now be the default (good)
      expect(registry.getActive().config.id).toBe('good')
    })

    it('keeps falling back when the injected Llm seam IS the registry (the production shape)', async () => {
      const calls = { active: 0, fallback: 0 }
      const registry = failingActiveRegistry(calls)
      const engine = new QueryEngine(registry, mockContext(), makeToolMap([]))
      // 生产路径注入的就是 registry 自己：`index.tsx:611` 把 `mountLlm(vajraContext, registry)`
      // 塞回来的东西交给 setLlm，而 `mountLlm` 只是原样 provide（providers/llm.ts:14-16）。
      // 若 `chatWithFallback` 按「非空即缝」判定，这个注入会让回退分支在生产**恒不可达** ——
      // 而上面那条测试构造引擎时不注入缝，于是套件全绿也发现不了。这条测试就是那个缝。
      engine.setLlm(registry)

      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('hi')) {
        chunks.push(chunk)
      }

      expect(chunks.some((c) => c.type === 'warning')).toBe(true)
      expect(chunks.some((c) => c.type === 'text' && c.content === 'fallback response')).toBe(true)
      expect(registry.getActive().config.id).toBe('good')
      // `active: 2` — the failed provider is retried once *in place* before the
      // cross-provider fallback is considered (a retry that flips the user's model
      // is the more expensive move). `fallback: 1` — the fallback still runs exactly
      // once, so the retry has not turned into a retry loop.
      expect(calls).toEqual({ active: 2, fallback: 1 })
    })

    it('does not fall back when a genuinely foreign Llm seam owns the chat flow', async () => {
      const calls = { active: 0, fallback: 0 }
      const registry = failingActiveRegistry(calls)
      const engine = new QueryEngine(registry, mockContext(), makeToolMap([]))
      let seamCalls = 0
      const seam: Llm = {
        chat: async function* () {
          seamCalls++
          yield { type: 'error' as const, error: 'seam failed' }
        },
      }
      engine.setLlm(seam)

      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('hi')) {
        chunks.push(chunk)
      }

      // 异己缝拥有整个 chat 流程：只调一次、不回退、不切 registry 状态。
      // 这条与上一条互为约束 —— 少了它，把回退判据整个删掉也能让上一条变绿。
      expect(seamCalls).toBe(1)
      expect(calls).toEqual({ active: 0, fallback: 0 })
      expect(chunks.some((c) => c.type === 'warning')).toBe(false)
      expect(chunks.some((c) => c.type === 'error')).toBe(true)
      expect(registry.getActive().config.id).toBe('bad')
    })

    it('retries the same provider once before switching away from the model the user chose', async () => {
      // 瞬时故障（overloaded / 连接重置）重发一次即可；换 provider 是更贵的一步 ——
      // 它会翻转 registry 的活动 provider，连带把用户选的模型换掉。顺序因此是
      // 「原地重试一次 → 再考虑跨 provider 回退」。
      let attempts = 0
      const registry = mockProviderRegistry(async function* () {
        attempts++
        if (attempts === 1) throw new Error('529 overloaded')
        yield { type: 'text' as const, content: 'second try' }
        yield { type: 'stop' as const }
      })
      const engine = new QueryEngine(registry, mockContext(), makeToolMap([]))

      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('hi')) {
        chunks.push(chunk)
      }

      expect(attempts).toBe(2)
      expect(chunks.some((c) => c.type === 'text' && c.content === 'second try')).toBe(true)
      expect(chunks.some((c) => c.type === 'warning')).toBe(true)
      expect(chunks.some((c) => c.type === 'error')).toBe(false)
      // 没换过模型：重试成功就不该动用户的选择。
      expect(registry.getActive().config.id).toBe('test')
    })

    it('the same-provider retry happens at most once', async () => {
      // 上界断言。少了它，「重试」写成循环也照样让上面那条变绿。
      let attempts = 0
      const registry = mockProviderRegistry(async function* () {
        attempts++
        throw new Error('still down')
      })
      const engine = new QueryEngine(registry, mockContext(), makeToolMap([]))

      for await (const _ of engine.process('hi')) {
        /* drain */
      }

      expect(attempts).toBe(2)
    })

    /**
     * `retryable: false` —— provider 认定这次失败是**确定性的**（内容过滤、畸形请求、
     * 坏 key）：重发一次会拿到同一句话，换 provider 也不会改变答案。于是两条路都该省掉，
     * 错误只报一次。
     *
     * 判据必须能分辨「省掉」与「压根没走这条路」：所以两侧都计数 —— 活动 provider **恰
     * 一次**（原地重试没发生）、回退 provider **零次**（回退没被烧掉）。
     */
    describe('provider 声明的确定性失败（`retryable: false`）', () => {
      /** 活动 provider 抛**错误块**（不是异常）——`retryable` 只挂在块上。 */
      function errorChunkRegistry(
        calls: { active: number; fallback: number },
        retryable?: boolean,
      ): ProviderRegistry {
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
            yield { type: 'text' as const, content: 'fallback response' }
            yield { type: 'stop' as const }
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
            yield retryable === undefined
              ? { type: 'error' as const, error: 'content filter rejected' }
              : { type: 'error' as const, error: 'content filter rejected', retryable }
          },
          listModels: async () => [],
          healthCheck: async () => true,
        })
        registry.switchProvider('bad', 'bad-model')
        return registry
      }

      async function run(registry: ProviderRegistry, context: ContextManager) {
        const engine = new QueryEngine(registry, context, makeToolMap([]))
        const chunks: StreamChunk[] = []
        for await (const chunk of engine.process('hi')) chunks.push(chunk)
        return chunks
      }

      it('确定性失败：不发原地重试、不烧回退，错误只报一次', async () => {
        const calls = { active: 0, fallback: 0 }
        const registry = errorChunkRegistry(calls, false)

        const chunks = await run(registry, mockContext())

        expect(calls).toEqual({ active: 1, fallback: 0 })
        expect(chunks.filter((c) => c.type === 'error')).toHaveLength(1)
        expect(chunks.some((c) => c.type === 'warning')).toBe(false)
        expect(chunks.some((c) => c.type === 'text' && c.content === 'fallback response')).toBe(
          false,
        )
        // 没动用户选的模型：既然换 provider 也改不了答案，就不该翻转 registry 状态。
        expect(registry.getActive().config.id).toBe('bad')
      })

      it('反方向：没声明（`undefined`）仍然原地重试一次 + 回退（老行为不变）', async () => {
        const calls = { active: 0, fallback: 0 }
        const registry = errorChunkRegistry(calls)

        const chunks = await run(registry, mockContext())

        expect(calls).toEqual({ active: 2, fallback: 1 })
        expect(chunks.some((c) => c.type === 'text' && c.content === 'fallback response')).toBe(
          true,
        )
      })

      it('反方向：显式 `retryable: true` 与未声明同义', async () => {
        const calls = { active: 0, fallback: 0 }
        const registry = errorChunkRegistry(calls, true)

        await run(registry, mockContext())

        expect(calls).toEqual({ active: 2, fallback: 1 })
      })
    })

    /**
     * 跨 provider 回退之后，**压缩窗口必须跟着换成回退模型的**。
     *
     * 回退模型的窗口通常比原模型小（1M → 128K）。直调 `registry.switchProvider` 只换了
     * 活动 provider，`context.updateMaxTokens` 从没被调用 ⇒ `getActiveModel()` 已经是回退
     * 模型，而 `context` 仍按**旧窗口**武装压缩：要等到 `0.95×1M ≈ 950K` 才触发，而回退模型
     * 128K 就撑爆 ⇒ 先吃硬报错。手动换档（Ctrl+P / `/switch`）走的是 `engine.switchProvider`，
     * 那一格本来就是对的 —— 这条钉的是**自动回退**这条旁路。
     */
    it('跨 provider 回退后，压缩窗口跟着换成回退模型的', async () => {
      const calls = { active: 0, fallback: 0 }
      const registry = failingActiveRegistry(calls)
      const context = mockContext() // 起始 100_000
      expect(context.getMaxTokens()).toBe(100_000)

      const engine = new QueryEngine(registry, context, makeToolMap([]))
      for await (const _ of engine.process('hi')) {
        /* drain */
      }

      // `good-model` 的 contextWindow 是 1000 —— 回退后窗口必须是它，不是 100_000。
      expect(registry.getActive().config.id).toBe('good')
      expect(context.getMaxTokens()).toBe(1000)
    })
  })

  describe('llmChat — 被拒绝的一轮必须点名', () => {
    // 拒答在下游与正常 `end_turn` 同形（同一个终止 stop），而它可能一个字都不给。
    // 少了点名，那一轮就是一块空白屏 —— 用户连「被拒了」都看不出。
    it('带原因的拒答：警告里带上提供商给的原因', async () => {
      const registry = mockProviderRegistry(async function* () {
        yield {
          type: 'stop',
          refusal: { category: 'cyber', explanation: 'blocked under the usage policy.' },
        }
      })
      const engine = new QueryEngine(registry, mockContext(), makeToolMap([]))
      const chunks: StreamChunk[] = []
      for await (const c of engine.process('hi')) chunks.push(c)

      const warning = chunks.find((c) => c.type === 'warning')
      expect(warning?.content).toContain('blocked under the usage policy.')
    })

    it('拒答但没带原因：仍然点名', async () => {
      // 落点不许吊在 explanation 上 —— 它缺席时空白屏的判断又退回起点。
      const registry = mockProviderRegistry(async function* () {
        yield { type: 'stop', refusal: {} }
      })
      const engine = new QueryEngine(registry, mockContext(), makeToolMap([]))
      const chunks: StreamChunk[] = []
      for await (const c of engine.process('hi')) chunks.push(c)

      expect(chunks.some((c) => c.type === 'warning')).toBe(true)
    })

    it('反方向：正常结束不发这条警告', async () => {
      // 少了这条，把警告无条件拼上去也照样绿。
      const registry = mockProviderRegistry(async function* () {
        yield { type: 'text', content: 'hello' }
        yield { type: 'stop' }
      })
      const engine = new QueryEngine(registry, mockContext(), makeToolMap([]))
      const chunks: StreamChunk[] = []
      for await (const c of engine.process('hi')) chunks.push(c)

      expect(chunks.some((c) => c.type === 'warning')).toBe(false)
    })
  })

  describe('process — basic conversation', () => {
    it('should yield text and stop chunks from provider', async () => {
      const registry = mockProviderRegistry(async function* () {
        yield { type: 'text', content: 'Hello, user!' }
        yield { type: 'stop' }
      })

      const context = mockContext()
      const engine = new QueryEngine(registry, context, makeToolMap([]))

      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('hi')) {
        chunks.push(chunk)
      }

      expect(chunks).toHaveLength(2)
      expect(chunks[0]).toEqual({ type: 'text', content: 'Hello, user!' })
      expect(chunks[1]).toEqual({ type: 'stop' })
    })

    it('should add user and assistant messages to context', async () => {
      const registry = mockProviderRegistry(async function* () {
        yield { type: 'text', content: 'Response' }
        yield { type: 'stop' }
      })

      const context = mockContext()
      const engine = new QueryEngine(registry, context, makeToolMap([]))

      // consume all chunks
      for await (const _ of engine.process('user input')) {
        /* drain */
      }

      const messages = context.getMessages()
      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({ role: 'user', content: 'user input' })
      expect(messages[1]).toMatchObject({ role: 'assistant', content: 'Response' })
    })

    it('should track assistant text across multiple text chunks', async () => {
      const registry = mockProviderRegistry(async function* () {
        yield { type: 'text', content: 'Part 1 ' }
        yield { type: 'text', content: 'Part 2' }
        yield { type: 'stop' }
      })

      const context = mockContext()
      const engine = new QueryEngine(registry, context, makeToolMap([]))

      for await (const _ of engine.process('hi')) {
        /* drain */
      }

      const msgs = context.getMessages()
      expect(msgs[1]?.content).toBe('Part 1 Part 2')
    })

    it('routes chat through the injected Llm seam when setLlm is called', async () => {
      const registry = mockProviderRegistry(async function* () {
        yield { type: 'text', content: 'from-registry' }
        yield { type: 'stop' }
      })
      const engine = new QueryEngine(registry, mockContext(), makeToolMap([]))

      engine.setLlm({
        chat: async function* () {
          yield { type: 'text', content: 'from-seam' }
          yield { type: 'stop' }
        },
      })

      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('hi')) {
        chunks.push(chunk)
      }

      expect(chunks.some((c) => c.type === 'text' && c.content === 'from-seam')).toBe(true)
      expect(chunks.some((c) => c.type === 'text' && c.content === 'from-registry')).toBe(false)
    })
  })

  describe('process — session log chunk recording', () => {
    it('records assistant stream chunks on the primary process loop', async () => {
      const registry = mockProviderRegistry(async function* () {
        yield { type: 'text', content: 'hello' }
        yield { type: 'stop' }
      })

      const context = mockContext()
      const log = new SessionLog('engine-chunk-test')
      context.setLog(log)

      const engine = new QueryEngine(registry, context, makeToolMap([]))

      for await (const _ of engine.process('hi')) {
        /* drain */
      }

      expect(replayChunks(log)).toEqual(['hello'])
    })
  })

  describe('context summarizer — 指令必须走 systemPrompt', () => {
    // 汇总指令曾以「数组里的 system 条目」这个形状发出。anthropic 侧会把 system 条目
    // 一律丢掉（它的协议只认顶层 system 参数）⇒ **同一段代码，两个 provider 收到的东西
    // 不同**：走 OpenAICompatProvider 的那些读得到指令，anthropic 读不到（汇总退化成
    // 「给一段对话，自己看着办」）。systemPrompt 是两个 provider 都读的那一种拼法。
    it('summarizer 请求带 systemPrompt，且数组里没有 system 条目', async () => {
      const seen: ChatRequest[] = []
      const context = mockContext()
      const engine = new QueryEngine(mockProviderRegistry(), context, makeToolMap([]))
      engine.setLlm({
        chat: async function* (req) {
          seen.push(req)
          yield { type: 'text', content: 'S' }
          yield { type: 'stop' }
        },
      })
      engine.setupContextSummarizer()

      // compact 只在 >30 条时动手，且保留末 20 条（context.ts:199-204）。
      for (let i = 0; i < 31; i++) {
        context.addMessage({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg${i}` })
      }
      await context.compact('test')

      expect(seen).toHaveLength(1)
      // 前半：指令在位（anthropic 侧也读得到的那一种拼法）
      expect(seen[0]!.systemPrompt).toMatch(/conversation summarizer/)
      // 后半：没有走「数组里的 system 条目」—— 那正是只有一半 provider 读得到的形状
      expect(seen[0]!.messages.some((m) => m.role === 'system')).toBe(false)
    })
  })

  describe('process — ctx.llm provider-swap (llm-replay)', () => {
    it('swapping ctx.llm to a replay makes the engine follow it', async () => {
      // 1. Record a "real" chat turn
      const { llm: realLlm, turns } = recordLlm({
        chat: async function* () {
          yield { type: 'text', content: 'recorded-response' }
          yield { type: 'stop' }
        },
      })
      const recorded: StreamChunk[] = []
      for await (const c of realLlm.chat({ model: 'm', messages: [] })) recorded.push(c)
      expect(turns).toHaveLength(1)

      // 2. Mount the replay under ctx.llm (swap the implementation)
      const ctx = new Context()
      mountLlm(ctx, replayLlm(turns))

      // 3. Engine injects that seam
      const engine = new QueryEngine(mockProviderRegistry(), mockContext(), makeToolMap([]))
      const llm = ctx.get<Llm>('llm')
      if (!llm) throw new Error('expected ctx.llm to be mounted')
      engine.setLlm(llm)

      // 4. Engine's chat goes through the replay, not the registry mock
      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('hi')) chunks.push(chunk)

      expect(chunks.some((c) => c.type === 'text' && c.content === 'recorded-response')).toBe(true)
      expect(chunks.some((c) => c.type === 'text' && c.content === 'Hello!')).toBe(false)
    })
  })

  describe('chatWithFallback — a retried turn must not run a tool twice', () => {
    it('drops the failed attempt tool calls when the turn is retried', async () => {
      let calls = 0
      const registry = mockProviderRegistry(async function* () {
        calls++
        if (calls === 1) {
          // Failed attempt: it already emitted a tool call before the stream
          // broke. The retry re-streams the whole turn, so this call is dead —
          // and its id (call_1) will never appear again.
          yield {
            type: 'tool_use',
            toolUse: { type: 'tool_use', id: 'call_1', name: 'Bump', input: {} },
          }
          yield { type: 'error', error: 'stream stalled' }
          return
        }
        if (calls === 2) {
          yield {
            type: 'tool_use',
            toolUse: { type: 'tool_use', id: 'call_2', name: 'Bump', input: {} },
          }
          yield { type: 'stop' }
          return
        }
        yield { type: 'text', content: 'done' }
        yield { type: 'stop' }
      })

      let executed = 0
      const bump = mockTool('Bump', async () => {
        executed++
        return { success: true, content: 'bumped' }
      })
      const engine = new QueryEngine(registry, mockContext(), makeToolMap([bump]))

      const chunks: StreamChunk[] = []
      for await (const c of engine.process('hi')) chunks.push(c)

      // The retry happened and announced itself…
      expect(chunks.some((c) => c.restart === true)).toBe(true)
      // …and the failed attempt's call_1 did NOT execute.
      const results = chunks.filter((c) => c.type === 'tool_result')
      expect(results.map((r) => r.tool_use_id)).toEqual(['call_2'])
      expect(executed).toBe(1)
    })

    it('retries continuation rounds too (they used to bypass chatWithFallback)', async () => {
      let calls = 0
      const registry = mockProviderRegistry(async function* () {
        calls++
        if (calls === 1) {
          // First round: one tool call, clean stop → process runs it, then
          // continues the turn.
          yield {
            type: 'tool_use',
            toolUse: { type: 'tool_use', id: 'c1', name: 'Bump', input: {} },
          }
          yield { type: 'stop' }
          return
        }
        if (calls === 2) {
          // Continuation round, first attempt: fails retryably.
          yield { type: 'error', error: 'stall' }
          return
        }
        yield { type: 'text', content: 'recovered' }
        yield { type: 'stop' }
      })
      const engine = new QueryEngine(registry, mockContext(), makeToolMap([mockTool('Bump')]))

      const chunks: StreamChunk[] = []
      for await (const c of engine.process('hi')) chunks.push(c)

      // With a raw llmChat the continuation's error would surface directly and
      // 'recovered' would never arrive.
      expect(chunks.some((c) => c.type === 'text' && c.content === 'recovered')).toBe(true)
    })
  })

  describe('process — error handling', () => {
    it('should add error message to context and stop', async () => {
      let attempts = 0
      const registry = mockProviderRegistry(async function* () {
        attempts++
        yield { type: 'error', error: 'API unavailable' }
      })

      const context = mockContext()
      const engine = new QueryEngine(registry, context, makeToolMap([]))

      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('hi')) {
        chunks.push(chunk)
      }

      // One retry on the same provider, then a stop: the failure is announced once
      // (warning), and only the *last* chunk is the error the caller acts on.
      expect(attempts).toBe(2)
      expect(chunks.at(-1)?.type).toBe('error')
      expect(context.getMessages()).toHaveLength(2) // user + error line
      // #23: client error must persist as a system line, not model (assistant) output
      expect(context.getMessages()[1]).toMatchObject({ role: 'system' })
    })

    it('names the unavailable model instead of re-emitting the raw upstream error', async () => {
      // Single-provider registry: the active provider *is* the default, so there is
      // nothing to fall back to. A bare `String(err)` there reads as "the model
      // answered badly", when in fact this turn never reached a model at all.
      const registry = mockProviderRegistry(async function* () {
        throw new Error('ECONNREFUSED 127.0.0.1:443')
      })
      const engine = new QueryEngine(registry, mockContext(), makeToolMap([]))

      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('hi')) {
        chunks.push(chunk)
      }

      const err = chunks.at(-1)
      expect(err?.type).toBe('error')
      expect(err).toMatchObject({ type: 'error' })
      const message = (err as { error: string }).error
      expect(message).toContain('test-model') // the model the user is on
      expect(message).toContain('test') // its provider
      expect(message).toContain('ECONNREFUSED 127.0.0.1:443') // underlying cause kept
      expect(message).toContain('Ctrl+P') // and the next step, not just the failure
    })
  })

  describe('process — tool execution', () => {
    it('should execute tool and yield tool_result', async () => {
      let toolCalled = false
      const tool = mockTool('read', async () => {
        toolCalled = true
        return { success: true, content: 'file content' }
      })

      const registry = mockProviderRegistry(async function* () {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'call_1', name: 'read', input: { path: '/f.txt' } },
        }
        yield { type: 'stop' }
      })

      const engine = new QueryEngine(registry, mockContext(), makeToolMap([tool]))

      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('read file')) {
        chunks.push(chunk)
      }

      expect(toolCalled).toBe(true)
      const toolResult = chunks.find((c) => c.type === 'tool_result')
      expect(toolResult).toMatchObject({
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: 'file content',
      })
    })

    it('should return error for unknown tool', async () => {
      const registry = mockProviderRegistry(async function* () {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'call_1', name: 'nonexistent', input: {} },
        }
        yield { type: 'stop' }
      })

      const engine = new QueryEngine(registry, mockContext(), makeToolMap([]))

      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('do thing')) {
        chunks.push(chunk)
      }

      const result = chunks.find((c) => c.type === 'tool_result')
      expect(result?.content).toContain('Unknown tool')
    })

    it('should block tool when permission is ask', async () => {
      const tool: ToolDefinition = {
        ...mockTool('bash'),
        permission: 'ask',
      }

      const registry = mockProviderRegistry(async function* () {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'rm -rf /' } },
        }
        yield { type: 'stop' }
      })

      const permission = new PermissionSystem('default')
      const engine = new QueryEngine(registry, mockContext(), makeToolMap([tool]), permission)

      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('run command')) {
        chunks.push(chunk)
      }

      const result = chunks.find((c) => c.type === 'tool_result')
      expect(result?.content).toContain('requires approval under "default" mode')
    })

    // ── auto 档：分类器真的挡在闸门上（不是只有单测在过家家） ──────────────
    //
    // 这一组每条都数 `classify()` 被调了几次。只断言结果的话，「放行 ⇒ 执行」在
    // `bypassPermissions` 下也成立（那是空断言），且一条把每次调用都送去问 LLM 的
    // 实现同样全绿 —— 计数把两者都钉死。
    describe('auto 档的分类器闸门', () => {
      const bashTool = (onRun: () => void): ToolDefinition => ({
        ...mockTool('bash', async () => {
          onRun()
          return { success: true, content: 'ran' }
        }),
        permission: 'ask',
      })

      /**
       * 只在**第一轮**发这一次工具调用，之后给纯文本收尾。
       *
       * 发满每一轮会让引擎一遍遍重放同一次调用（被拒也算一轮），于是「执行了几次」
       * 的读数变成引擎的轮数上限而不是 1 —— 计数断言就成了在量别的东西。
       */
      const oneBashCall = (name = 'bash') => {
        let turn = 0
        return mockProviderRegistry(async function* () {
          if (turn++ > 0) {
            yield { type: 'text' as const, content: 'done' }
            yield { type: 'stop' as const }
            return
          }
          yield {
            type: 'tool_use',
            toolUse: { type: 'tool_use', id: 'call_1', name, input: { command: 'ls' } },
          }
          yield { type: 'stop' }
        })
      }

      async function run(engine: QueryEngine): Promise<StreamChunk | undefined> {
        const chunks: StreamChunk[] = []
        for await (const chunk of engine.process('run command')) chunks.push(chunk)
        return chunks.find((c) => c.type === 'tool_result')
      }

      it('分类器放行 ⇒ 工具真的执行了，且只问了它一次', async () => {
        let ran = 0
        let asked = 0
        const permission = new PermissionSystem('auto')
        permission.setClassifier({
          version: 'test',
          classify: async () => {
            asked++
            return { allow: true }
          },
        })
        const engine = new QueryEngine(
          oneBashCall(),
          mockContext(),
          makeToolMap([bashTool(() => ran++)]),
          permission,
        )

        const result = await run(engine)
        expect(result?.content).toBe('ran')
        expect(result?.isError).toBe(false)
        expect(ran).toBe(1)
        expect(asked).toBe(1)
      })

      it('分类器拒绝 ⇒ 工具没执行，且错误串带上它的理由', async () => {
        let ran = 0
        const permission = new PermissionSystem('auto')
        permission.setClassifier({
          version: 'test',
          classify: async () => ({ allow: false, reason: 'irreversible local destruction' }),
        })
        const engine = new QueryEngine(
          oneBashCall(),
          mockContext(),
          makeToolMap([bashTool(() => ran++)]),
          permission,
        )

        const result = await run(engine)
        expect(ran).toBe(0)
        expect(result?.isError).toBe(true)
        expect(result?.content).toContain('irreversible local destruction')
        // 拒绝不得被说成「切个模式就好了」：策略拒绝换模式也没用。
        expect(result?.content).not.toContain('Shift+Tab')
      })

      it('引擎故障拿住 ⇒ 错误串直言这不是裁决、可以重试（否则模型会直接放弃任务）', async () => {
        let ran = 0
        const permission = new PermissionSystem('auto')
        permission.setClassifier({
          version: 'test',
          classify: async () => ({
            allow: false,
            reason: 'classifier unreachable',
            retryable: true,
          }),
        })
        const engine = new QueryEngine(
          oneBashCall(),
          mockContext(),
          makeToolMap([bashTool(() => ran++)]),
          permission,
        )

        const result = await run(engine)
        expect(ran).toBe(0)
        expect(result?.content).toContain('classifier unreachable')
        expect(result?.isError).toBe(true)
        // 两种拒绝必须能分辨：说「被否决」会让模型直接放弃任务，而这句说的是
        // 「从未被裁决、可以重试」—— 且它才是指向 Shift+Tab 的那一条。
        expect(result?.content).toContain('NOT a policy decision')
        expect(result?.content).toContain('Shift+Tab')
      })

      it('静态已放行的调用绕过分类器（auto 档的只读豁免，一次都不问）', async () => {
        let ran = 0
        let asked = 0
        const permission = new PermissionSystem('auto')
        permission.setClassifier({
          version: 'test',
          classify: async () => {
            asked++
            return { allow: false } // 反着答：真被问到就必然拒绝
          },
        })
        // 名字必须**逐字**是 `Read`：只读豁免按类别 + 名字两道判，`read` 不在其内
        // —— 这正是「将来某个叫 read 的非文件工具不得静默走只读通道」那一半。
        const readTool: ToolDefinition = {
          ...mockTool('Read', async () => {
            ran++
            return { success: true, content: 'file content' }
          }),
          category: 'file',
          permission: 'self',
        }
        const engine = new QueryEngine(
          oneBashCall('Read'),
          mockContext(),
          makeToolMap([readTool]),
          permission,
        )

        const result = await run(engine)
        expect(result?.content).toBe('file content')
        expect(ran).toBe(1)
        expect(asked).toBe(0)
      })

      it('auto 档没挂分类器 ⇒ 被门控的工具不执行（fail-closed）', async () => {
        let ran = 0
        const engine = new QueryEngine(
          oneBashCall(),
          mockContext(),
          makeToolMap([bashTool(() => ran++)]),
          new PermissionSystem('auto'),
        )

        const result = await run(engine)
        expect(ran).toBe(0)
        expect(result?.isError).toBe(true)
        expect(result?.content).toContain('"auto" mode')
      })
    })
  })

  // ── T12-A：工具成败位必须活着穿出 engine ────────────────────────────────
  //
  // 此前 `tool_result` 只有 `content`，成败被并进正文 ⇒ 无头路径（daemon / Bot /
  // schedules）分不出「工具跑成功」与「工具被拒/报错」，第三方基准驱动因此拿不到
  // 工具级读数。协议侧 `ServerToolResultMessage.isError` 早就声明了，只是没人填。
  describe('tool_result 的成败位（T12-A）', () => {
    it('失败的工具调用标 isError，且错误文案仍在 content 里', async () => {
      const tool: ToolDefinition = { ...mockTool('bash'), permission: 'ask' }
      const registry = mockProviderRegistry(async function* () {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'ls' } },
        }
        yield { type: 'stop' }
      })
      const engine = new QueryEngine(
        registry,
        mockContext(),
        makeToolMap([tool]),
        new PermissionSystem('default'),
      )

      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('run command')) {
        chunks.push(chunk)
      }

      const result = chunks.find((c) => c.type === 'tool_result')
      expect(result?.isError).toBe(true)
      expect(result?.content).toContain('requires approval under "default" mode')
    })

    it('成功的工具调用标 isError: false（字段恒在，消费端无需分辨 undefined）', async () => {
      const tool = mockTool('read', async () => ({ success: true, content: 'file content' }))
      const registry = mockProviderRegistry(async function* () {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'call_1', name: 'read', input: { path: '/f.txt' } },
        }
        yield { type: 'stop' }
      })
      const engine = new QueryEngine(registry, mockContext(), makeToolMap([tool]))

      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('read file')) {
        chunks.push(chunk)
      }

      const result = chunks.find((c) => c.type === 'tool_result')
      expect(result?.isError).toBe(false)
      expect(result?.content).toBe('file content')
    })

    // `process()` 只跑第一轮工具（engine.ts:699 那处会展平 error），多轮全走
    // `continueWithTools()`（engine.ts:1038）—— 后者此前连展平都没有，直接
    // `content: result.content`，而失败结果的 content 恰是空串 ⇒ 模型收到一个
    // **空** tool_result，错误文案整个丢失。所以这条单独测。
    it('多轮循环里的失败：既标 isError，也不把错误文案丢成空串', async () => {
      let call = 0
      const okTool = mockTool('Read', async () => ({ success: true, content: 'file body' }))
      const askTool: ToolDefinition = { ...mockTool('bash'), permission: 'ask' }
      const registry = mockProviderRegistry(async function* () {
        call += 1
        if (call === 1) {
          yield {
            type: 'tool_use',
            toolUse: { type: 'tool_use', id: 'c1', name: 'Read', input: { path: 'a.py' } },
          }
        } else if (call === 2) {
          yield {
            type: 'tool_use',
            toolUse: { type: 'tool_use', id: 'c2', name: 'bash', input: { command: 'ls' } },
          }
        } else {
          yield { type: 'text', content: '收尾' }
        }
        yield { type: 'stop' }
      })
      const engine = new QueryEngine(
        registry,
        mockContext(),
        makeToolMap([okTool, askTool]),
        new PermissionSystem('default'),
      )

      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('go')) {
        chunks.push(chunk)
      }

      // 前置断言：第二轮真的跑了（否则下面的 find 找不到 c2，测试会假绿）
      expect(call).toBeGreaterThanOrEqual(3)
      const failed = chunks.find((c) => c.type === 'tool_result' && c.tool_use_id === 'c2')
      if (!failed) throw new Error('第二轮 tool_result 未产出 —— 多轮路径没走到')
      expect(failed.content).toContain('requires approval under "default" mode')
      expect(failed.isError).toBe(true)
    })
  })

  describe('resetFileTracking', () => {
    it('clears the read-before-write record the tools receive', async () => {
      let seen: Set<string> | undefined
      const probe: ToolDefinition = {
        ...mockTool('probe'),
        execute: async (_params, ctx) => {
          seen = ctx.readFiles
          ctx.readFiles?.add('/tmp/already-read.txt') // stands in for the Read tool
          return { success: true, content: 'ok' }
        },
      }
      const registry = mockProviderRegistry(async function* () {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'call_1', name: 'probe', input: {} },
        }
        yield { type: 'stop' }
      })
      const engine = new QueryEngine(registry, mockContext(), makeToolMap([probe]))

      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('probe')) chunks.push(chunk)

      expect(seen?.has('/tmp/already-read.txt')).toBe(true)

      // The engine hands this exact Set to every tool, so a /clear or /resume
      // must empty it — otherwise a fresh conversation can overwrite a file it
      // never read.
      engine.resetFileTracking()
      expect(seen?.size).toBe(0)
    })
  })

  describe('hook integration', () => {
    it('should invoke PreToolUse hook and allow execution', async () => {
      const tool = mockTool('read')
      const registry = mockProviderRegistry(async function* () {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'call_1', name: 'read', input: {} },
        }
        yield { type: 'stop' }
      })

      const hooks = new HookEngine()
      let hookCalled = false
      hooks.register({
        event: 'PreToolUse',
        handler: async (ctx) => {
          hookCalled = true
          expect(ctx.toolName).toBe('read')
          return { allowed: true }
        },
      })

      const engine = new QueryEngine(registry, mockContext(), makeToolMap([tool]))
      engine.setHookEngine(hooks)

      for await (const _ of engine.process('read')) {
        /* drain */
      }

      expect(hookCalled).toBe(true)
    })

    it('should block tool when PreToolUse hook denies', async () => {
      const tool = mockTool('bash')
      const registry = mockProviderRegistry(async function* () {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'rm' } },
        }
        yield { type: 'stop' }
      })

      const hooks = new HookEngine()
      hooks.register({
        event: 'PreToolUse',
        handler: async () => ({ allowed: false, reason: 'Dangerous command blocked' }),
      })

      const engine = new QueryEngine(registry, mockContext(), makeToolMap([tool]))
      engine.setHookEngine(hooks)

      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('run')) {
        chunks.push(chunk)
      }

      const result = chunks.find((c) => c.type === 'tool_result')
      expect(result?.content).toContain('Dangerous command blocked')
    })

    it('should invoke PostToolUse hook after execution', async () => {
      const tool = mockTool('read')
      const registry = mockProviderRegistry(async function* () {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'call_1', name: 'read', input: {} },
        }
        yield { type: 'stop' }
      })

      const hooks = new HookEngine()
      let postCalled = false
      hooks.register({
        event: 'PostToolUse',
        handler: async (ctx) => {
          postCalled = true
          expect(ctx.toolResult?.success).toBe(true)
          return { allowed: true }
        },
      })

      const engine = new QueryEngine(registry, mockContext(), makeToolMap([tool]))
      engine.setHookEngine(hooks)

      for await (const _ of engine.process('read')) {
        /* drain */
      }

      expect(postCalled).toBe(true)
    })

    it('should merge modified input from PreToolUse hook', async () => {
      let receivedParams: Record<string, unknown> = {}
      const tool: ToolDefinition = {
        ...mockTool('write'),
        execute: async (params) => {
          receivedParams = params
          return { success: true, content: 'ok' }
        },
      }

      const registry = mockProviderRegistry(async function* () {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'call_1', name: 'write', input: { path: '/tmp/x' } },
        }
        yield { type: 'stop' }
      })

      const hooks = new HookEngine()
      hooks.register({
        event: 'PreToolUse',
        handler: async () => ({
          allowed: true,
          modifiedInput: { safe: true },
        }),
      })

      const engine = new QueryEngine(registry, mockContext(), makeToolMap([tool]))
      engine.setHookEngine(hooks)

      for await (const _ of engine.process('write')) {
        /* drain */
      }

      expect(receivedParams).toMatchObject({ path: '/tmp/x', safe: true })
    })

    it("carries the hook's additionalContext to the model instead of dropping it", async () => {
      // `additionalContext` 是**每一个非阻断钩子**的说话方式（exit 1 的 stderr、
      // spawn 失败、够不着的 mcp_tool 服务器都走它）。这条路径此前只读 `allowed` /
      // `modifiedInput` ⇒ 全都生产出来再被丢掉。
      const tool = mockTool('read')
      const registry = mockProviderRegistry(async function* () {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'call_1', name: 'read', input: {} },
        }
        yield { type: 'stop' }
      })

      const hooks = new HookEngine()
      hooks.register({
        event: 'PreToolUse',
        handler: async () => ({ allowed: true, additionalContext: 'lint ran clean, 0 warnings' }),
      })

      const engine = new QueryEngine(registry, mockContext(), makeToolMap([tool]))
      engine.setHookEngine(hooks)

      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('read')) {
        chunks.push(chunk)
      }

      const result = chunks.find((c) => c.type === 'tool_result')
      expect(result?.content).toContain('lint ran clean, 0 warnings')
    })

    it('a hook that says `ask` refuses the call — and does not erase a warning written before it', async () => {
      const tool = mockTool('bash')
      const registry = mockProviderRegistry(async function* () {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'ls' } },
        }
        yield { type: 'stop' }
      })

      const hooks = new HookEngine()
      hooks.register({
        event: 'PreToolUse',
        handler: async () => ({ allowed: true, permissionDecision: 'ask' }),
      })

      const engine = new QueryEngine(registry, mockContext(), makeToolMap([tool]))
      engine.setHookEngine(hooks)

      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('ls')) {
        chunks.push(chunk)
      }

      const result = chunks.find((c) => c.type === 'tool_result')
      expect(result?.isError).toBe(true)
      // 本 CLI 没有交互批准提示 ⇒ `ask` 是硬拒，且拒绝的理由必须说清「不是你的钩子坏了」。
      expect(result?.content).toMatch(/approval|批准/)
    })

    it('`allow` is a no-op, not an approval — the other two decisions are what change behaviour', async () => {
      // 正控：证明上一条不是「凡有 permissionDecision 就拦」。`allow` 来自仓库自带的
      // 钩子时会是一条自我放行的路径（与项目级 agent 定义自授 bypassPermissions 同族），
      // 故本引擎**不认它** —— 认的是方向，不是键名。
      let executed = false
      const tool: ToolDefinition = {
        ...mockTool('read'),
        execute: async () => {
          executed = true
          return { success: true, content: 'read done' }
        },
      }
      const registry = mockProviderRegistry(async function* () {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'call_1', name: 'read', input: {} },
        }
        yield { type: 'stop' }
      })

      const hooks = new HookEngine()
      hooks.register({
        event: 'PreToolUse',
        handler: async () => ({ allowed: true, permissionDecision: 'allow' }),
      })

      const engine = new QueryEngine(registry, mockContext(), makeToolMap([tool]))
      engine.setHookEngine(hooks)

      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('read')) {
        chunks.push(chunk)
      }

      expect(executed).toBe(true)
      expect(chunks.find((c) => c.type === 'tool_result')?.isError).toBeFalsy()
    })
  })

  describe('process — context compaction', () => {
    it('should check compaction before processing', async () => {
      const registry = mockProviderRegistry(async function* () {
        yield { type: 'text', content: 'ok' }
        yield { type: 'stop' }
      })

      // Use a small maxTokens so compaction triggers
      const context = new ContextManager({ maxTokens: 500, compactionThreshold: 0.5 })
      // Add many messages to trigger compaction (each ~100 tokens with estimator)
      for (let i = 0; i < 35; i++) {
        context.addMessage({ role: 'user', content: `msg ${i}`.repeat(100) })
      }

      const engine = new QueryEngine(registry, context, makeToolMap([]))

      for await (const _ of engine.process('hi')) {
        /* drain */
      }

      // After compaction + new messages, should be ≤ 22 (20 kept + user + assistant)
      expect(context.getMessageCount()).toBeLessThanOrEqual(22)
    })
  })

  describe('process — tool result context', () => {
    it('should add tool_use and tool_result to context', async () => {
      const tool = mockTool('read')
      const registry = mockProviderRegistry(async function* () {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'cu1', name: 'read', input: { p: 1 } },
        }
        yield { type: 'stop' }
      })

      const ctx = mockContext()
      const engine = new QueryEngine(registry, ctx, makeToolMap([tool]))

      for await (const _ of engine.process('read')) {
        /* drain */
      }

      const msgs = ctx.getMessages()
      // user + [assistant with tool_use] + [user with tool_result]
      expect(msgs.length).toBeGreaterThanOrEqual(3)
    })
  })
})

// ============================================================
// Cross-Session Inbound Config
// ============================================================

describe('filterExpiredMessages', () => {
  const now = Date.now()
  const mkMsg = (ageMs: number): AgentMessage => ({
    id: 'm',
    from: 'a',
    to: 'b',
    summary: 's',
    message: 'x',
    timestamp: new Date(now - ageMs),
    read: false,
    type: 'message',
  })

  it('keeps messages within the expiry window', () => {
    const msgs = [mkMsg(0), mkMsg(10_000)]
    expect(filterExpiredMessages(msgs, 300, now)).toHaveLength(2)
  })

  it('drops messages older than the expiry window', () => {
    const msgs = [mkMsg(0), mkMsg(301_000)]
    expect(filterExpiredMessages(msgs, 300, now)).toHaveLength(1)
  })

  it('drops everything when expiry is zero', () => {
    // Any real message is older than the instant it was written (age > 0).
    const msgs = [mkMsg(1)]
    expect(filterExpiredMessages(msgs, 0, now)).toHaveLength(0)
  })
})

describe('Cross-session inbound config', () => {
  const makeEngine = () => {
    const registry = mockProviderRegistry()
    const ctx = mockContext()
    return new QueryEngine(registry, ctx, new Map())
  }

  it('stores cross-session config via setCrossSessionConfig', () => {
    const engine = makeEngine()
    engine.setCrossSessionConfig({ crossSessionInbound: 'deny', dialogExpiry: 600 })
    // setSessionId is needed for pollCrossSessionInbox
    engine.setSessionId('test-session-config')
    // verify no throw — config is accepted
  })

  it('defaults to ask mode before setCrossSessionConfig is called', async () => {
    const engine = makeEngine()
    engine.setSessionId('test-session-default')

    // In 'ask' mode (default), pollCrossSessionInbox should not throw
    // even when the inbox directory doesn't exist yet
    await expect(engine.pollCrossSessionInbox()).resolves.toBeUndefined()
  })

  it('pollCrossSessionInbox succeeds in deny mode', async () => {
    const engine = makeEngine()
    engine.setCrossSessionConfig({ crossSessionInbound: 'deny', dialogExpiry: 300 })
    engine.setSessionId('test-session-deny')

    // Deny mode should silently succeed (no messages to discard)
    await expect(engine.pollCrossSessionInbox()).resolves.toBeUndefined()
  })

  it('pollCrossSessionInbox succeeds in allow mode', async () => {
    const engine = makeEngine()
    engine.setCrossSessionConfig({ crossSessionInbound: 'allow', dialogExpiry: 300 })
    engine.setSessionId('test-session-allow')

    // Allow mode should silently succeed (no messages to forward)
    await expect(engine.pollCrossSessionInbox()).resolves.toBeUndefined()
  })
})

// ============================================================
// SelfCritique — 注入 Llm 缝
// ============================================================

describe('SelfCritique — critique chat seam', () => {
  it('routes critique chat through the injected llm, not registry.chat', async () => {
    // registry.chat 若被调用则打标记——探测 critique 是否绕过注入的 llm 缝
    let registryChatCalled = false
    const registry = mockProviderRegistry(async function* () {
      registryChatCalled = true
      yield {
        type: 'text',
        content: JSON.stringify({
          safe: false,
          correct: false,
          necessary: false,
          reasoning: 'registry',
        }),
      }
      yield { type: 'stop' }
    })

    const critique = new SelfCritique({ enabled: true })
    const llm: Llm = {
      chat: async function* () {
        yield {
          type: 'text',
          content: JSON.stringify({ safe: true, correct: true, necessary: true, reasoning: 'ok' }),
        }
        yield { type: 'stop' }
      },
    }

    const result = await critique.critique('Bash', { command: 'ls' }, registry, llm)

    expect(result).not.toBeNull()
    expect(result?.safe).toBe(true)
    expect(result?.score).toBe(1)
    expect(registryChatCalled).toBe(false)
  })

  it('falls back to registry.chat when no llm is provided', async () => {
    const registry = mockProviderRegistry(async function* () {
      yield {
        type: 'text',
        content: JSON.stringify({
          safe: true,
          correct: true,
          necessary: true,
          reasoning: 'registry fallback',
        }),
      }
      yield { type: 'stop' }
    })

    const critique = new SelfCritique({ enabled: true })
    const result = await critique.critique('Bash', { command: 'ls' }, registry)

    expect(result).not.toBeNull()
    expect(result?.safe).toBe(true)
  })
})
