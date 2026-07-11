# Tier 1 Core Capabilities — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the four Tier-1 subsystems (Subagent AI execution, Skills auto-trigger, Hook enhancement, Context multi-layer compaction) as defined in `docs/superpowers/specs/2026-07-11-tier1-core-capabilities-design.md`.

**Architecture:** Four subsystems implemented in dependency order: Subagent (foundation for Skills fork) → Context (foundation for Hook events) → Hook → Skills. Each subsystem adds new files alongside existing ones, extends shared types, and preserves backward compatibility with all 295 existing tests.

**Tech Stack:** TypeScript 5.5+ strict, Bun runtime, Vitest 3, Node.js fs/path APIs for file loading

## Global Constraints

- TypeScript strict mode, ESM modules
- Match existing code style (naming, comments, error handling patterns)
- All existing 295 tests must continue to pass
- Backward compatible: no breaking changes to public APIs
- Commit messages follow Conventional Commits
- Test framework: Vitest 3 with existing mock patterns from `test/__mocks__/bun.ts`

---

## File Structure Map

```
apps/cli/src/
├── agent/
│   ├── sub-agent.ts          ← MODIFY: remove simulate(), force real AI
│   ├── agent-registry.ts     ← CREATE: load .mipham/agents/*.md + ~/.mipham/agents/*.md
│   ├── agent-context.ts      ← CREATE: isolated ContextManager + tool scoping
│   └── types.ts              ← CREATE: AgentDefinition, AgentFrontmatter
├── skills/
│   ├── loader.ts             ← MODIFY: description index, ~/.mipham/skills/ path
│   ├── auto-trigger.ts       ← CREATE: system-reminder injection builder
│   └── fork-executor.ts      ← CREATE: context:fork subagent execution
├── core/
│   ├── context.ts            ← MODIFY: add new interface methods, auto-check triggers
│   ├── context-snip.ts       ← CREATE: Layer 1 zero-cost pruning
│   ├── context-microcompact.ts ← CREATE: Layer 2 cache-aware compression
│   ├── context-compact.ts    ← CREATE: Layer 3 API summarization
│   ├── context-drain.ts      ← CREATE: Layer 4 413 emergency recovery
│   ├── context-token.ts      ← CREATE: enhanced token estimation
│   ├── hooks.ts              ← MODIFY: 5 new events, 4 hook types, extended HookResult
│   ├── hooks-config.ts       ← CREATE: settings.json hook loader
│   └── hooks-executor.ts     ← CREATE: command/http/code/mcp_tool dispatcher
├── tools/agent/
│   ├── agent.ts              ← MODIFY: wire agentRegistry, pass agentDef
│   └── skill.ts              ← MODIFY: fork routing, frontmatter context field
└── shared/
    └── types.ts              ← MODIFY: add HookConfig, AgentDefinition, CacheTracker types

apps/cli/test/
├── agent/
│   ├── sub-agent.test.ts     ← CREATE
│   └── agent-registry.test.ts ← CREATE
├── skills/
│   ├── auto-trigger.test.ts  ← CREATE
│   └── fork-executor.test.ts ← CREATE
└── core/
    ├── hooks.test.ts         ← CREATE (extend existing)
    ├── hooks-config.test.ts  ← CREATE
    ├── context-snip.test.ts  ← CREATE
    ├── context-microcompact.test.ts ← CREATE
    ├── context-compact.test.ts ← CREATE
    └── context-drain.test.ts ← CREATE
```

---

## Phase 1: Subagent Real AI Execution + Custom Agent Registry

### Task 1.1: Define Agent Types

**Files:**

- Create: `apps/cli/src/agent/types.ts`

**Interfaces:**

- Produces: `AgentDefinition`, `AgentFrontmatter`, `SubAgentType`, `SubAgentOptions`

- [ ] **Step 1: Create the types file**

```typescript
// apps/cli/src/agent/types.ts

export type SubAgentType = 'general' | 'explore' | 'plan' | 'code-review'

export interface AgentFrontmatter {
  name: string
  description: string
  tools?: string // comma-separated allowlist
  disallowedTools?: string
  model?: string // 'sonnet' | 'opus' | 'haiku' | 'inherit' | full model ID
  permissionMode?: 'default' | 'acceptEdits' | 'auto' | 'bypass' | 'plan'
  maxTurns?: number
  skills?: string
  background?: boolean
}

export interface AgentDefinition {
  name: string
  description: string
  systemPrompt: string // markdown body after frontmatter
  tools?: string
  disallowedTools?: string
  model: string
  permissionMode: string
  maxTurns?: number
  skills?: string[]
  background: boolean
  source: 'builtin' | 'project' | 'user'
  filePath?: string
}

export interface SubAgentOptions {
  type?: SubAgentType
  agentDef?: AgentDefinition
  systemPrompt?: string
  maxContextMessages?: number
  allowedTools?: string[]
  modelOverride?: string
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd apps/cli && pnpm typecheck
```

