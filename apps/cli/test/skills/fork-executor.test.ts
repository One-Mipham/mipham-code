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
