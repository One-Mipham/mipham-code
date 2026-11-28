/**
 * End-to-End Integration Test
 *
 * Validates the full pipeline: Config → Providers → Context → Engine → Tools.
 *
 * Two modes, same assertions where the engine (not the model) is the thing
 * under test:
 *
 *   - **Keyless (CI default)** — a scripted `Llm` (`replayChunks`) is injected
 *     through `engine.setLlm()`, so the run is deterministic and needs no
 *     network. This is the mode CI runs; it fails on a plumbing break.
 *   - **Live (opt-in)** — `MIPHAM_E2E_LIVE=1` plus one of ANTHROPIC_API_KEY /
 *     DEEPSEEK_API_KEY / OPENAI_API_KEY drives a real provider, which
 *     additionally exercises model behaviour. Opt-in rather than "a key is
 *     present": otherwise CI's secret environment would silently decide which
 *     mode the build ran in. Run it when touching provider code:
 *
 *       MIPHAM_E2E_LIVE=1 DEEPSEEK_API_KEY=sk-... npx vitest run test/e2e/
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'

// Isolate config loading from the real ~/.mipham — this E2E test calls loadConfig(),
// which auto-backs-up the user's live config.yml. Redirect homedir to a temp dir.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-e2e`,
  }
})

import { loadConfig } from '../../src/config/loader'
import { bootstrapProviders } from '../../src/providers/bootstrap'
import { InstructionsLoader } from '../../src/core/instructions'
import { ContextManager } from '../../src/core/context'
import { QueryEngine } from '../../src/core/engine'
import { createToolRegistry } from '../../src/tools/index'
import { replayChunks } from '../../src/providers/llm-replay'
import type { Llm } from '../../src/providers/llm'
import type { ChatRequest } from '../../src/providers/registry'
import type { StreamChunk } from '@mipham/shared'
import { REPLAY_STREAMS, readToolStream, READ_RESULT_TEXT } from './fixtures/replay-streams'

// ── Detect available provider ──

function getAvailableProvider(): { provider: string; model: string; envVar: string } | null {
  // Check in priority order — validate API key format, not just existence
  const antKey = process.env.ANTHROPIC_API_KEY
  if (antKey && antKey.startsWith('sk-ant-') && antKey.length > 20) {
    return { provider: 'anthropic', model: 'claude-sonnet-4-6', envVar: 'ANTHROPIC_API_KEY' }
  }
  const dsKey = process.env.DEEPSEEK_API_KEY
  if (dsKey && dsKey.startsWith('sk-') && dsKey.length > 20) {
    return { provider: 'deepseek', model: 'deepseek-v4-pro', envVar: 'DEEPSEEK_API_KEY' }
  }
  const oaKey = process.env.OPENAI_API_KEY
  if (oaKey && oaKey.startsWith('sk-') && oaKey.length > 20) {
    return { provider: 'openai', model: 'gpt-5.3-codex', envVar: 'OPENAI_API_KEY' }
  }
  return null
}

/** Non-null in live mode; `null` means "keyless — the model is scripted". */
const live = process.env.MIPHAM_E2E_LIVE === '1' ? getAvailableProvider() : null

// Keyless runs still need a registered active provider: the engine reads
// `registry.getActive()` for tool context and metrics even when the chat
// stream itself comes from the injected seam. These are the built-in defaults.
const provider = live?.provider ?? 'deepseek'
const model = live?.model ?? 'deepseek-flash'

// ── Helpers ──

function makeEngine(providerId = provider, modelId = model): QueryEngine {
  const config = loadConfig()
  const registry = bootstrapProviders(config.providers, providerId, modelId)

  const instructions = new InstructionsLoader()
  instructions.loadAll(process.cwd())

  const context = new ContextManager({ maxTokens: 200_000, compactionThreshold: 0.9 })
  context.setSystemPrompt(instructions.buildSystemPrompt())

  return new QueryEngine(registry, context, createToolRegistry())
}

/**
 * Keyless only: drive the engine with scripted streams and record what it sent.
 *
 * The recorded requests are the point — replay ignores them, so asserting on
 * the model's text alone would only prove the fixture was loaded. Asserting
 * that the *second* request carries the tool result / the prior turn proves the
 * engine wired them into the conversation.
 */
function script(engine: QueryEngine, sequences: StreamChunk[][], seen: ChatRequest[] = []): void {
  if (live) return
  const replay = replayChunks(sequences)
  const spy: Llm = {
    async *chat(req: ChatRequest) {
      seen.push(req)
      yield* replay.chat(req)
    },
  }
  engine.setLlm(spy)
}

async function collectStream(chunks: AsyncGenerator<StreamChunk>): Promise<{
  text: string
  toolCalls: string[]
  errors: string[]
}> {
  let text = ''
  const toolCalls: string[] = []
  const errors: string[] = []

  for await (const chunk of chunks) {
    switch (chunk.type) {
      case 'text':
        if (chunk.content) text += chunk.content
        break
      case 'tool_use':
        if (chunk.toolUse) toolCalls.push(chunk.toolUse.name)
        break
      case 'error':
        if (chunk.error) errors.push(chunk.error)
        break
    }
  }

  return { text, toolCalls, errors }
}

// ============================================================
// E2E: Basic Conversation
// ============================================================

