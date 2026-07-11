import { describe, it, expect } from 'vitest'
import { AgentViewManager } from '../../src/agent-view/agent-view-manager'

function makeManager(): AgentViewManager {
  return new AgentViewManager()
}

describe('AgentViewManager', () => {
  // ═══════════════════════════════════════════
  // create
  // ═══════════════════════════════════════════

  it('should create a session with correct initial state', () => {
    const mgr = makeManager()
    const session = mgr.create('Fix login bug', 'Fix the login redirect bug in auth flow', {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    })

    expect(session.id).toMatch(/^agent-\d+-\d+$/)
    expect(session.title).toBe('Fix login bug')
    expect(session.status).toBe('needs-input')
    expect(session.provider).toBe('anthropic')
    expect(session.model).toBe('claude-sonnet-4-6')
    expect(session.task).toBe('Fix the login redirect bug in auth flow')
    expect(session.messages).toHaveLength(0)
    expect(session.elapsedMs).toBe(0)
    expect(session.createdAt).toBeInstanceOf(Date)
  })

  // ═══════════════════════════════════════════
  // list + groupByStatus
  // ═══════════════════════════════════════════

  it('should list all sessions and group them by status', () => {
    const mgr = makeManager()

    const s1 = mgr.create('Task A', 'Do task A')
    const s2 = mgr.create('Task B', 'Do task B')
    const s3 = mgr.create('Task C', 'Do task C')

    // Transition some sessions
    mgr.updateStatus(s1.id, 'working')
    mgr.updateStatus(s2.id, 'completed')

    // list
    const all = mgr.list()
    expect(all).toHaveLength(3)

    // groupByStatus
    const groups = mgr.groupByStatus()
    expect(groups['needs-input']).toHaveLength(1)
    expect(groups['needs-input'][0]!.id).toBe(s3.id)
    expect(groups.working).toHaveLength(1)
    expect(groups.working[0]!.id).toBe(s1.id)
    expect(groups.completed).toHaveLength(1)
    expect(groups.completed[0]!.id).toBe(s2.id)
    expect(groups.failed).toHaveLength(0)
  })

  // ═══════════════════════════════════════════
  // get + peek + attach
  // ═══════════════════════════════════════════

  it('should get, peek, and attach to a session', () => {
    const mgr = makeManager()
    const session = mgr.create('Peek test', 'Testing peek')

    // Add some messages
    mgr.addMessage(session.id, { role: 'user', content: 'Start task' })
    mgr.addMessage(session.id, { role: 'assistant', content: 'Working on it...' })
    mgr.addMessage(session.id, { role: 'assistant', content: 'Done!' })

    // get
    const found = mgr.get(session.id)
    expect(found).toBeDefined()
    expect(found!.title).toBe('Peek test')

    // peek
    const peeked = mgr.peek(session.id)
    expect(peeked).toBeDefined()
    expect(peeked!.recentMessages).toHaveLength(3)
    expect(peeked!.recentMessages[0]!.content).toBe('Start task')
    expect(peeked!.recentMessages[2]!.content).toBe('Done!')
    expect(peeked!.session.id).toBe(session.id)

    // attach — transitions from needs-input to working
    const attached = mgr.attach(session.id)
    expect(attached).toBeDefined()
    expect(attached!.status).toBe('working')
    expect(attached!.startedAt).toBeInstanceOf(Date)

    // re-attach to working session should keep status
    const reattached = mgr.attach(session.id)
    expect(reattached!.status).toBe('working')
  })

  // ═══════════════════════════════════════════
  // kill + prune
  // ═══════════════════════════════════════════

  it('should kill active sessions and prune terminal ones', () => {
    const mgr = makeManager()

    const s1 = mgr.create('Active', 'Active task')
    const s2 = mgr.create('Done', 'Done task')
    const s3 = mgr.create('Failed', 'Failed task')

    mgr.updateStatus(s2.id, 'completed')
    mgr.updateStatus(s3.id, 'failed')

    // Kill active session
    const killed = mgr.kill(s1.id)
    expect(killed).toBe(true)
    expect(mgr.get(s1.id)!.status).toBe('failed')

    // Cannot kill already terminal sessions
    const reKilled = mgr.kill(s2.id)
    expect(reKilled).toBe(false)
    expect(mgr.get(s2.id)!.status).toBe('completed')

    // Kill non-existent
    expect(mgr.kill('nonexistent')).toBe(false)

    // Prune removes completed + failed sessions
    const pruned = mgr.prune()
    expect(pruned).toBe(3) // all three are terminal now
    expect(mgr.list()).toHaveLength(0)
  })

  // ═══════════════════════════════════════════
  // countByStatus
  // ═══════════════════════════════════════════

  it('should count sessions by status', () => {
    const mgr = makeManager()

    mgr.create('A', 'Task A')
    mgr.create('B', 'Task B')

    const s3 = mgr.create('C', 'Task C')
    mgr.updateStatus(s3.id, 'working')

    const counts = mgr.countByStatus()
    expect(counts['needs-input']).toBe(2)
    expect(counts.working).toBe(1)
    expect(counts.completed).toBe(0)
    expect(counts.failed).toBe(0)
  })
})
