import type { Service } from '../index'
import type { Llm } from '../../providers/llm'

export type PlanTask = { id: string; description: string }
export type Plan = { name: string; tasks: PlanTask[] }
export type TaskOutcome = {
  taskId: string
  status: 'done' | 'needs-changes' | 'error'
  result: string
  review: string
}

export const PLAN_RUNNER_KEY = 'plan-runner'

export interface PlanRunner {
  run(plan: Plan): Promise<TaskOutcome[]>
}

// 事件契约：declaration merging 扩展 EventMap（内核首例，不改内核）
declare module '../events' {
  interface EventMap {
    'plan/task-start': { mode: 'emit'; in: { taskId: string } }
    'plan/task-done': {
      mode: 'emit'
      in: { taskId: string; status: 'done' | 'needs-changes' | 'error' }
    }
  }
}

async function chatText(llm: Llm, prompt: string, model: string): Promise<string> {
  let text = ''
  for await (const chunk of llm.chat({
    model,
    messages: [{ role: 'user', content: prompt }],
  })) {
    if (chunk.type === 'text' && chunk.content) text += chunk.content
  }
  return text
}

/** 创建 plan-runner Service。model 缺省为空串（「用 active model」，由 ProviderRegistry 的 req.model || activeModelId 回退）；传值则锁定该模型。 */
export function createPlanRunnerService(options: { model?: string } = {}): Service {
  const model = options.model ?? ''
  return {
    inject: ['llm'],
    apply(ctx) {
      const runner: PlanRunner = {
        async run(plan) {
          const outcomes: TaskOutcome[] = []
          for (const task of plan.tasks) {
            ctx.emit('plan/task-start', { taskId: task.id })
            const taskCtx = ctx.scope(task.id) // 每任务独立作用域（继承父层 llm 缝）
            let result = ''
            let review = ''
            try {
              result = await chatText(
                taskCtx.get<Llm>('llm')!,
                `Implement: ${task.description}`,
                model,
              )
              review = await chatText(
                taskCtx.get<Llm>('llm')!,
                `Review: does the result satisfy "${task.description}"? Result: ${result}`,
                model,
              )
            } catch (e) {
              outcomes.push({ taskId: task.id, status: 'error', result, review: String(e) })
              ctx.emit('plan/task-done', { taskId: task.id, status: 'error' })
              continue
            }
            const status: TaskOutcome['status'] = review.startsWith('APPROVE')
              ? 'done'
              : 'needs-changes'
            outcomes.push({ taskId: task.id, status, result, review })
            ctx.emit('plan/task-done', { taskId: task.id, status })
          }
          return outcomes
        },
      }
      ctx.provide(PLAN_RUNNER_KEY, runner)
    },
  }
}

/** 默认 plan-runner Service（model 空串 = 用 active model）。 */
export const planRunnerService: Service = createPlanRunnerService()
