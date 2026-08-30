import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderWorkingState } from '../../src/core/working-memory'
import { MemoryManager } from '../../src/core/memory/memory-manager'

describe('renderWorkingState', () => {
  it('returns empty when no open tasks', () => {
    expect(renderWorkingState([])).toBe('')
    expect(renderWorkingState([{ subject: 'done', status: 'completed' }])).toBe('')
    expect(renderWorkingState([{ subject: 'gone', status: 'deleted' }])).toBe('')
  })

  it('renders only pending/in_progress subjects', () => {
    const tasks = [
      { subject: 'implement working memory', status: 'in_progress' },
      { subject: 'write tests', status: 'pending' },
      { subject: 'already done', status: 'completed' },
      { subject: 'deleted task', status: 'deleted' },
    ]
    const out = renderWorkingState(tasks)
    expect(out).toContain('implement working memory')
    expect(out).toContain('write tests')
    expect(out).not.toContain('already done')
    expect(out).not.toContain('deleted task')
  })
})

describe('recall grounding', () => {
  it('surfaces a memory matching a pending task, even when the query does not match it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mipham-wm-'))
    const mm = new MemoryManager(dir)
    mm.write('deploy-checklist', 'always run pnpm test before deploying', {
      type: 'project',
      relevance: ['deploy', 'test'],
    })
    mm.write('unrelated', 'the sky is blue', { type: 'reference', relevance: ['sky'] })

    // 无接地：query「hello world」不含 deploy，deploy-checklist 不被召回。
    const bare = mm.recall('hello world', 10)
    expect(bare.map((m) => m.name)).not.toContain('deploy-checklist')

    // 有接地：pending 任务「deploy the app」把 deploy-checklist 拉上来（治「前存后忘」）。
    const grounded = mm.recall('hello world', 10, 'deploy the app')
    expect(grounded.map((m) => m.name)).toContain('deploy-checklist')

    rmSync(dir, { recursive: true, force: true })
  })
})
