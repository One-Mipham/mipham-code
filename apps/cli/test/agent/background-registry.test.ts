import { describe, it, expect } from 'vitest'
import { BackgroundAgentRegistry } from '../../src/agent/background-registry'

describe('BackgroundAgentRegistry', () => {
  it('updateTokenUsage updates a running task token count', () => {
    const reg = new BackgroundAgentRegistry()
    const id = reg.spawn('test task', 'general', async () => 'done')
    expect(reg.get(id)!.tokensUsed).toBe(0)
    reg.updateTokenUsage(id, 1234)
    expect(reg.get(id)!.tokensUsed).toBe(1234)
  })

  it('updateTokenUsage is a no-op for an unknown id', () => {
    const reg = new BackgroundAgentRegistry()
    expect(() => reg.updateTokenUsage('unknown', 1)).not.toThrow()
  })
})
