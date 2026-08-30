import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderWorkingState, WorkingMemory } from '../../src/core/working-memory'
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

describe('WorkingMemory (Phase 2 证据接地状态机)', () => {
  it('renderWorkingState() 输出紧凑三态块，空状态渲染空串', () => {
    const wm = new WorkingMemory()
    expect(wm.renderWorkingState()).toBe('')

    wm.setGoal('a', 'install deps')
    wm.setGoal('b', 'write test')
    wm.observe('b', { verdict: 'supported', checkerId: 'bash-exit' })
    const out = wm.renderWorkingState()
    expect(out).toContain('[WORKING] pending: install deps')
    expect(out).toContain('[WORKING] done: write test')
    expect(out).toContain('[WORKING] blocked: (none)')
  })

  it('done 只能由 checker supported 推进；rejected 置 blocked；no-checker 状态不变', () => {
    const wm = new WorkingMemory()
    wm.setGoal('g', 'do the thing')

    // 模型自称不算：no-checker 不改状态
    wm.observe('g', { verdict: 'no-checker' })
    expect(wm.getGoal('g')!.status).toBe('pending')

    // rejected → blocked（不是 done）
    wm.observe('g', { verdict: 'rejected', checkerId: 'bash-exit', reason: 'exit 1' })
    expect(wm.getGoal('g')!.status).toBe('blocked')
    expect(wm.getGoal('g')!.evidence).toEqual(['rejected:bash-exit:exit 1'])

    // blocked 可被后续 supported 推到 done（重试成功）
    wm.observe('g', { verdict: 'supported', checkerId: 'bash-exit' })
    expect(wm.getGoal('g')!.status).toBe('done')
  })

  it('done 后不再回退', () => {
    const wm = new WorkingMemory()
    wm.setGoal('g', 'x')
    wm.observe('g', { verdict: 'supported', checkerId: 'bash-exit' })
    wm.observe('g', { verdict: 'rejected', checkerId: 'bash-exit', reason: 'y' })
    expect(wm.getGoal('g')!.status).toBe('done')
  })

  it('setGoal 重复 id 只更新 content，不回退已验证状态', () => {
    const wm = new WorkingMemory()
    wm.setGoal('g', 'original')
    wm.observe('g', { verdict: 'supported', checkerId: 'bash-exit' })
    wm.setGoal('g', 'updated')
    expect(wm.getGoal('g')!.status).toBe('done')
    expect(wm.getGoal('g')!.content).toBe('updated')
  })
})
