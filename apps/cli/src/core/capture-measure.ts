/**
 * 捕获率的编排层（有 LLM 调用、有子进程判定），算术全在 `capture-rate.ts`。
 *
 * 三臂：`off`（不注入）· `on`（注入被测 skill 文本）· `oracle`（手写参考解，
 * **零 LLM 调用**，本地跑该题的冻结测试）。sealed 题不参与本函数。
 */

import type { Llm } from '../providers/llm'
import {
  judgeGeneratedCode,
  loadPerformanceTasks,
  runTaskPerformance,
  type PerformanceTask,
  type TaskPerformanceReport,
} from './task-performance'
import { computeCapture, perTaskValue, type CaptureResult } from './capture-rate'

export interface CaptureMeasurement {
  /** k 次 off 运行（不注入）。 */
  off: TaskPerformanceReport[]
  /** k 次 on 运行（注入 skillText）。 */
  on: TaskPerformanceReport[]
  capture: CaptureResult
  /** 参考解是否全部通过自己的冻结测试。false ⇒ 上界不可信，整轮作废。 */
  oraclePassed: boolean
}

export async function measureCapture(
  llm: Llm,
  opts: { skillName: string; skillText: string; k?: number; timeoutMs?: number },
): Promise<CaptureMeasurement> {
  const k = opts.k ?? 3
  // 只取 gate 池（loadPerformanceTasks 的缺省），sealed 永不参与测量。
  const tasks: PerformanceTask[] = loadPerformanceTasks().filter((t) => t.skill === opts.skillName)

  const off: TaskPerformanceReport[] = []
  const on: TaskPerformanceReport[] = []
  for (let i = 0; i < k; i++) {
    off.push(
      await runTaskPerformance(llm, {
        tasks,
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      }),
    )
  }
  for (let i = 0; i < k; i++) {
    on.push(
      await runTaskPerformance(llm, {
        tasks,
        skillText: opts.skillText,
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      }),
    )
  }

  const toArm = (values: Map<string, number | null>) =>
    [...values].map(([taskId, value]) => ({ taskId, value }))

  const capture = computeCapture({
    off: toArm(
      perTaskValue(
        off.flatMap((r) => r.results),
        k,
      ),
    ),
    on: toArm(
      perTaskValue(
        on.flatMap((r) => r.results),
        k,
      ),
    ),
    total: tasks.length,
  })

  const oraclePassed = tasks.every((t) => judgeGeneratedCode(t.testCode, t.oracleCode).passed)

  return { off, on, capture, oraclePassed }
}
