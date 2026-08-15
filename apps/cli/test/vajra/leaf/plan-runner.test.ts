import { describe, it, expect } from 'vitest'
import { Context } from '../../../src/vajra'
import { LLM_KEY, type Llm } from '../../../src/providers/llm'
import { recordLlm, replayLlm, type RecordedTurn } from '../../../src/providers/llm-replay'
import {
  planRunnerService,
  PLAN_RUNNER_KEY,
  type PlanRunner,
} from '../../../src/vajra/leaf/plan-runner'

const text = (s: string): RecordedTurn => ({
  req: { model: 'm', messages: [] },
  chunks: [{ type: 'text', content: s }, { type: 'stop' }],
})

describe('plan-runner leaf', () => {
  it('runs a plan via the injected llm seam and emits events', async () => {
    const ctx = new Context()
    ctx.provide(
      LLM_KEY,
      replayLlm([
        text('implemented A'),
        text('APPROVE — good'),
        text('implemented B'),
        text('REJECT — needs work'),
      ]),
    )
    const seq: string[] = []
    ctx.on('plan/task-start', (e) => seq.push(`start:${e.taskId}`))
    ctx.on('plan/task-done', (e) => seq.push(`done:${e.taskId}`))

    ctx.mount(planRunnerService)
    const runner = ctx.get<PlanRunner>(PLAN_RUNNER_KEY)!
    const outcomes = await runner.run({
      name: 'p',
      tasks: [
        { id: 't1', description: 'do A' },
        { id: 't2', description: 'do B' },
      ],
    })

    expect(outcomes.map((o) => o.status)).toEqual(['done', 'needs-changes'])
    expect(seq).toEqual(['start:t1', 'done:t1', 'start:t2', 'done:t2'])
  })

  it('service waits for the llm dependency (mount before provide)', () => {
    const ctx = new Context()
    const mounted = ctx.mount(planRunnerService)
    expect(mounted.status()).toBe('inactive')
    ctx.provide(LLM_KEY, replayLlm([]))
    expect(mounted.status()).toBe('active')
  })

  it('consumes the injected llm (recordLlm proves the seam, not a default)', async () => {
    const ctx = new Context()
    const recorder = recordLlm(replayLlm([text('X'), text('APPROVE')]))
    ctx.provide(LLM_KEY, recorder.llm)
    ctx.mount(planRunnerService)
    const runner = ctx.get<PlanRunner>(PLAN_RUNNER_KEY)!
    await runner.run({ name: 'p', tasks: [{ id: 't1', description: 'do X' }] })
    expect(recorder.turns).toHaveLength(2)
    expect(recorder.turns[0]!.req.messages[0]!.content).toContain('Implement:')
    expect(recorder.turns[1]!.req.messages[0]!.content).toContain('Review:')
  })

  it('records an error outcome and continues to the next task', async () => {
    const ctx = new Context()
    let calls = 0
    const flakyLlm: Llm = {
      async *chat() {
        calls += 1
        if (calls === 1) throw new Error('boom')
        yield { type: 'text', content: 'APPROVE' }
        yield { type: 'stop' }
      },
    }
    ctx.provide(LLM_KEY, flakyLlm)
    const done: Array<{ taskId: string; status: string }> = []
    ctx.on('plan/task-done', (e) => done.push({ taskId: e.taskId, status: e.status }))

    ctx.mount(planRunnerService)
    const runner = ctx.get<PlanRunner>(PLAN_RUNNER_KEY)!
    const outcomes = await runner.run({
      name: 'p',
      tasks: [
        { id: 't1', description: 'boom' },
        { id: 't2', description: 'ok' },
      ],
    })

    expect(outcomes.map((o) => o.status)).toEqual(['error', 'done'])
    expect(outcomes[0]!.review).toContain('boom')
    expect(done).toEqual([
      { taskId: 't1', status: 'error' },
      { taskId: 't2', status: 'done' },
    ])
  })
})
