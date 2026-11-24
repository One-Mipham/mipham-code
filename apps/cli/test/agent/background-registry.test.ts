import { describe, it, expect, vi } from 'vitest'
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

// CC 2.1.50-016 / -023 / -008: completed tasks keep their full result forever
// unless `prune()` runs, and nothing called it. Each spawn is the bounded
// moment to drop finished tasks.
describe('completed-task pruning', () => {
  it('spawn() prunes finished tasks', () => {
    const reg = new BackgroundAgentRegistry()
    const prune = vi.spyOn(reg, 'prune')
    reg.spawn('one', 'general', async () => 'done')
    expect(prune).toHaveBeenCalled()
  })

  it('prune removes a completed task older than the TTL', async () => {
    const reg = new BackgroundAgentRegistry()
    const id = reg.spawn('one', 'general', async () => 'done')
    await new Promise((resolve) => reg.onComplete(id, () => resolve(null)))
    // `prune` compares strictly (`now - completedAt > ttl`); give the clock a tick.
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(reg.prune(0)).toBe(1)
    expect(reg.get(id)).toBeUndefined()
  })
})