Expected: No new errors introduced.

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/agent/types.ts
git commit -m "feat(agent): add AgentDefinition and SubAgentOptions types"
```

---

### Task 1.2: Create Agent Registry

**Files:**

- Create: `apps/cli/src/agent/agent-registry.ts`

**Interfaces:**

- Produces: `AgentRegistry` class with `loadProjectAgents()`, `loadUserAgents()`, `get(name)`, `list()`, `resolve(name)`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/cli/test/agent/agent-registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AgentRegistry } from '../../src/agent/agent-registry'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), 'mipham-agent-test-' + Date.now())

function writeAgent(dir: string, name: string, body: string) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.md`), body, 'utf-8')
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('AgentRegistry', () => {
  it('loads a valid agent markdown file', () => {
    writeAgent(
      TEST_DIR,
      'test-agent',
      `---
name: test-agent
description: A test agent for unit tests.
tools: Read, Grep
model: haiku
---

You are a test agent. Do test things.`,
    )

    const registry = new AgentRegistry()
    registry.loadDirectory(TEST_DIR, 'project')

    const agent = registry.get('test-agent')
    expect(agent).toBeDefined()
    expect(agent!.name).toBe('test-agent')
    expect(agent!.description).toBe('A test agent for unit tests.')
    expect(agent!.tools).toBe('Read, Grep')
    expect(agent!.model).toBe('haiku')
    expect(agent!.source).toBe('project')
    expect(agent!.systemPrompt).toContain('You are a test agent.')
  })

  it('returns undefined for unknown agent', () => {
    const registry = new AgentRegistry()
    expect(registry.get('nonexistent')).toBeUndefined()
  })

  it('lists all loaded agents', () => {
    writeAgent(
      TEST_DIR,
      'agent-a',
      `---
name: agent-a
description: First agent.
---\nBody A`,
    )

    writeAgent(
      TEST_DIR,
      'agent-b',
      `---
name: agent-b
description: Second agent.
---\nBody B`,
    )

    const registry = new AgentRegistry()
    registry.loadDirectory(TEST_DIR, 'project')

    const list = registry.list()
    expect(list).toHaveLength(2)
    expect(list.map((a) => a.name).sort()).toEqual(['agent-a', 'agent-b'])
  })

  it('applies defaults for missing frontmatter fields', () => {
    writeAgent(
      TEST_DIR,
      'minimal',
      `---
name: minimal
description: Minimal agent.
---\nMinimal body.`,
    )

    const registry = new AgentRegistry()
    registry.loadDirectory(TEST_DIR, 'project')

    const agent = registry.get('minimal')!
    expect(agent.model).toBe('inherit')
    expect(agent.permissionMode).toBe('inherit')
    expect(agent.background).toBe(false)
    expect(agent.tools).toBeUndefined()
  })

  it('project agents override user agents with same name', () => {
    const projectDir = join(TEST_DIR, 'project')
    const userDir = join(TEST_DIR, 'user')

    writeAgent(
      projectDir,
      'same-name',
      `---
name: same-name
description: Project version.
---\nProject body.`,
    )

    writeAgent(
      userDir,
      'same-name',
      `---
name: same-name
description: User version.
---\nUser body.`,
    )

    const registry = new AgentRegistry()
    registry.loadDirectory(userDir, 'user')
    registry.loadDirectory(projectDir, 'project')

    const agent = registry.get('same-name')!
    expect(agent.description).toBe('Project version.')
  })

  it('handles empty directory gracefully', () => {
    mkdirSync(TEST_DIR, { recursive: true })
    const registry = new AgentRegistry()
    registry.loadDirectory(TEST_DIR, 'project')
    expect(registry.list()).toHaveLength(0)
  })

  it('skips files without .md extension', () => {
    writeAgent(
      TEST_DIR,
      'agent',
      `---
name: agent
description: Test.
---\nBody`,
    )
    writeFileSync(join(TEST_DIR, 'readme.txt'), 'not an agent', 'utf-8')

    const registry = new AgentRegistry()
    registry.loadDirectory(TEST_DIR, 'project')

    expect(registry.list()).toHaveLength(1)
  })

  it('resolves builtin agents when no custom agent matches', () => {
    const registry = new AgentRegistry()
    const def = registry.resolve('explore')
    expect(def).toBeDefined()
    expect(def!.name).toBe('explore')
    expect(def!.source).toBe('builtin')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/cli && bun test test/agent/agent-registry.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement AgentRegistry**

```typescript
// apps/cli/src/agent/agent-registry.ts
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { AgentDefinition, AgentFrontmatter, SubAgentType } from './types'

interface FrontmatterResult {
  data: Record<string, unknown>
  content: string
}

function parseFrontmatter(raw: string): FrontmatterResult {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) {
    return { data: {}, content: raw }
  }
  return {
    data: parseYaml(match[1] || '') as Record<string, unknown>,
    content: (match[2] || '').trim(),
  }
}

const BUILTIN_SYSTEM_PROMPTS: Record<SubAgentType, string> = {
  general: 'You are a focused sub-agent. Complete the assigned task thoroughly and return results.',
  explore:
    'You are an exploration sub-agent. Search, read, and analyze code. Return structured findings with file paths and line numbers.',
  plan: 'You are a planning sub-agent. Design implementation approaches. Return a step-by-step plan with files to modify.',
  'code-review':
    'You are a code review sub-agent. Find bugs, security issues, and code quality problems. Return findings by severity.',
}

const BUILTIN_DESCRIPTIONS: Record<SubAgentType, string> = {
  general: 'General-purpose agent for complex multi-step tasks.',
  explore: 'Read-only search agent for broad fan-out searches across files.',
  plan: 'Software architect agent for designing implementation plans.',
  'code-review': 'Code review agent for finding bugs and quality issues.',
}

export class AgentRegistry {
  private agents = new Map<string, AgentDefinition>()

  /** Load agents from a directory. Later loads override earlier ones for same name. */
  loadDirectory(dir: string, source: 'project' | 'user'): void {
    if (!existsSync(dir)) return

    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }

    for (const entry of entries) {
      if (extname(entry) !== '.md') continue
      const fullPath = join(dir, entry)
      try {
        const raw = readFileSync(fullPath, 'utf-8')
        const { data, content } = parseFrontmatter(raw)

        const name = (data.name as string) || entry.replace(/\.md$/, '')
        const def: AgentDefinition = {
          name,
          description: (data.description as string) || '',
          systemPrompt: content,
          tools: data.tools as string | undefined,
          disallowedTools: data.disallowedTools as string | undefined,
          model: (data.model as string) || 'inherit',
          permissionMode: (data.permissionMode as string) || 'inherit',
          maxTurns: data.maxTurns as number | undefined,
          skills: data.skills
            ? String(data.skills)
                .split(',')
                .map((s) => s.trim())
            : undefined,
          background: (data.background as boolean) || false,
          source,
          filePath: fullPath,
        }

        this.agents.set(name, def)
      } catch {
        // Skip unparseable files
      }
    }
  }

  /** Load project-level agents from .mipham/agents/ */
  loadProjectAgents(cwd: string): void {
    this.loadDirectory(join(cwd, '.mipham', 'agents'), 'project')
  }

  /** Load user-level agents from ~/.mipham/agents/ */
  loadUserAgents(): void {
    const home = process.env.HOME || '~'
    this.loadDirectory(join(home, '.mipham', 'agents'), 'user')
  }

  /** Get a custom agent by name. Returns undefined for builtins. */
  get(name: string): AgentDefinition | undefined {
    return this.agents.get(name)
  }

  /** List all custom agents. */
  list(): AgentDefinition[] {
    return Array.from(this.agents.values())
  }

  /**
   * Resolve an agent name to its definition.
   * Priority: custom (project) > custom (user) > builtin.
   * Builtins are always available and never return undefined.
   */
  resolve(name: string): AgentDefinition | undefined {
    const custom = this.agents.get(name)
    if (custom) return custom

    // Check if it's a builtin type
    const builtinType = name as SubAgentType
    if (BUILTIN_SYSTEM_PROMPTS[builtinType]) {
      return {
        name: builtinType,
        description: BUILTIN_DESCRIPTIONS[builtinType],
        systemPrompt: BUILTIN_SYSTEM_PROMPTS[builtinType],
        model: 'inherit',
        permissionMode: 'inherit',
        background: false,
        source: 'builtin',
      }
    }

    return undefined
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/cli && bun test test/agent/agent-registry.test.ts
```

Expected: 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/agent/agent-registry.ts apps/cli/test/agent/agent-registry.test.ts
git commit -m "feat(agent): add AgentRegistry for custom agent markdown files"
```

---

### Task 1.3: Create Agent Context Factory

**Files:**

- Create: `apps/cli/src/agent/agent-context.ts`

**Interfaces:**

- Consumes: `AgentDefinition` from types.ts, `ContextManager` from core/context.ts
- Produces: `createAgentContext(def, toolRegistry, summarizer?)` → `{ context, allowedTools }`

- [ ] **Step 1: Write the failing test**

No separate test file — this factory is tested implicitly via the SubAgent integration test in Task 1.4.

- [ ] **Step 2: Implement agent-context.ts**

```typescript
// apps/cli/src/agent/agent-context.ts
import { ContextManager } from '../core/context'
import type { ToolDefinition } from '../shared/index.ts'
import type { AgentDefinition } from './types'

export interface AgentContextResult {
  context: ContextManager
  allowedTools: ToolDefinition[]
}

/**
 * Create an isolated context and tool set for a sub-agent.
 *
 * Tool scoping rules (first match wins):
 * 1. If `tools` is set, only those tools are allowed.
 * 2. If `disallowedTools` is set, those are removed from the full set.
 * 3. If neither is set, all tools are available.
 */
export function createAgentContext(
  agentDef: AgentDefinition,
  toolRegistry: Map<string, ToolDefinition>,
  contextWindow?: number,
): AgentContextResult {
  // Create isolated context
  const context = new ContextManager({
    maxTokens: contextWindow || 100_000,
    compactionThreshold: 0.85,
  })

  context.setSystemPrompt(agentDef.systemPrompt)

  // Scope tools
  let allowedTools = Array.from(toolRegistry.values())

  if (agentDef.tools) {
    const allowSet = new Set(
      agentDef.tools
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    allowedTools = allowedTools.filter((t) => allowSet.has(t.name))
  }

  if (agentDef.disallowedTools) {
    const denySet = new Set(
      agentDef.disallowedTools
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    allowedTools = allowedTools.filter((t) => !denySet.has(t.name))
  }

  return { context, allowedTools }
}
```

- [ ] **Step 3: Verify compilation**

```bash
cd apps/cli && pnpm typecheck
```

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/agent/agent-context.ts
git commit -m "feat(agent): add agent context factory with tool scoping"
```

---

### Task 1.4: Refactor SubAgent to Force Real AI

**Files:**

- Modify: `apps/cli/src/agent/sub-agent.ts`
- Create: `apps/cli/test/agent/sub-agent.test.ts`

**Interfaces:**

- Consumes: `AgentDefinition`, `SubAgentOptions` from types.ts; `AgentRegistry` from agent-registry.ts; `createAgentContext` from agent-context.ts
- Produces: `SubAgent` class — `execute()` returns real AI result, no simulate fallback

- [ ] **Step 1: Write the failing test**

```typescript
// apps/cli/test/agent/sub-agent.test.ts
import { describe, it, expect, vi } from 'vitest'
import { SubAgent } from '../../src/agent/sub-agent'
import { AgentRegistry } from '../../src/agent/agent-registry'
import type { ProviderRegistry, ProviderInstance, ChatRequest } from '../../src/providers/registry'
import type { ToolDefinition, StreamChunk } from '../../src/shared/index.ts'
import { ContextManager } from '../../src/core/context'

function createMockProvider(chunks: StreamChunk[]): ProviderInstance {
  return {
    config: { id: 'mock', name: 'Mock', protocol: 'openai-compatible', apiKey: '', models: [] },
    async *chat(_req: ChatRequest): AsyncGenerator<StreamChunk> {
      for (const chunk of chunks) {
        yield chunk
      }
    },
    async listModels() {
      return []
    },
    async healthCheck() {
      return true
    },
  }
}

function createMockRegistry(provider: ProviderInstance): ProviderRegistry {
  const registry = {
    getActive: () => provider,
    getActiveModel: () => 'mock-model',
  } as unknown as ProviderRegistry
  return registry
}

const TOOLS = new Map<string, ToolDefinition>()

describe('SubAgent', () => {
  it('returns AI-generated text for general type', async () => {
    const provider = createMockProvider([
      { type: 'text', content: 'Task analysis complete.' },
      { type: 'stop' },
    ])
    const registry = createMockRegistry(provider)

    const sub = new SubAgent(registry, TOOLS)
    const result = await sub.execute('analyze this', 'analysis task', { type: 'general' })

    expect(result).toContain('Task analysis complete.')
  })

  it('throws when no active provider is available', async () => {
    const registry = {
      getActive: () => undefined,
      getActiveModel: () => '',
    } as unknown as ProviderRegistry

    const sub = new SubAgent(registry, TOOLS)
    await expect(sub.execute('test', 'test task', { type: 'general' })).rejects.toThrow(
      'No active provider',
    )
  })

  it('throws on API error chunk', async () => {
    const provider = createMockProvider([{ type: 'error', error: 'API rate limit exceeded' }])
    const registry = createMockRegistry(provider)

    const sub = new SubAgent(registry, TOOLS)
    await expect(sub.execute('test', 'test task', { type: 'general' })).rejects.toThrow(
      'API rate limit exceeded',
    )
  })

  it('uses agent definition system prompt when provided', async () => {
    let receivedSystemPrompt = ''
    const provider = createMockProvider([{ type: 'text', content: 'ok' }, { type: 'stop' }])
    // Spy on chat to capture system prompt
    const originalChat = provider.chat
    provider.chat = async function* (req) {
      receivedSystemPrompt = req.systemPrompt || ''
      yield* originalChat.call(provider, req)
    }

    const registry = createMockRegistry(provider)
    const agentDef = {
      name: 'custom',
      description: 'custom agent',
      systemPrompt: 'You are a custom agent. Be concise.',
      model: 'inherit',
      permissionMode: 'inherit',
      background: false,
      source: 'project' as const,
    }

    const sub = new SubAgent(registry, TOOLS)
    await sub.execute('test', 'test task', { agentDef })

    expect(receivedSystemPrompt).toBe('You are a custom agent. Be concise.')
  })

  it('scopes tools based on agent definition allowlist', async () => {
    let receivedTools: Record<string, unknown>[] | undefined
    const provider = createMockProvider([{ type: 'text', content: 'ok' }, { type: 'stop' }])
    const originalChat = provider.chat
    provider.chat = async function* (req) {
      receivedTools = req.tools
      yield* originalChat.call(provider, req)
    }

    const registry = createMockRegistry(provider)

    const readTool: ToolDefinition = {
      name: 'Read',
      description: 'read',
      category: 'file',
      permission: 'auto',
      parameters: {},
      execute: async () => ({ success: true, content: '' }),
    }
    const writeTool: ToolDefinition = {
      name: 'Write',
      description: 'write',
      category: 'file',
      permission: 'ask',
      parameters: {},
      execute: async () => ({ success: true, content: '' }),
    }
    const tools = new Map([
      ['Read', readTool],
      ['Write', writeTool],
    ])

    const agentDef = {
      name: 'reader',
      description: 'read only',
      systemPrompt: 'Read only.',
      tools: 'Read',
      model: 'inherit',
      permissionMode: 'inherit',
      background: false,
      source: 'project' as const,
    }

    const sub = new SubAgent(registry, tools)
    await sub.execute('test', 'test task', { agentDef })

    expect(receivedTools).toBeDefined()
    expect(receivedTools!).toHaveLength(1)
    expect(receivedTools![0]!.name).toBe('Read')
  })

  it('does not return simulate-style template text', async () => {
    const provider = createMockProvider([
      { type: 'text', content: 'Real AI response.' },
      { type: 'stop' },
    ])
    const registry = createMockRegistry(provider)

    const sub = new SubAgent(registry, TOOLS)
    const result = await sub.execute('test', 'test task', { type: 'explore' })

    // Must NOT contain simulation template markers
    expect(result).not.toContain('Sub-Agent Result')
    expect(result).not.toContain('simulation mode')
    expect(result).not.toContain('would search the codebase')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/cli && bun test test/agent/sub-agent.test.ts
```

Expected: FAIL — SubAgent still returns simulate text.

- [ ] **Step 3: Rewrite SubAgent to force real AI**

```typescript
// apps/cli/src/agent/sub-agent.ts
import type { ProviderRegistry, ProviderInstance } from '../providers/registry'
import type { ToolDefinition } from '../shared/index.ts'
import type { SubAgentType, SubAgentOptions, AgentDefinition } from './types'
import { createAgentContext } from './agent-context'

const TYPE_SYSTEM_PROMPTS: Record<SubAgentType, string> = {
  general: 'You are a focused sub-agent. Complete the assigned task thoroughly and return results.',
  explore:
    'You are an exploration sub-agent. Search, read, and analyze code. Return structured findings with file paths and line numbers.',
  plan: 'You are a planning sub-agent. Design implementation approaches. Return a step-by-step plan with files to modify.',
  'code-review':
    'You are a code review sub-agent. Find bugs, security issues, and code quality problems. Return findings by severity.',
}

/**
 * Sub-agent engine — creates an isolated conversation context and processes
 * a single prompt independently via the active AI provider. Returns the
 * consolidated result text.
 */
export class SubAgent {
  constructor(
    private registry: ProviderRegistry,
    private toolRegistry: Map<string, ToolDefinition>,
  ) {}

  async execute(
    prompt: string,
    description: string,
    options: SubAgentOptions = {},
  ): Promise<string> {
    const provider = this.registry.getActive()
    if (!provider) {
      throw new Error('No active provider available for sub-agent execution')
    }

    const model = this.registry.getActiveModel()
    const type = options.type || 'general'
    const agentDef = options.agentDef

    // Resolve system prompt: agentDef > options.systemPrompt > builtin type
    const systemPrompt = agentDef?.systemPrompt || options.systemPrompt || TYPE_SYSTEM_PROMPTS[type]

    // Create isolated context with tool scoping
    const resolvedDef: AgentDefinition = agentDef || {
      name: type,
      description: '',
      systemPrompt,
      model: options.modelOverride || 'inherit',
      permissionMode: 'inherit',
      background: false,
      source: 'builtin',
    }
    const { context, allowedTools } = createAgentContext(
      resolvedDef,
      this.toolRegistry,
      options.maxContextMessages,
    )

    context.setSystemPrompt(systemPrompt)
    context.addMessage({ role: 'user', content: prompt })

    const messages = context.getMessages()
    const toolDefs =
      allowedTools.length > 0
        ? allowedTools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
            input_schema: t.parameters,
          }))
        : undefined

    const modelToUse = options.modelOverride || agentDef?.model || model
    // 'inherit' means use parent model
    const resolvedModel = modelToUse === 'inherit' ? model : modelToUse

    const chunks: string[] = []

    try {
      for await (const chunk of provider.chat({
        model: resolvedModel,
        messages,
        systemPrompt,
        tools: toolDefs,
        maxTokens: 4096,
      })) {
        if (chunk.type === 'text' && chunk.content) {
          chunks.push(chunk.content)
        }
        if (chunk.type === 'error') {
          throw new Error(`Sub-agent execution failed: ${chunk.error}`)
        }
        if (chunk.type === 'stop') {
          break
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Sub-agent')) {
        throw err
      }
      throw new Error(`Sub-agent execution failed: ${String(err)}`)
    }

    return chunks.join('')
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/cli && bun test test/agent/sub-agent.test.ts
```

Expected: 6 tests PASS.

- [ ] **Step 5: Run existing tests to check for regressions**

```bash
cd apps/cli && bun test
```

Expected: All 295 existing tests continue to pass. Agent-related tests may need minor mock updates.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/agent/sub-agent.ts apps/cli/test/agent/sub-agent.test.ts
git commit -m "feat(agent): refactor SubAgent for real AI execution, remove simulate fallback"
```

---

### Task 1.5: Wire AgentRegistry into Agent Tool

**Files:**

- Modify: `apps/cli/src/tools/agent/agent.ts`
- Modify: `apps/cli/src/shared/types.ts` (add agentRegistry to ToolContext)

**Interfaces:**

- Consumes: `AgentRegistry` from agent-registry.ts
- Produces: Updated `agentTool` that uses registry and sub-agent with real AI

- [ ] **Step 1: Update shared types**

Add to `ToolContext` in `apps/cli/src/shared/types.ts`:

```typescript
// Add after existing fields in ToolContext interface:
  agentRegistry?: import('../agent/agent-registry').AgentRegistry
```

- [ ] **Step 2: Rewrite agent tool**

```typescript
// apps/cli/src/tools/agent/agent.ts
import type { ToolDefinition } from '../../shared/index.ts'
import { SubAgent, type SubAgentType } from '../../agent/sub-agent'
import type { AgentRegistry } from '../../agent/agent-registry'

const VALID_TYPES: SubAgentType[] = ['general', 'explore', 'plan', 'code-review']

export const agentTool: ToolDefinition = {
  name: 'Agent',
  description:
    'Launch a sub-agent to handle complex, multi-step tasks independently. Available types: general, explore, plan, code-review.',
  category: 'agent',
  permission: 'ask',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short description of the task' },
      prompt: { type: 'string', description: 'The task for the agent to perform' },
      subagent_type: {
        type: 'string',
        description: 'Type: general (default), explore (code search), plan (design), code-review',
      },
    },
    required: ['description', 'prompt'],
  },
  async execute(params, ctx) {
    const description = params.description as string
    const prompt = params.prompt as string
    const agentType = (params.subagent_type as SubAgentType) || 'general'

    if (!VALID_TYPES.includes(agentType)) {
      return {
        success: false,
        content: '',
        error: `Invalid subagent_type "${agentType}". Valid types: ${VALID_TYPES.join(', ')}`,
      }
    }

    const registry = ctx.registry
    if (!registry) {
      return {
        success: false,
        content: '',
        error: 'Provider registry not available. Cannot execute sub-agent.',
      }
    }

    // Resolve agent definition from registry (custom > builtin)
    const agentRegistry: AgentRegistry | undefined = ctx.agentRegistry
    const agentDef = agentRegistry?.resolve(agentType)

    const toolRegistry = ctx.registry
      ? (ctx as unknown as { _toolRegistry?: Map<string, ToolDefinition> })._toolRegistry
      : undefined

    // We need access to the full tool map. For now, create a basic one
    // or get it from the engine. This will be wired in Task 1.6.
    const sub = new SubAgent(registry, toolRegistry || new Map())
    try {
      const result = await sub.execute(prompt, description, {
        type: agentType,
        agentDef,
      })
      return { success: true, content: result }
    } catch (err) {
      return {
        success: false,
        content: '',
        error: `Sub-agent execution error: ${String(err)}`,
      }
    }
  },
}
```

- [ ] **Step 3: Verify compilation**

```bash
cd apps/cli && pnpm typecheck
```

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/tools/agent/agent.ts apps/cli/src/shared/types.ts
git commit -m "feat(agent): wire AgentRegistry into Agent tool"
```

---

### Task 1.6: Wire Tool Registry into Engine and App

**Files:**

- Modify: `apps/cli/src/core/engine.ts` (expose tool registry + agent registry)
- Modify: `apps/cli/src/ui/app.tsx` (pass agent registry)

- [ ] **Step 1: Expose tool registry from engine**

Add to `QueryEngine` in `apps/cli/src/core/engine.ts`:

```typescript
// Add field:
private agentRegistry?: import('../agent/agent-registry').AgentRegistry

// Add method:
setAgentRegistry(reg: import('../agent/agent-registry').AgentRegistry): void {
  this.agentRegistry = reg
}

getAgentRegistry(): import('../agent/agent-registry').AgentRegistry | undefined {
  return this.agentRegistry
}

// Modify executeTool to pass agentRegistry in context:
// In the executeTool method, ensure ToolContext includes agentRegistry.
// This is done via the tool execution context which is built in bin/mipham.ts.
```

- [ ] **Step 2: Wire in app.tsx**

```typescript
// In App component, after engine creation:
import { AgentRegistry } from '../agent/agent-registry'

// Inside App or the bootstrap code:
const agentRegistry = new AgentRegistry()
agentRegistry.loadUserAgents()
agentRegistry.loadProjectAgents(process.cwd())
engine.setAgentRegistry(agentRegistry)
```

- [ ] **Step 3: Verify existing tests still pass**

```bash
cd apps/cli && bun test
```

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/core/engine.ts apps/cli/src/ui/app.tsx
git commit -m "feat(agent): wire tool registry and agent registry through engine"
```

---

## Phase 2: Context Multi-Layer Compaction

### Task 2.1: Enhanced Token Estimation

**Files:**

- Create: `apps/cli/src/core/context-token.ts`

**Interfaces:**

- Produces: `estimateTokens(text)`, `CacheTracker` interface, `CacheStatus`

- [ ] **Step 1: Create the module**

```typescript
// apps/cli/src/core/context-token.ts

export interface CacheStatus {
  totalMessages: number
  cachedMessages: number
  cachedTokens: number
  uncachedTokens: number
}

export interface CacheTracker {
  isInCache(msg: unknown): boolean
  getStatus(): CacheStatus
  invalidate(msg: unknown): void
}

/**
 * Estimate token count for a text string.
 *
 * Character-class-aware heuristic:
 *   - CJK / emoji: ~1.5 chars per token
 *   - Other scripts: ~4 chars per token
 */
export function estimateTokens(text: string): number {
  if (!text) return 0

  let cjk = 0
  let latin = 0

  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x20000 && cp <= 0x2a6df) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0x3040 && cp <= 0x30ff) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0x1f300 && cp <= 0x1f9ff)
    ) {
      cjk++
    } else {
      latin++
    }
  }

  return Math.max(1, Math.ceil(cjk / 1.5 + latin / 4))
}

