import { describe, it, expect } from 'vitest'
import { SessionWorker } from '../../src/daemon/session-worker'

describe('SessionWorker', () => {
  it('getLastAssistantContent 委托给 engine', () => {
    const engine = { getLastAssistantContent: () => '最终回复' } as any
    const worker = new SessionWorker(engine, {} as any, {} as any)
    expect(worker.getLastAssistantContent()).toBe('最终回复')
  })
})
