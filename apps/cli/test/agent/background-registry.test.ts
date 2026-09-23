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

  /**
   * The id is minted here and it is the address peers send to (`SendMessage` →
   * `MessageRouter` → `bg-…`). An executor that is never told it cannot be
   * reachable, and no other part of the process knows it either — so this is the
   * only place the address can cross the boundary.
   */
  it('hands the executor its own id, so a peer can address it', async () => {
    const reg = new BackgroundAgentRegistry()
    let handedToExecutor: string | undefined

    const id = reg.spawn('test task', 'general', async (_signal, agentId) => {
      handedToExecutor = agentId
      return 'done'
    })

    await new Promise<void>((resolve) => reg.onComplete(id, () => resolve()))
    expect(id).toMatch(/^bg-/)
    expect(handedToExecutor).toBe(id)
  })
})