/** Estimate tokens for a message, including role overhead. */
export function estimateMessageTokens(msg: { role: string; content: unknown }): number {
  const roleTokens = 4 // approx overhead for role
  if (typeof msg.content === 'string') {
    return roleTokens + estimateTokens(msg.content)
  }
  if (Array.isArray(msg.content)) {
    let total = roleTokens
    for (const block of msg.content) {
      if (block && typeof block === 'object' && 'text' in block) {
        total += estimateTokens(String((block as { text: string }).text))
      } else {
        total += estimateTokens(JSON.stringify(block))
      }
    }
    return total
  }
  return roleTokens + estimateTokens(JSON.stringify(msg.content))
}

/** No-op cache tracker for when prompt caching is unavailable. */
export class NoopCacheTracker implements CacheTracker {
  isInCache(_msg: unknown): boolean {
    return false
  }
  getStatus(): CacheStatus {
    return { totalMessages: 0, cachedMessages: 0, cachedTokens: 0, uncachedTokens: 0 }
  }
  invalidate(_msg: unknown): void {}
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd apps/cli && pnpm typecheck
```

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/core/context-token.ts
git commit -m "feat(context): add enhanced token estimation and CacheTracker interface"
```

---

### Task 2.2: Layer 1 — Snip (Zero-Cost Pruning)

**Files:**

- Create: `apps/cli/src/core/context-snip.ts`
- Create: `apps/cli/test/core/context-snip.test.ts`

**Interfaces:**

- Produces: `snipMessages(messages)` → `{ messages, removed: number }`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/cli/test/core/context-snip.test.ts
import { describe, it, expect } from 'vitest'
import { snipMessages } from '../../src/core/context-snip'
import type { Message } from '../../src/shared/index.ts'

describe('snipMessages', () => {
  it('removes empty tool_result + preceding assistant pair', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: '1', name: 'Read', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: '1', content: '' }],
      },
      { role: 'assistant', content: 'final response' },
    ]

    const result = snipMessages(messages)
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]!.content).toBe('hello')
    expect(result.messages[1]!.content).toBe('final response')
    expect(result.removed).toBe(2)
  })

  it('keeps non-empty tool_results', () => {
    const messages: Message[] = [
      { role: 'user', content: 'read file' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: '1', name: 'Read', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: '1', content: 'file contents here' }],
      },
      { role: 'assistant', content: 'I read the file.' },
    ]

    const result = snipMessages(messages)
    expect(result.messages).toHaveLength(4)
  })

  it('does not remove non-tool message pairs', () => {
    const messages: Message[] = [
      { role: 'user', content: 'question 1' },
      { role: 'assistant', content: 'answer 1' },
      { role: 'user', content: 'question 2' },
      { role: 'assistant', content: '' }, // empty assistant
    ]

    const result = snipMessages(messages)
    // The empty assistant + preceding user pair with no tool use should stay
    // (snip only targets tool_use/tool_result patterns)
    expect(result.messages).toHaveLength(4)
  })

  it('returns unchanged array when nothing to snip', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]

    const result = snipMessages(messages)
    expect(result.messages).toHaveLength(2)
    expect(result.removed).toBe(0)
  })

  it('handles empty message array', () => {
    const result = snipMessages([])
    expect(result.messages).toHaveLength(0)
    expect(result.removed).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/cli && bun test test/core/context-snip.test.ts
```

- [ ] **Step 3: Implement snipMessages**

```typescript
// apps/cli/src/core/context-snip.ts
import type { Message } from '../shared/index.ts'

interface SnipResult {
  messages: Message[]
  removed: number
}

/**
 * Layer 1: Zero-cost pruning.
 *
 * Removes tool_use + empty tool_result message pairs that carry no
 * information value. This is a pure data transformation — no API calls.
 *
 * A pair is eligible for removal when:
 * - The assistant message contains only a tool_use block
 * - The immediately following user message contains only a tool_result
 *   with empty or whitespace-only content
 */
export function snipMessages(messages: Message[]): SnipResult {
  if (messages.length < 2) return { messages: [...messages], removed: 0 }

  const result: Message[] = []
  let removed = 0
  let i = 0

  while (i < messages.length) {
    // Look for a tool_use assistant message followed by empty tool_result
    if (
      i + 1 < messages.length &&
      messages[i]!.role === 'assistant' &&
      isOnlyToolUse(messages[i]!) &&
      messages[i + 1]!.role === 'user' &&
      isEmptyToolResult(messages[i + 1]!)
    ) {
      removed += 2
      i += 2
      continue
    }

    result.push(messages[i]!)
    i++
  }

  return { messages: result, removed }
}

function isOnlyToolUse(msg: Message): boolean {
  if (!Array.isArray(msg.content)) return false
  const nonToolUse = msg.content.filter(
    (block: unknown) =>
      !(
        block &&
        typeof block === 'object' &&
        (block as Record<string, unknown>).type === 'tool_use'
      ),
  )
  // Must have at least one tool_use and nothing else substantial
  const hasToolUse = msg.content.some(
    (block: unknown) =>
      block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_use',
  )
  return hasToolUse && nonToolUse.length === 0
}

function isEmptyToolResult(msg: Message): boolean {
  if (!Array.isArray(msg.content)) return false
  return msg.content.every((block: unknown) => {
    if (!block || typeof block !== 'object') return false
    const b = block as Record<string, unknown>
    if (b.type !== 'tool_result') return true // non-tool_result blocks don't count
    const content = String(b.content || '')
    return content.trim().length === 0
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/cli && bun test test/core/context-snip.test.ts
```

Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/context-snip.ts apps/cli/test/core/context-snip.test.ts
git commit -m "feat(context): add Layer 1 Snip — zero-cost message pruning"
```

---

### Task 2.3: Layer 2 — Microcompact (Cache-Aware)

**Files:**

- Create: `apps/cli/src/core/context-microcompact.ts`
- Create: `apps/cli/test/core/context-microcompact.test.ts`

**Interfaces:**

- Consumes: `CacheTracker`, `estimateMessageTokens` from context-token.ts
- Produces: `microcompact(messages, cacheTracker)` → `{ messages, tokensSaved }`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/cli/test/core/context-microcompact.test.ts
import { describe, it, expect } from 'vitest'
import { microcompact, shouldMicrocompact } from '../../src/core/context-microcompact'
import { NoopCacheTracker } from '../../src/core/context-token'
import type { Message } from '../../src/shared/index.ts'

function makeMessages(count: number): Message[] {
  const msgs: Message[] = []
  for (let i = 0; i < count; i++) {
    msgs.push({ role: 'user', content: `query ${i}` })
    msgs.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: `${i}`, name: 'Read', input: {} }],
    })
    msgs.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `${i}`, content: 'x'.repeat(500) }],
    })
  }
  return msgs
}

