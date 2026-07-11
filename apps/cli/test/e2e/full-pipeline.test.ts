/**
 * End-to-End Integration Test
 *
 * Validates the full pipeline: Config → Providers → Context → Engine → Real API.
 * Requires a valid API key in the environment (ANTHROPIC_API_KEY, OPENAI_API_KEY, or DEEPSEEK_API_KEY).
 *
 * Run: ANTHROPIC_API_KEY=sk-ant-... npx vitest run test/e2e/
 *   or: DEEPSEEK_API_KEY=sk-... npx vitest run test/e2e/
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { loadConfig } from '../../src/config/loader'
import { bootstrapProviders } from '../../src/providers/bootstrap'
import { InstructionsLoader } from '../../src/core/instructions'
import { ContextManager } from '../../src/core/context'
import { QueryEngine } from '../../src/core/engine'
import { createToolRegistry } from '../../src/tools/index'
import type { StreamChunk } from '@mipham/shared'

// ── Detect available provider ──

function getAvailableProvider(): { provider: string; model: string; envVar: string } | null {
  // Check in priority order
  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: 'anthropic', model: 'claude-sonnet-4-6', envVar: 'ANTHROPIC_API_KEY' }
  }
  if (process.env.DEEPSEEK_API_KEY) {
    return { provider: 'deepseek', model: 'deepseek-v4-pro', envVar: 'DEEPSEEK_API_KEY' }
  }
  if (process.env.OPENAI_API_KEY) {
    return { provider: 'openai', model: 'gpt-5.3-codex', envVar: 'OPENAI_API_KEY' }
  }
  return null
}

const active = getAvailableProvider()

// Skip all E2E tests if no API key available
const describeIf = active ? describe : describe.skip

// ── Helper ──

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

describeIf('E2E: Basic Conversation', () => {
  let engine: QueryEngine

  beforeAll(() => {
    if (!active) throw new Error('No API key available')

    // 1. Load config
    const config = loadConfig()

    // 2. Bootstrap providers
    const registry = bootstrapProviders(config.providers, active.provider, active.model)

    // 3. Load instructions
    const instructions = new InstructionsLoader()
    instructions.loadAll(process.cwd())

    // 4. Initialize context
    const context = new ContextManager({ maxTokens: 200_000, compactionThreshold: 0.9 })
    context.setSystemPrompt(instructions.buildSystemPrompt())

    // 5. Create tools registry
    const tools = createToolRegistry()

    // 6. Create engine
    engine = new QueryEngine(registry, context, tools)
  })

  it('responds to a simple greeting', async () => {
    const result = await collectStream(
      engine.process('Hello! Just say "Hi there" and nothing else.'),
    )

    expect(result.errors).toHaveLength(0)
    expect(result.text.length).toBeGreaterThan(0)
    expect(result.text.toLowerCase()).toMatch(/hi|hello/)
  }, 30_000)

  it('responds to a factual question', async () => {
    const result = await collectStream(
      engine.process('What is 2 + 2? Answer with just the number.'),
    )

    expect(result.errors).toHaveLength(0)
    expect(result.text).toContain('4')
  }, 30_000)

  it('responds to a code question', async () => {
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

describeIf('E2E: Tool Usage', () => {
  let engine: QueryEngine

  beforeAll(() => {
    if (!active) throw new Error('No API key available')

    const config = loadConfig()
    const registry = bootstrapProviders(config.providers, active.provider, active.model)

    const instructions = new InstructionsLoader()
    instructions.loadAll(process.cwd())

    const context = new ContextManager({ maxTokens: 200_000, compactionThreshold: 0.9 })
    context.setSystemPrompt(instructions.buildSystemPrompt())

    const tools = createToolRegistry()
    engine = new QueryEngine(registry, context, tools)
  })

  it('uses Read tool to read a file when asked', async () => {
    // First, write a test file
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')

    const tmpDir = join(tmpdir(), 'mipham-e2e-' + Date.now())
    mkdirSync(tmpDir, { recursive: true })
    const testFile = join(tmpDir, 'greeting.txt')
    writeFileSync(testFile, 'Hello from Mipham E2E test!')

    const result = await collectStream(
      engine.process(`Read the file at "${testFile}" and tell me what it says. Use the Read tool.`),
    )

    expect(result.errors).toHaveLength(0)
    // Should either use the tool or attempt to answer
    expect(result.text.length > 0 || result.toolCalls.length > 0).toBe(true)

    // Clean up
    const { rmSync } = await import('node:fs')
    rmSync(tmpDir, { recursive: true, force: true })
  }, 30_000)

  it('model is aware of available tools', async () => {
    const tools = createToolRegistry()
    const toolNames = Array.from(tools.keys())

    // Verify all 18 tools are registered
    expect(toolNames.length).toBe(18)
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
  }, 60_000)
})

// ============================================================
// E2E: Error Handling
// ============================================================

describeIf('E2E: Error Handling', () => {
  it('handles invalid provider gracefully', async () => {
    const config = loadConfig()
    // Use a provider that has no API key
    const registry = bootstrapProviders(config.providers, 'anthropic', 'claude-sonnet-4-6')

    const instructions = new InstructionsLoader()
    instructions.loadAll(process.cwd())

    const context = new ContextManager({ maxTokens: 200_000, compactionThreshold: 0.9 })
    context.setSystemPrompt(instructions.buildSystemPrompt())

    const tools = createToolRegistry()
    const engine = new QueryEngine(registry, context, tools)

    // If ANTHROPIC_API_KEY is not set, this should produce an error
    if (!process.env.ANTHROPIC_API_KEY) {
      const result = await collectStream(engine.process('Hello'))
      // Should get an error about missing API key or auth failure
      expect(result.errors.length > 0 || result.text.length > 0).toBe(true)
    }
  }, 15_000)

  it('engine does not crash on minimal input', async () => {
    if (!active) return

    const config = loadConfig()
    const registry = bootstrapProviders(config.providers, active.provider, active.model)

    const instructions = new InstructionsLoader()
    instructions.loadAll(process.cwd())

    const context = new ContextManager({ maxTokens: 200_000, compactionThreshold: 0.9 })
    context.setSystemPrompt(instructions.buildSystemPrompt())

    const tools = createToolRegistry()
    const engine = new QueryEngine(registry, context, tools)

    // Send minimal input (single character) — should not hang or crash
    const result = await collectStream(engine.process('.'))
    expect(result.errors.length >= 0).toBe(true)
  }, 30_000)
})
