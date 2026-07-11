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
    writeAgent(TEST_DIR, 'test-agent', `---
name: test-agent
description: A test agent for unit tests.
tools: Read, Grep
model: haiku
---

You are a test agent. Do test things.`)

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
    writeAgent(TEST_DIR, 'agent-a', `---
name: agent-a
description: First agent.
---
Body A`)

    writeAgent(TEST_DIR, 'agent-b', `---
name: agent-b
description: Second agent.
---
Body B`)

    const registry = new AgentRegistry()
    registry.loadDirectory(TEST_DIR, 'project')

    const list = registry.list()
    expect(list).toHaveLength(2)
    expect(list.map(a => a.name).sort()).toEqual(['agent-a', 'agent-b'])
  })

  it('applies defaults for missing frontmatter fields', () => {
    writeAgent(TEST_DIR, 'minimal', `---
name: minimal
description: Minimal agent.
---
Minimal body.`)

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

    writeAgent(projectDir, 'same-name', `---
name: same-name
description: Project version.
---
Project body.`)

    writeAgent(userDir, 'same-name', `---
name: same-name
description: User version.
---
User body.`)

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
    writeAgent(TEST_DIR, 'agent', `---
name: agent
description: Test.
---
Body`)
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