describe('microcompact', () => {
  it('replaces old tool_result content with placeholder', () => {
    const messages = makeMessages(10)
    const cache = new NoopCacheTracker()
    const result = microcompact(messages, cache, { keepRecent: 3 })

    // First 7 pairs (21 msgs) should be compressed, last 3 pairs (9 msgs) kept
    // Each pair: user query + assistant tool_use + user tool_result
    expect(result.messages.length).toBe(messages.length) // structure preserved

    // Check first tool_result is compressed
    const firstToolResult = result.messages[2]!
    expect(firstToolResult.role).toBe('user')
    const content = firstToolResult.content
    if (Array.isArray(content)) {
      const block = content[0] as { type: string; content: string }
      expect(block.content).toBe('[earlier result omitted]')
    }
  })

  it('keeps recent messages intact', () => {
    const messages = makeMessages(10)
    const cache = new NoopCacheTracker()
    const result = microcompact(messages, cache, { keepRecent: 5 })

    // Last 5 pairs (15 messages) should be intact
    const lastToolResult = result.messages[result.messages.length - 1]!
    const content = lastToolResult.content
    if (Array.isArray(content)) {
      const block = content[0] as { type: string; content: string }
      expect(block.content).not.toBe('[earlier result omitted]')
    }
  })

  it('skips messages in prompt cache', () => {
    const messages = makeMessages(5)
    const cache = {
      isInCache: () => true,
      getStatus: () => ({
        totalMessages: 0,
        cachedMessages: 0,
        cachedTokens: 0,
        uncachedTokens: 0,
      }),
      invalidate: () => {},
    }
    const result = microcompact(messages, cache, { keepRecent: 1 })

    // All messages are in cache, so none should be compressed
    for (const msg of result.messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (
            block &&
            typeof block === 'object' &&
            (block as Record<string, unknown>).type === 'tool_result'
          ) {
            const b = block as { content: string }
            expect(b.content).not.toBe('[earlier result omitted]')
          }
        }
      }
    }
  })

  it('shouldMicrocompact returns true only when savings > loss', () => {
    const messages = makeMessages(20)
    const cache = new NoopCacheTracker()
    // With NoopCacheTracker (nothing in cache), savings should be positive
    expect(shouldMicrocompact(messages, cache, 0.7)).toBe(true)
  })
})
```

- [ ] **Step 2: Implement microcompact**

```typescript
// apps/cli/src/core/context-microcompact.ts
import type { Message, ToolResultContent } from '../shared/index.ts'
import type { CacheTracker } from './context-token'
import { estimateMessageTokens, type CacheStatus } from './context-token'

const PLACEHOLDER = '[earlier result omitted]'

interface MicrocompactOptions {
  keepRecent: number // number of recent tool-call pairs to keep intact
}

interface MicrocompactResult {
  messages: Message[]
  tokensSaved: number
}

/**
 * Layer 2: Cache-aware micro-compression.
 *
 * Replaces old tool_result content with a placeholder, preserving message
 * structure. Only compresses messages NOT in the prompt cache to avoid
 * cache invalidation costs.
 */
export function microcompact(
  messages: Message[],
  cacheTracker: CacheTracker,
  options: MicrocompactOptions = { keepRecent: 3 },
): MicrocompactResult {
  const result: Message[] = []
  let tokensSaved = 0

  // Identify tool-call pairs (user query → assistant tool_use → user tool_result)
  // Count from the end to keep the most recent ones intact
  const pairCount = countToolPairs(messages)
  const compressBeforePair = Math.max(0, pairCount - options.keepRecent)

  let pairIndex = 0
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]!

    // Check if this starts a tool-call pair
    if (isToolResultUserMessage(msg) && pairIndex < compressBeforePair) {
      // Don't compress if it's in the prompt cache
      if (!cacheTracker.isInCache(msg)) {
        const compressed = compressToolResult(msg)
        result.push(compressed)
        tokensSaved += estimateMessageTokens(msg) - estimateMessageTokens(compressed)
        i++
        pairIndex++
        continue
      }
    }

    // Count pairs as we go
    if (isToolResultUserMessage(msg)) {
      pairIndex++
    }

    result.push(msg)
    i++
  }

  return { messages: result, tokensSaved }
}

function countToolPairs(messages: Message[]): number {
  let count = 0
  for (const msg of messages) {
    if (isToolResultUserMessage(msg)) count++
  }
  return count
}

function isToolResultUserMessage(msg: Message): boolean {
  if (msg.role !== 'user') return false
  if (!Array.isArray(msg.content)) return false
  return msg.content.some(
    (block: unknown) =>
      block &&
      typeof block === 'object' &&
      (block as Record<string, unknown>).type === 'tool_result',
  )
}

function compressToolResult(msg: Message): Message {
  if (!Array.isArray(msg.content)) return msg

  const compressed = msg.content.map((block: unknown) => {
    if (
      block &&
      typeof block === 'object' &&
      (block as Record<string, unknown>).type === 'tool_result'
    ) {
      return {
        ...(block as object),
        content: PLACEHOLDER,
      } as ToolResultContent
    }
    return block as ToolResultContent
  })

  return { ...msg, content: compressed }
}

