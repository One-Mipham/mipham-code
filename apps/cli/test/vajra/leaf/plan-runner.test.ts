import { describe, it, expect } from 'vitest'
import { Context } from '../../../src/vajra'
import { LLM_KEY } from '../../../src/providers/llm'
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
    const started: string[] = []
    ctx.on('plan/task-start', (e) => started.push(e.taskId))
    const done: string[] = []
    ctx.on('plan/task-done', (e) => done.push(e.taskId))

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
    expect(started).toEqual(['t1', 't2'])
    expect(done).toEqual(['t1', 't2'])
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
})