describe('E2E: Basic Conversation', () => {
  let engine: QueryEngine

  beforeAll(() => {
    engine = makeEngine()
  })

  it('responds to a simple greeting', async () => {
    script(engine, REPLAY_STREAMS.greeting)
    const result = await collectStream(
      engine.process('Hello! Just say "Hi there" and nothing else.'),
    )

    expect(result.errors).toHaveLength(0)
    expect(result.text.length).toBeGreaterThan(0)
    expect(result.text.toLowerCase()).toMatch(/hi|hello/)
  }, 30_000)

  it('responds to a factual question', async () => {
    script(engine, REPLAY_STREAMS.math)
    const result = await collectStream(
      engine.process('What is 2 + 2? Answer with just the number.'),
    )

    expect(result.errors).toHaveLength(0)
    expect(result.text).toContain('4')
  }, 30_000)

  it('responds to a code question', async () => {
    script(engine, REPLAY_STREAMS.code)
    const result = await collectStream(
      engine.process(
        'Write a one-line TypeScript function that adds two numbers. Output ONLY the code, no explanation.',
      ),
    )

    expect(result.errors).toHaveLength(0)
    expect(result.text).toContain('add')
  }, 30_000)
})

// ============================================================
// E2E: Tool Usage
// ============================================================

describe('E2E: Tool Usage', () => {
  let engine: QueryEngine

  beforeAll(() => {
    engine = makeEngine()
  })

  it('uses Read tool to read a file when asked', async () => {
    // The file must live inside the engine's workspace: Read resolves paths
    // against `ctx.cwd` and rejects anything outside it (a real guard, not a
    // test artefact), so a tmpdir outside the repo would fail the tool.
    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')

    const tmpDir = join(process.cwd(), `.e2e-tmp-${process.pid}-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
    const testFile = join(tmpDir, 'greeting.txt')
    writeFileSync(testFile, READ_RESULT_TEXT)

    try {
      const seen: ChatRequest[] = []
      script(engine, readToolStream(testFile), seen)

      const result = await collectStream(
        engine.process(
          `Read the file at "${testFile}" and tell me what it says. Use the Read tool.`,
        ),
      )

      expect(result.errors).toHaveLength(0)
      if (!live) {
        // Keyless: the scripted model did call Read, the tool ran, and the next
        // request carried the file's contents back to the model.
        expect(result.toolCalls).toContain('Read')
        expect(seen.length).toBeGreaterThanOrEqual(2)
        expect(JSON.stringify(seen[1]!.messages)).toContain(READ_RESULT_TEXT)
      } else {
        // Live: a model may decline the tool and answer directly.
        expect(result.text.length > 0 || result.toolCalls.length > 0).toBe(true)
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('model is aware of available tools', async () => {
    const tools = createToolRegistry()
    const toolNames = Array.from(tools.keys())

    // Verify all tools are registered (16 built-in + MCP + Workflow + Agent + Scheduling)
    expect(toolNames.length).toBe(31)
    expect(toolNames).toContain('Read')
    expect(toolNames).toContain('Write')
    expect(toolNames).toContain('Edit')
    expect(toolNames).toContain('Bash')
    expect(toolNames).toContain('Git')
    expect(toolNames).toContain('Glob')
    expect(toolNames).toContain('Grep')
    expect(toolNames).toContain('Task')
    expect(toolNames).toContain('Agent')
    expect(toolNames).toContain('Skill')
    expect(toolNames).toContain('Plan')
    expect(toolNames).toContain('Memory')
    expect(toolNames).toContain('WebFetch')
    expect(toolNames).toContain('WebSearch')
    expect(toolNames).toContain('Config')
    expect(toolNames).toContain('MCP')
    expect(toolNames).toContain('Artifact')
    expect(toolNames).toContain('ComputerUse')
  })

  it('responds to a multi-turn conversation', async () => {
    const seen: ChatRequest[] = []
    script(engine, REPLAY_STREAMS.multiTurn, seen)

    // First turn
    const r1 = await collectStream(
      engine.process('My name is Alice. Remember that. Reply "OK Alice" and nothing else.'),
    )
    expect(r1.errors).toHaveLength(0)
    expect(r1.text.toLowerCase()).toContain('alice')

    // Second turn — model should remember context
    const r2 = await collectStream(engine.process('What is my name? Reply with just my name.'))
    expect(r2.errors).toHaveLength(0)
    expect(r2.text.toLowerCase()).toContain('alice')

    if (!live) {
      // The replay answers "Alice" no matter what; the proof that context was
      // preserved is the second request carrying the first turn.
      expect(seen.length).toBe(2)
      expect(JSON.stringify(seen[1]!.messages)).toContain('Alice')
    }
  }, 60_000)
})

// ============================================================
// E2E: Error Handling
// ============================================================

describe('E2E: Error Handling', () => {
  it('surfaces a provider failure instead of crashing', async () => {
    if (!live) {
      const engine = makeEngine()
      script(engine, REPLAY_STREAMS.providerFailure)

      const result = await collectStream(engine.process('Hello'))

      expect(result.errors.join(' ')).toContain('simulated provider failure')
      return
    }

    // Live mode: a provider with no API key must answer with an error, not hang.
    if (process.env.ANTHROPIC_API_KEY) return
    const engine = makeEngine('anthropic', 'claude-sonnet-4-6')
    const result = await collectStream(engine.process('Hello'))
    expect(result.errors.length > 0 || result.text.length > 0).toBe(true)
  }, 15_000)

  it('engine does not crash on minimal input', async () => {
    const engine = makeEngine()
    script(engine, REPLAY_STREAMS.minimal)

    // Send minimal input (single character) — should not hang or crash
    const result = await collectStream(engine.process('.'))
    expect(result.errors).toHaveLength(0)
  }, 30_000)
})