/**
 * Decide whether microcompaction is worth it.
 *
 * Only compress when tokens saved > tokens lost from cache invalidation.
 * The multiplier of 1.5 provides a safety margin.
 */
export function shouldMicrocompact(
  messages: Message[],
  cacheTracker: CacheTracker,
  threshold: number,
): boolean {
  let savingsTokens = 0
  let cacheLossTokens = 0

  for (const msg of messages) {
    if (isToolResultUserMessage(msg)) {
      const tokens = estimateMessageTokens(msg)
      if (cacheTracker.isInCache(msg)) {
        cacheLossTokens += tokens
      } else {
        savingsTokens += tokens * 0.5 // we save ~50% by replacing content
      }
    }
  }

  return savingsTokens > cacheLossTokens * 1.5
}
```

- [ ] **Step 3: Run test to verify**

```bash
cd apps/cli && bun test test/core/context-microcompact.test.ts
```

Expected: 4 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/core/context-microcompact.ts apps/cli/test/core/context-microcompact.test.ts
git commit -m "feat(context): add Layer 2 Microcompact — cache-aware compression"
```

---

### Task 2.4: Layer 3 — Reactive Compact (API Summarization)

**Files:**

- Create: `apps/cli/src/core/context-compact.ts`
- Create: `apps/cli/test/core/context-compact.test.ts`

**Interfaces:**

- Consumes: `ContextManager`, `ProviderRegistry` (for API-based summarization)
- Produces: `reactiveCompact(context, summarizer)` → `Promise<void>`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/cli/test/core/context-compact.test.ts
import { describe, it, expect } from 'vitest'
import { reactiveCompact } from '../../src/core/context-compact'
import { ContextManager } from '../../src/core/context'
import type { Message } from '../../src/shared/index.ts'

describe('reactiveCompact', () => {
  it('compacts messages above threshold using summarizer', async () => {
    const context = new ContextManager({
      maxTokens: 10000,
      compactionThreshold: 0.85,
    })
    context.setSystemPrompt('You are a helpful assistant.')

    // Add messages that exceed the threshold
    for (let i = 0; i < 50; i++) {
      context.addMessage({ role: 'user', content: `Message ${i}: ` + 'x'.repeat(200) })
      context.addMessage({ role: 'assistant', content: `Response ${i}: ` + 'y'.repeat(200) })
    }

    const initialCount = context.getMessageCount()

    const summarizer = async (msgs: Message[], heading: string): Promise<string> => {
      return `Summary of ${msgs.length} messages about: ${heading}`
    }

    await reactiveCompact(context, summarizer, 'test compaction')

    const finalCount = context.getMessageCount()
    expect(finalCount).toBeLessThan(initialCount)
    // Should have at least the summary message + kept recent messages
    expect(finalCount).toBeGreaterThan(0)
  })

  it('skips compaction when below threshold', async () => {
    const context = new ContextManager({
      maxTokens: 100000,
      compactionThreshold: 0.85,
    })
    context.setSystemPrompt('You are a helpful assistant.')

    // Add few messages
    for (let i = 0; i < 5; i++) {
      context.addMessage({ role: 'user', content: `Hello ${i}` })
      context.addMessage({ role: 'assistant', content: `Hi ${i}` })
    }

    const initialCount = context.getMessageCount()

    let called = false
    const summarizer = async (_msgs: Message[], _heading: string): Promise<string> => {
      called = true
      return 'should not be called'
    }

    await reactiveCompact(context, summarizer, 'test')
    expect(called).toBe(false)
    expect(context.getMessageCount()).toBe(initialCount)
  })

  it('preserves system prompt after compaction', async () => {
    const context = new ContextManager({
      maxTokens: 10000,
      compactionThreshold: 0.85,
    })
    const sysPrompt = 'You are a specialized coding assistant.'
    context.setSystemPrompt(sysPrompt)

    for (let i = 0; i < 50; i++) {
      context.addMessage({ role: 'user', content: `Message ${i}: ` + 'x'.repeat(200) })
      context.addMessage({ role: 'assistant', content: `Response ${i}: ` + 'y'.repeat(200) })
    }

    const summarizer = async (msgs: Message[], heading: string): Promise<string> => {
      return `Summary: ${msgs.length} messages, ${heading}`
    }

    await reactiveCompact(context, summarizer, 'test')
    expect(context.getSystemPrompt()).toBe(sysPrompt)
  })
})
```

- [ ] **Step 2: Implement reactiveCompact**

```typescript
// apps/cli/src/core/context-compact.ts
import type { ContextManager, Summarizer } from './context'
import { snipMessages } from './context-snip'

/**
 * Layer 3: Reactive Compact — API-based summarization.
 *
 * When the context exceeds the compaction threshold, uses an LLM summarizer
 * to condense the conversation history, keeping recent messages intact.
 *
 * After compaction, the context contains:
 * 1. A summary message of the truncated history
 * 2. The most recent N messages (kept intact)
 * 3. The system prompt (unchanged)
 */
export async function reactiveCompact(
  context: ContextManager,
  summarizer: Summarizer,
  heading: string,
  keepRecent: number = 20,
): Promise<void> {
  const messages = context.getMessages()

  if (messages.length <= keepRecent + 4) return

  // First, run snip to remove empty pairs
  const { messages: snipped } = snipMessages(messages)

  if (snipped.length <= keepRecent + 4) return

  // Split: old messages to summarize, recent messages to keep
  const toSummarize = snipped.slice(0, -keepRecent)
  const toKeep = snipped.slice(-keepRecent)

  // Generate summary
  let summary: string
  try {
    summary = await summarizer(toSummarize, heading)
  } catch {
    // On summarizer failure, do a simple truncation
    summary = `Earlier conversation (${toSummarize.length} messages) omitted due to context limits.`
  }

  // Rebuild messages: summary + recent
  const summaryMsg = {
    role: 'user' as const,
    content: `[Earlier conversation summary — ${heading}]: ${summary.slice(0, 2000)}`,
  }

  // Clear and rebuild via individual addMessage calls
  // Cannot clear directly without losing system prompt, so update internal state
  context.replaceMessages([summaryMsg, ...toKeep])
}
```

- [ ] **Step 3: Update ContextManager to support replaceMessages**

Add to `apps/cli/src/core/context.ts`:

```typescript
/**
 * Replace all messages atomically (used by compaction layers).
 * Preserves system prompt. Does NOT trigger compaction checks.
 */
replaceMessages(messages: Message[]): void {
  this.messages = messages
  // Re-estimate tokens
  this.estimatedTokens = this.estimateTokens(this.systemPrompt)
  for (const msg of messages) {
    this.estimatedTokens += this.estimateTokens(
      typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
    )
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd apps/cli && bun test test/core/context-compact.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/context-compact.ts apps/cli/src/core/context.ts apps/cli/test/core/context-compact.test.ts
git commit -m "feat(context): add Layer 3 Reactive Compact — API summarization"
```

---

### Task 2.5: Layer 4 — Emergency Drain (413 Recovery)

**Files:**

- Create: `apps/cli/src/core/context-drain.ts`
- Create: `apps/cli/test/core/context-drain.test.ts`

**Interfaces:**

- Produces: `emergencyDrain(context)` → `Promise<boolean>` (true = recovered)

- [ ] **Step 1: Write test**

```typescript
// apps/cli/test/core/context-drain.test.ts
import { describe, it, expect } from 'vitest'
import { emergencyDrain } from '../../src/core/context-drain'
import { ContextManager } from '../../src/core/context'

describe('emergencyDrain', () => {
  it('drops 50% of messages on first attempt', async () => {
    const context = new ContextManager({
      maxTokens: 100000,
      compactionThreshold: 0.85,
    })
    context.setSystemPrompt('system')

    for (let i = 0; i < 100; i++) {
      context.addMessage({ role: 'user', content: `msg ${i}` })
      context.addMessage({ role: 'assistant', content: `resp ${i}` })
    }

    const initialCount = context.getMessageCount()
    const recovered = await emergencyDrain(context)

    expect(recovered).toBe(true)
    expect(context.getMessageCount()).toBeLessThan(initialCount)
    // Should be roughly half, plus system prompt preserved
    expect(context.getSystemPrompt()).toBe('system')
  })

  it('falls back to minimal context when drain is insufficient', async () => {
    const context = new ContextManager({
      maxTokens: 100000,
      compactionThreshold: 0.85,
    })
    context.setSystemPrompt('system')

    for (let i = 0; i < 200; i++) {
      context.addMessage({ role: 'user', content: `msg ${i}` })
      context.addMessage({ role: 'assistant', content: `resp ${i}` })
    }

    // Second drain should strip to minimal
    await emergencyDrain(context)
    await emergencyDrain(context)

    // Should be at most 5 + summary
    expect(context.getMessageCount()).toBeLessThanOrEqual(6)
    expect(context.getSystemPrompt()).toBe('system')
  })
})
```

- [ ] **Step 2: Implement emergencyDrain**

```typescript
// apps/cli/src/core/context-drain.ts
import type { ContextManager } from './context'

const MINIMAL_KEEP = 5
let drainLevel = 0

/**
 * Layer 4: Emergency Drain — 413 error recovery.
 *
 * Called when a 413 (context too large) error is received.
 * Progressively strips messages until the context fits:
 *
 * Level 1: Drop earliest 50% of messages
 * Level 2+: Keep only system prompt + last 5 messages
 *
 * Returns true if recovery was possible, false if context is already minimal.
 */
export async function emergencyDrain(context: ContextManager): Promise<boolean> {
  const messages = context.getMessages()

  if (messages.length <= MINIMAL_KEEP) {
    return false // Already minimal, cannot drain further
  }

  if (drainLevel === 0) {
    // First attempt: drop earliest 50%
    const keepCount = Math.max(MINIMAL_KEEP, Math.floor(messages.length / 2))
    const kept = messages.slice(-keepCount)
    context.replaceMessages(kept)
    drainLevel++
    return true
  }

  // Subsequent attempts: keep only system + last MINIMAL_KEEP messages
  const kept = messages.slice(-MINIMAL_KEEP)

  // Add a summary placeholder if we're dropping a lot
  if (messages.length > MINIMAL_KEEP * 2) {
    const summaryMsg = {
      role: 'user' as const,
      content: `[Emergency context drain: ${messages.length - MINIMAL_KEEP} earlier messages discarded due to token limit.]`,
    }
    context.replaceMessages([summaryMsg, ...kept])
  } else {
    context.replaceMessages(kept)
  }

  drainLevel++
  return true
}

/** Reset drain level (call at session start). */
export function resetDrainLevel(): void {
  drainLevel = 0
}
```

- [ ] **Step 3: Run tests**

```bash
cd apps/cli && bun test test/core/context-drain.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/core/context-drain.ts apps/cli/test/core/context-drain.test.ts
git commit -m "feat(context): add Layer 4 Emergency Drain — 413 recovery"
```

---

### Task 2.6: Integrate Compression Layers into ContextManager

**Files:**

- Modify: `apps/cli/src/core/context.ts`

- [ ] **Step 1: Modify ContextManager.addMessage() to auto-trigger compression**

Replace the `addMessage` method and add auto-check logic:

```typescript
// In context.ts, modify addMessage:

addMessage(msg: Message): void {
  this.messages.push(msg)
  this.estimatedTokens += this.estimateTokens(
    typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
  )

  // Auto-trigger compression checks (fire-and-forget, don't await)
  this.checkCompression()
}

private compressionPending = false

private checkCompression(): void {
  if (this.compressionPending) return

  const usage = this.estimatedTokens / this.config.maxTokens

  if (usage > 0.70) {
    this.compressionPending = true
    // Schedule microcompact asynchronously
    Promise.resolve().then(() => {
      this.runMicrocompact()
      this.compressionPending = false
    })
  }
}

private runMicrocompact(): void {
  const { messages: snipped } = snipMessages(this.messages)

  // Simple microcompact: compress tool_results not needed for recent context
  const keepRecent = 3
  const { messages: compacted } = microcompact(
    snipped,
    this.cacheTracker || new NoopCacheTracker(),
    { keepRecent },
  )

  this.messages = compacted
  this.reEstimateTokens()
}

private reEstimateTokens(): void {
  this.estimatedTokens = this.estimateTokens(this.systemPrompt)
  for (const msg of this.messages) {
    this.estimatedTokens += this.estimateTokens(
      typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
    )
  }
}

// Add cache tracker support
private cacheTracker: CacheTracker = new NoopCacheTracker()

setCacheTracker(tracker: CacheTracker): void {
  this.cacheTracker = tracker
}

getCacheStatus(): CacheStatus {
  return this.cacheTracker.getStatus()
}

getCompactionStats(): CompactionStats {
  return { ...this.compactionStats }
}

// Add on413Error convenience method
async on413Error(): Promise<boolean> {
  return emergencyDrain(this)
}

// Add forceCompact for /compact command
async forceCompact(heading: string, summarizer?: Summarizer): Promise<void> {
  if (summarizer) {
    await reactiveCompact(this, summarizer, heading)
  } else if (this.summarizer) {
    await reactiveCompact(this, this.summarizer, heading)
  } else {
    // Fallback: simple truncation via drain
    await emergencyDrain(this)
  }
}
```

Add imports at top:

```typescript
import { snipMessages } from './context-snip'
import { microcompact } from './context-microcompact'
import { reactiveCompact } from './context-compact'
import { emergencyDrain } from './context-drain'
import { NoopCacheTracker, type CacheTracker, type CacheStatus } from './context-token'
```

Add to constructor or as field:

```typescript
private compactionStats: CompactionStats = {
  snipCount: 0,
  snipMessagesRemoved: 0,
  microcompactCount: 0,
  microcompactTokensSaved: 0,
  compactCount: 0,
  compactTokensSaved: 0,
  drainCount: 0,
  lastCompaction: null,
}
```

- [ ] **Step 2: Run all existing tests to verify no regressions**

```bash
cd apps/cli && bun test
```

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/core/context.ts
git commit -m "feat(context): integrate multi-layer compression into ContextManager"
```

---

## Phase 3: Hook System Enhancement

### Task 3.1: Extend Hook Types and Events

**Files:**

- Modify: `apps/cli/src/shared/types.ts` (add HookConfig, new events, extended HookResult)
- Modify: `apps/cli/src/core/hooks.ts` (support new events + types)

- [ ] **Step 1: Update shared types**

Add to `apps/cli/src/shared/types.ts`:

```typescript
// Extend HookEvent
export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Notification'
  | 'Stop' // NEW
  | 'UserPromptSubmit' // NEW
  | 'PreCompact' // NEW
  | 'PostCompact' // NEW
  | 'ConfigChange' // NEW

// Add HookConfig
export type HookType = 'command' | 'http' | 'code' | 'mcp_tool'

export interface HookConfig {
  type: HookType
  command?: string
  args?: string[]
  url?: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  mcpServer?: string
  mcpTool?: string
  continueOnBlock?: boolean
}

// Extend HookResult
export interface HookResult {
  allowed: boolean
  reason?: string
  modifiedInput?: Record<string, unknown>
  decision?: 'allow' | 'block' // Stop hook
  permissionDecision?: 'allow' | 'deny' | 'ask' | 'defer' // PreToolUse
  additionalContext?: string // Inject into AI context
  updatedOutput?: string // PostToolUse replace output
}

// Extend HookContext
export interface HookContext {
  event: HookEvent
  toolName?: string
  toolInput?: Record<string, unknown>
  toolResult?: ToolResult
  sessionId: string
  userPrompt?: string // NEW: for UserPromptSubmit
  configKey?: string // NEW: for ConfigChange
  configValue?: unknown // NEW: for ConfigChange
}
```

- [ ] **Step 2: Rewrite hooks.ts**

```typescript
// apps/cli/src/core/hooks.ts
import type {
  HookDefinition,
  HookEvent,
  HookContext,
  HookResult,
  ToolResult,
  HookConfig,
} from '../shared/index.ts'

export class HookEngine {
  private hooks: HookDefinition[] = []

  register(hook: HookDefinition): void {
    this.hooks.push(hook)
  }

  unregister(event: HookEvent, toolName?: string): void {
    this.hooks = this.hooks.filter(
      (h) => !(h.event === event && (!toolName || h.toolName === toolName)),
    )
  }

  // ── Existing event executors ──

  async executePreToolUse(
    toolName: string,
    toolInput: Record<string, unknown>,
    sessionId: string,
  ): Promise<HookResult> {
    const ctx: HookContext = { event: 'PreToolUse', toolName, toolInput, sessionId }
    return this.runHooks('PreToolUse', toolName, ctx)
  }

  async executePostToolUse(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResult: ToolResult,
    sessionId: string,
  ): Promise<HookResult> {
    const ctx: HookContext = { event: 'PostToolUse', toolName, toolInput, toolResult, sessionId }
    return this.runHooks('PostToolUse', toolName, ctx)
  }

  async executeSessionStart(sessionId: string): Promise<HookResult> {
    const ctx: HookContext = { event: 'SessionStart', sessionId }
    return this.runHooks('SessionStart', undefined, ctx)
  }

  async executeSessionEnd(sessionId: string): Promise<HookResult> {
    const ctx: HookContext = { event: 'SessionEnd', sessionId }
    return this.runHooks('SessionEnd', undefined, ctx)
  }

  async executeNotification(message: string, sessionId: string): Promise<HookResult> {
    const ctx: HookContext = { event: 'Notification', sessionId, toolInput: { message } }
    return this.runHooks('Notification', undefined, ctx)
  }

  // ── NEW event executors ──

  /** Stop hook: fires when AI completes a turn. Can block to force continuation. */
  async executeStop(sessionId: string): Promise<HookResult> {
    const ctx: HookContext = { event: 'Stop', sessionId }
    return this.runHooks('Stop', undefined, ctx)
  }

  /** UserPromptSubmit: fires when user submits input. Can block malicious input. */
  async executeUserPromptSubmit(prompt: string, sessionId: string): Promise<HookResult> {
    const ctx: HookContext = { event: 'UserPromptSubmit', sessionId, userPrompt: prompt }
    return this.runHooks('UserPromptSubmit', undefined, ctx)
  }

  /** PreCompact: fires before context compaction. */
  async executePreCompact(sessionId: string): Promise<HookResult> {
    const ctx: HookContext = { event: 'PreCompact', sessionId }
    return this.runHooks('PreCompact', undefined, ctx)
  }

  /** PostCompact: fires after context compaction. Can inject additional context. */
  async executePostCompact(sessionId: string): Promise<HookResult> {
    const ctx: HookContext = { event: 'PostCompact', sessionId }
    return this.runHooks('PostCompact', undefined, ctx)
  }

  /** ConfigChange: fires when configuration changes. */
  async executeConfigChange(key: string, value: unknown, sessionId: string): Promise<HookResult> {
    const ctx: HookContext = {
      event: 'ConfigChange',
      sessionId,
      configKey: key,
      configValue: value,
    }
    return this.runHooks('ConfigChange', undefined, ctx)
  }

  // ── Core execution ──

  private async runHooks(
    event: HookEvent,
    toolName: string | undefined,
    ctx: HookContext,
  ): Promise<HookResult> {
    const matching = this.hooks.filter(
      (h) => h.event === event && (!toolName || !h.toolName || h.toolName === toolName),
    )

    const result: HookResult = { allowed: true }

    for (const hook of matching) {
      try {
        const hookResult = await hook.handler(ctx)

        // Merge permission decisions (deny > defer > ask > allow)
        if (hookResult.permissionDecision) {
          result.permissionDecision = mergePermissionDecision(
            result.permissionDecision,
            hookResult.permissionDecision,
          )
        }

        // Stop hook: block decision takes precedence
        if (hookResult.decision === 'block') {
          result.decision = 'block'
          result.reason = hookResult.reason || result.reason
        }

        // Block on first deny for PreToolUse
        if (!hookResult.allowed) {
          result.allowed = false
          result.reason = hookResult.reason || result.reason
        }

        // Merge modified inputs
        if (hookResult.modifiedInput) {
          result.modifiedInput = {
            ...(result.modifiedInput || {}),
            ...hookResult.modifiedInput,
          }
        }

        // Collect additional context from multiple hooks
        if (hookResult.additionalContext) {
          result.additionalContext = result.additionalContext
            ? result.additionalContext + '\n' + hookResult.additionalContext
            : hookResult.additionalContext
        }

        // PostToolUse: replace output if provided
        if (hookResult.updatedOutput) {
          result.updatedOutput = hookResult.updatedOutput
        }
      } catch {
        // Hook failures do not block execution
      }
    }

    return result
  }

  listHooks(): HookDefinition[] {
    return [...this.hooks]
  }
}

function mergePermissionDecision(
  current: HookResult['permissionDecision'],
  incoming: NonNullable<HookResult['permissionDecision']>,
): HookResult['permissionDecision'] {
  const priority: Record<string, number> = { deny: 3, defer: 2, ask: 1, allow: 0 }
  const currScore = current ? (priority[current] ?? 0) : -1
  const incScore = priority[incoming] ?? 0
  return incScore > currScore ? incoming : current
}
```

- [ ] **Step 3: Verify compilation and run existing tests**

```bash
cd apps/cli && pnpm typecheck && bun test
```

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/shared/types.ts apps/cli/src/core/hooks.ts
git commit -m "feat(hooks): add 5 new events, extended HookResult, multi-type support"
```

---

### Task 3.2: Hook Configuration Loader

**Files:**

- Create: `apps/cli/src/core/hooks-config.ts`
- Create: `apps/cli/test/core/hooks-config.test.ts`

- [ ] **Step 1: Write test + implementation (compact)**

```typescript
// apps/cli/src/core/hooks-config.ts
import type {
  HookConfig,
  HookEvent,
  HookDefinition,
  HookContext,
  HookResult,
} from '../shared/index.ts'

interface HookConfigEntry {
  matcher: string
  hooks: HookConfig[]
}

interface SettingsHooks {
  PreToolUse?: HookConfigEntry[]
  PostToolUse?: HookConfigEntry[]
  Stop?: HookConfigEntry[]
  UserPromptSubmit?: HookConfigEntry[]
  PreCompact?: HookConfigEntry[]
  PostCompact?: HookConfigEntry[]
  SessionStart?: HookConfigEntry[]
  SessionEnd?: HookConfigEntry[]
  Notification?: HookConfigEntry[]
  ConfigChange?: HookConfigEntry[]
}

/**
 * Load hook configurations from a settings object and convert them to
 * executable HookDefinitions suitable for the HookEngine.
 */
export function loadHookConfigs(configs: SettingsHooks): HookDefinition[] {
  const definitions: HookDefinition[] = []

  for (const [eventName, entries] of Object.entries(configs)) {
    if (!entries || !Array.isArray(entries)) continue

    for (const entry of entries) {
      const matcherRegex = entry.matcher ? new RegExp(entry.matcher) : null

      for (const hookCfg of entry.hooks) {
        const handler = createHookHandler(hookCfg)

        definitions.push({
          event: eventName as HookEvent,
          toolName: entry.matcher || undefined,
          handler: async (ctx: HookContext) => {
            // Check matcher if tool-specific
            if (matcherRegex && ctx.toolName && !matcherRegex.test(ctx.toolName)) {
              return { allowed: true }
            }
            return handler(ctx, hookCfg)
          },
        })
      }
    }
  }

  return definitions
}

function createHookHandler(
  cfg: HookConfig,
): (ctx: HookContext, config: HookConfig) => Promise<HookResult> {
  switch (cfg.type) {
    case 'code':
      return async (_ctx, _cfg) => ({ allowed: true })
    case 'command':
      return executeCommandHook
    case 'http':
      return executeHttpHook
    case 'mcp_tool':
      return executeMcpToolHook
    default:
      return async () => ({ allowed: true })
  }
}

async function executeCommandHook(ctx: HookContext, cfg: HookConfig): Promise<HookResult> {
  // Stub: actual execution delegated to hooks-executor.ts
  // Returns allow by default, hooks-executor overrides with actual logic
  return { allowed: true }
}

async function executeHttpHook(ctx: HookContext, cfg: HookConfig): Promise<HookResult> {
  return { allowed: true }
}

async function executeMcpToolHook(ctx: HookContext, cfg: HookConfig): Promise<HookResult> {
  return { allowed: true }
}
```

- [ ] **Step 2: Write tests**

```typescript
// apps/cli/test/core/hooks-config.test.ts
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
```

- [ ] **Step 3: Run tests and commit**

```bash
cd apps/cli && bun test test/core/hooks-config.test.ts
git add apps/cli/src/core/hooks-config.ts apps/cli/test/core/hooks-config.test.ts
git commit -m "feat(hooks): add JSON settings hook configuration loader"
```

---

### Task 3.3: Hook Executor (Command/HTTP/MCP Dispatch)

**Files:**

- Create: `apps/cli/src/core/hooks-executor.ts`

- [ ] **Step 1: Implement the executor**

```typescript
// apps/cli/src/core/hooks-executor.ts
import { execSync } from 'node:child_process'
import type { HookConfig, HookContext, HookResult } from '../shared/index.ts'

/**
 * Execute a hook based on its type, returning a HookResult.
 *
 * Supported types:
 * - command: Execute a shell command. Exit code 0 = allow, 2 = block with stderr as reason.
 * - http: POST to a URL, response body becomes additionalContext.
 * - mcp_tool: Call an MCP tool (delegates to MCP client — stub for now).
 * - code: No-op (handled inline by the handler function directly).
 */
export async function executeHook(cfg: HookConfig, ctx: HookContext): Promise<HookResult> {
  switch (cfg.type) {
    case 'command':
      return executeCommand(cfg, ctx)
    case 'http':
      return executeHttp(cfg, ctx)
    case 'mcp_tool':
      return executeMcpTool(cfg, ctx)
    default:
      return { allowed: true }
  }
}

function substituteVars(template: string, ctx: HookContext): string {
  return template
    .replace(/\$TOOL_NAME/g, ctx.toolName || '')
    .replace(/\$INPUT/g, ctx.toolInput ? JSON.stringify(ctx.toolInput) : '')
    .replace(/\$SESSION_ID/g, ctx.sessionId)
}

function executeCommand(cfg: HookConfig, ctx: HookContext): HookResult {
  if (!cfg.command) return { allowed: true }

  try {
    const args = cfg.args ? cfg.args.map((a) => substituteVars(a, ctx)) : []

    const cmd = [cfg.command, ...args].join(' ')

    execSync(cmd, {
      timeout: 30_000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    // Exit code 0 = success, allow
    return { allowed: true }
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr || String(err)

    // Exit code 2 = block with reason
    if ((err as { status?: number }).status === 2) {
      return {
        allowed: false,
        reason: stderr.trim() || 'Blocked by hook',
        additionalContext: cfg.continueOnBlock ? stderr.trim() : undefined,
      }
    }

    // Other non-zero exit: don't block, log the error as context
    return {
      allowed: true,
      additionalContext: `Hook warning (${cfg.command}): ${stderr.trim()}`,
    }
  }
}

async function executeHttp(cfg: HookConfig, ctx: HookContext): Promise<HookResult> {
  if (!cfg.url) return { allowed: true }

  try {
    const response = await fetch(cfg.url, {
      method: cfg.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.headers || {}),
      },
      body: JSON.stringify({
        event: ctx.event,
        toolName: ctx.toolName,
        sessionId: ctx.sessionId,
      }),
      signal: AbortSignal.timeout(10_000),
    })

    const body = await response.text()

    if (!response.ok) {
      return {
        allowed: false,
        reason: `HTTP hook returned ${response.status}: ${body.slice(0, 200)}`,
      }
    }

    return {
      allowed: true,
      additionalContext: body.slice(0, 2000) || undefined,
    }
  } catch (err) {
    // HTTP hook failures should not block
    return {
      allowed: true,
      additionalContext: `HTTP hook error (${cfg.url}): ${String(err)}`,
    }
  }
}

async function executeMcpTool(cfg: HookConfig, ctx: HookContext): Promise<HookResult> {
  // Stub: MCP tool hook execution requires MCP client integration.
  // For now, return allow to not block execution.
  return { allowed: true }
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd apps/cli && pnpm typecheck
```

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/core/hooks-executor.ts
git commit -m "feat(hooks): add multi-type hook executor (command/http/mcp_tool)"
```

---

## Phase 4: Skills Auto-Trigger + context:fork

### Task 4.1: Extend SkillsLoader with Description Index

**Files:**

- Modify: `apps/cli/src/skills/loader.ts`

- [ ] **Step 1: Add auto-trigger support to loader**

```typescript
// Add new methods to SkillsLoader in apps/cli/src/skills/loader.ts:

/**
 * Build the system-reminder block for AI auto-triggering.
 * Injects available skill names + descriptions so the AI can match
 * user requests to relevant skills.
 */
buildSystemReminder(maxTokens: number = 5000): string {
  const skills = this.list().filter(s => {
    // Skip skills that disable model invocation
    // Check frontmatter for disable-model-invocation (requires re-reading, or cache it)
    return true // simplified — actual impl reads frontmatter
  })

  if (skills.length === 0) return ''

  const lines: string[] = [
    '<system-reminder>',
    'The following skills are available. Invoke via the Skill tool when relevant:',
  ]

  let tokenBudget = 0
  for (const skill of skills) {
    const entry = `- ${skill.name}: ${skill.description}`
    const entryTokens = entry.length / 4 + 1 // rough estimate
    if (tokenBudget + entryTokens > maxTokens) break

    lines.push(entry)
    tokenBudget += entryTokens
  }

  lines.push('</system-reminder>')
  return lines.join('\n')
}

/** Load skills from ~/.mipham/skills/ */
loadUserSkills(): void {
  const home = process.env.HOME || '~'
  const userSkillsPath = join(home, '.mipham', 'skills')
  this.loadExternal([userSkillsPath])
}
```

- [ ] **Step 2: Wire into InstructionsLoader**

In `apps/cli/src/core/instructions.ts`, add a method to inject the system reminder:

```typescript
// Add to buildSystemPrompt or as a separate injectable segment:
setSkillsReminder(reminder: string): void {
  this.skillsReminder = reminder
}

// In buildSystemPrompt(), append the reminder after all instructions:
buildSystemPrompt(): string {
  const parts: string[] = [/* existing logic */]

  if (this.skillsReminder) {
    parts.push(this.skillsReminder)
  }

  return parts.join('\n\n---\n\n')
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/skills/loader.ts apps/cli/src/core/instructions.ts
git commit -m "feat(skills): add system-reminder builder and user skills path"
```

---

### Task 4.2: Fork Executor for context:fork Skills

**Files:**

- Create: `apps/cli/src/skills/fork-executor.ts`
- Create: `apps/cli/test/skills/fork-executor.test.ts`

- [ ] **Step 1: Implement fork executor**

```typescript
// apps/cli/src/skills/fork-executor.ts
import { SubAgent } from '../agent/sub-agent'
import type { ProviderRegistry } from '../providers/registry'
import type { ToolDefinition, SkillDefinition } from '../shared/index.ts'
import type { AgentDefinition } from '../agent/types'

/**
 * Execute a skill in an isolated subagent context (context: fork).
 *
 * The skill's markdown body becomes the subagent's system prompt.
 * The skill's allowed-tools become the subagent's tool whitelist.
 * Results are returned to the AI as internal context (not shown directly to user).
 */
export async function executeForkedSkill(
  skill: SkillDefinition,
  args: string,
  registry: ProviderRegistry,
  toolRegistry: Map<string, ToolDefinition>,
): Promise<string> {
  const agentDef: AgentDefinition = {
    name: `skill:${skill.name}`,
    description: skill.description,
    systemPrompt: buildSkillSystemPrompt(skill),
    tools: (skill as SkillDefinition & { allowedTools?: string[] }).allowedTools?.join(', '),
    model: (skill as SkillDefinition & { model?: string }).model || 'inherit',
    permissionMode: 'inherit',
    background: false,
    source: 'builtin',
  }

  const sub = new SubAgent(registry, toolRegistry)
  const prompt = args
    ? `Execute the "${skill.name}" skill with arguments: ${args}`
    : `Execute the "${skill.name}" skill.`

  return sub.execute(prompt, `skill:${skill.name}`, { agentDef })
}

function buildSkillSystemPrompt(skill: SkillDefinition): string {
  return `You are executing the "${skill.name}" skill (v${skill.version}).\n\n${skill.description}\n\nFollow the skill instructions precisely and return results.`
}
```

- [ ] **Step 2: Write test**

```typescript
// apps/cli/test/skills/fork-executor.test.ts
import { describe, it, expect, vi } from 'vitest'
import { executeForkedSkill } from '../../src/skills/fork-executor'
import type { SkillDefinition } from '../../src/shared/index.ts'
import type { ProviderRegistry, ProviderInstance } from '../../src/providers/registry'
import type { ToolDefinition } from '../../src/shared/index.ts'

function createMockRegistry(): ProviderRegistry {
  const provider: ProviderInstance = {
    config: { id: 'mock', name: 'Mock', protocol: 'openai-compatible', apiKey: '', models: [] },
    async *chat(_req) {
      yield { type: 'text', content: 'Skill executed successfully.' }
      yield { type: 'stop' }
    },
    async listModels() {
      return []
    },
    async healthCheck() {
      return true
    },
  }
  return {
    getActive: () => provider,
    getActiveModel: () => 'mock-model',
  } as unknown as ProviderRegistry
}

describe('executeForkedSkill', () => {
  it('executes a skill in isolated subagent context', async () => {
    const skill: SkillDefinition = {
      name: 'test-skill',
      description: 'A test skill',
      version: '1.0.0',
      type: 'standard',
    }
    const registry = createMockRegistry()
    const tools = new Map<string, ToolDefinition>()

    const result = await executeForkedSkill(skill, 'some args', registry, tools)
    expect(result).toContain('Skill executed successfully.')
  })

  it('passes skill name in subagent prompt', async () => {
    let capturedPrompt = ''
    const provider: ProviderInstance = {
      config: { id: 'mock', name: 'Mock', protocol: 'openai-compatible', apiKey: '', models: [] },
      async *chat(req) {
        capturedPrompt = (req.messages[0]?.content as string) || ''
        yield { type: 'text', content: 'ok' }
        yield { type: 'stop' }
      },
      async listModels() {
        return []
      },
      async healthCheck() {
        return true
      },
    }
    const registry = {
      getActive: () => provider,
      getActiveModel: () => 'mock-model',
    } as unknown as ProviderRegistry

    const skill: SkillDefinition = {
      name: 'my-skill',
      description: 'My custom skill',
      version: '1.0.0',
      type: 'standard',
    }

    await executeForkedSkill(skill, 'file.ts', registry, new Map())
    expect(capturedPrompt).toContain('my-skill')
    expect(capturedPrompt).toContain('file.ts')
  })
})
```

- [ ] **Step 3: Run tests and commit**

```bash
cd apps/cli && bun test test/skills/fork-executor.test.ts
git add apps/cli/src/skills/fork-executor.ts apps/cli/test/skills/fork-executor.test.ts
git commit -m "feat(skills): add context:fork executor using SubAgent isolation"
```

---

### Task 4.3: Update Skill Tool for Fork Routing

**Files:**

- Modify: `apps/cli/src/tools/agent/skill.ts`

- [ ] **Step 1: Add fork routing logic**

```typescript
// In skill.ts execute(), after skill is found:

// Check if skill has context: fork frontmatter
const skillWithFork = skill as SkillDefinition & {
  context?: string
  model?: string
  allowedTools?: string[]
}

if (skillWithFork.context === 'fork') {
  const registry = ctx.registry
  if (!registry) {
    return {
      success: false,
      content: '',
      error: 'Provider registry not available for forked skill execution.',
    }
  }

  try {
    const result = await executeForkedSkill(
      skill,
      args,
      registry,
      (ctx as unknown as { _toolRegistry?: Map<string, ToolDefinition> })._toolRegistry ||
        new Map(),
    )
    // Return to AI as internal context
    return { success: true, content: `[Forked skill "${skillName}" result]:\n${result}` }
  } catch (err) {
    return {
      success: false,
      content: '',
      error: `Forked skill execution failed: ${String(err)}`,
    }
  }
}

// Existing inline execution continues below...
```

- [ ] **Step 2: Parse context field in loader**

Update `SkillsLoader.tryLoad()` in `apps/cli/src/skills/loader.ts` to extract the `context` field from frontmatter:

```typescript
const skill: SkillDefinition = {
  name: (data.name as string) || this.nameFromPath(path),
  description: (data.description as string) || '',
  version: (data.version as string) || '0.1.0',
  type,
  tools: data.tools as SkillDefinition['tools'],
  hooks: data.hooks as SkillDefinition['hooks'],
  prompts: data.prompts as SkillDefinition['prompts'],
  // NEW: store extra frontmatter fields
  context: data.context as string | undefined,
  model: data.model as string | undefined,
  allowedTools: data['allowed-tools'] as string[] | undefined,
  disableModelInvocation: data['disable-model-invocation'] as boolean | undefined,
  userInvocable: data['user-invocable'] as boolean | undefined,
}
```

Update `SkillDefinition` in shared/types.ts:

```typescript
export interface SkillDefinition {
  name: string
  description: string
  version: string
  type: 'standard' | 'mipham'
  tools?: ToolDefinition[]
  hooks?: HookDefinition[]
  prompts?: Record<string, string>
  // NEW: fork-related fields
  context?: string // 'fork' | undefined (inline)
  model?: string // model override
  allowedTools?: string[] // tool whitelist for fork mode
  disableModelInvocation?: boolean
  userInvocable?: boolean
}
```

- [ ] **Step 3: Run tests and commit**

```bash
cd apps/cli && bun test
git add apps/cli/src/tools/agent/skill.ts apps/cli/src/skills/loader.ts apps/cli/src/shared/types.ts
git commit -m "feat(skills): add fork routing in Skill tool with frontmatter parsing"
```

---

### Task 4.4: End-to-End Integration in Engine

**Files:**

- Modify: `apps/cli/src/core/engine.ts` (wire Stop hook, UserPromptSubmit, PreCompact/PostCompact)

- [ ] **Step 1: Wire new hooks into engine lifecycle**

```typescript
// In engine.ts process() method:

// Before processing: fire UserPromptSubmit hooks
if (this.hookEngine) {
  const submitResult = await this.hookEngine.executeUserPromptSubmit(userInput, 'session-1')
  if (submitResult.additionalContext) {
    this.context.addMessage({ role: 'user', content: `[Hook context]: ${submitResult.additionalContext}` })
  }
}

// After AI finishes responding: fire Stop hooks
// At the end of process() or continueWithTools(), when the AI would normally stop:
if (this.hookEngine && toolUses.length === 0 && assistantContent) {
  const stopResult = await this.hookEngine.executeStop('session-1')
  if (stopResult.decision === 'block') {
    // Feed the block reason back to the AI and continue
    this.context.addMessage({
      role: 'user',
      content: `[The Stop hook blocked completion]: ${stopResult.reason || 'Continue working.'}`,
    })
    yield* this.continueWithTools(signal)
  }
}

// Around compaction: fire PreCompact/PostCompact
async compact(heading: string): Promise<void> {
  if (this.hookEngine) {
    const preResult = await this.hookEngine.executePreCompact('session-1')
    if (preResult.additionalContext) {
      this.context.addMessage({ role: 'user', content: `[Pre-compact context]: ${preResult.additionalContext}` })
    }
  }

  await this.context.forceCompact(heading, this.context.getSummarizer())

  if (this.hookEngine) {
    const postResult = await this.hookEngine.executePostCompact('session-1')
    if (postResult.additionalContext) {
      this.context.addMessage({ role: 'user', content: `[Post-compact context]: ${postResult.additionalContext}` })
    }
  }
}
```

- [ ] **Step 2: Run full test suite**

```bash
cd apps/cli && bun test
```

Expected: All tests pass, no regressions.

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/core/engine.ts
git commit -m "feat(engine): wire Stop/UserPromptSubmit/Compact hooks into engine lifecycle"
```

---

### Task 4.5: Final Integration Verification

- [ ] **Step 1: Run full test suite**

```bash
cd apps/cli && pnpm test
```

- [ ] **Step 2: Run type check**

```bash
cd apps/cli && pnpm typecheck
```

- [ ] **Step 3: Verify all new test files pass individually**

```bash
cd apps/cli && bun test test/agent/sub-agent.test.ts
cd apps/cli && bun test test/agent/agent-registry.test.ts
cd apps/cli && bun test test/skills/fork-executor.test.ts
cd apps/cli && bun test test/core/context-snip.test.ts
cd apps/cli && bun test test/core/context-microcompact.test.ts
cd apps/cli && bun test test/core/context-compact.test.ts
cd apps/cli && bun test test/core/context-drain.test.ts
cd apps/cli && bun test test/core/hooks-config.test.ts
```

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: Tier 1 core capabilities — Subagent AI, Skills auto-trigger, Hook enhancement, Context compaction"
```

---

## Dependency Order

```
Phase 1: Subagent (Tasks 1.1 → 1.2 → 1.3 → 1.4 → 1.5 → 1.6)
  ↓
Phase 2: Context  (Tasks 2.1 → 2.2 → 2.3 → 2.4 → 2.5 → 2.6)
  ↓ (can run in parallel with Phase 3)
Phase 3: Hook     (Tasks 3.1 → 3.2 → 3.3)
  ↓
Phase 4: Skills   (Tasks 4.1 → 4.2 → 4.3 → 4.4)
  ↓
Task 4.5: Final Integration Verification
```

Context and Hook can be developed in parallel since Context's compaction layers don't depend on Hook — they fire events that hooks may or may not handle.

---

## Estimated Test Counts

| Test File                    | Tests   |
| ---------------------------- | ------- |
| agent-registry.test.ts       | 8       |
| sub-agent.test.ts            | 6       |
| context-snip.test.ts         | 5       |
| context-microcompact.test.ts | 4       |
| context-compact.test.ts      | 3       |
| context-drain.test.ts        | 2       |
| hooks-config.test.ts         | 4       |
| fork-executor.test.ts        | 2       |
| **Total new tests**          | **34**  |
| **Existing tests**           | **295** |
| **Expected total**           | **329** |
