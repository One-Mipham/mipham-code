/**
 * 捕获率的编排层（有 LLM 调用、有子进程判定），算术全在 `capture-rate.ts`。
 *
 * 三臂：`off`（不注入）· `on`（注入被测 skill 文本）· `oracle`（手写参考解，
 * **零 LLM 调用**，本地跑该题的冻结测试）。sealed 只作为**旁证读数**给出，
 * 永不进入任何裁定。
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
  /**
   * 正对照：把**同一臂**的读数喂给两侧，捕获率必须恰好为 0。
   * 不为 0 ⇒ 分子/分母/臂映射至少有一处接错了，整轮的其它读数都不可信。
   */
  controlRate: number | null
  /** sealed 池的同一套测量。每组只有 1 题，故它只是过拟合旁证，不是第二读数。 */
  sealed: { capture: CaptureResult; oraclePassed: boolean }
}

interface Arms {
  off: TaskPerformanceReport[]
  on: TaskPerformanceReport[]
  capture: CaptureResult
}

async function runArms(
  llm: Llm,
  tasks: PerformanceTask[],
  skillText: string,
  k: number,
  timeoutMs?: number,
): Promise<Arms> {
  const off: TaskPerformanceReport[] = []
  const on: TaskPerformanceReport[] = []
  const timeout = timeoutMs ? { timeoutMs } : {}
  for (let i = 0; i < k; i++) off.push(await runTaskPerformance(llm, { tasks, ...timeout }))
  for (let i = 0; i < k; i++) {
    on.push(await runTaskPerformance(llm, { tasks, skillText, ...timeout }))
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
  return { off, on, capture }
}

export async function measureCapture(
  llm: Llm,
  opts: { skillName: string; skillText: string; k?: number; timeoutMs?: number },
): Promise<CaptureMeasurement> {
  const k = opts.k ?? 3
  const all = loadPerformanceTasks({ pool: 'all' })
  const gateTasks = all.filter((t) => t.skill === opts.skillName && t.split === 'gate')
  const sealedTasks = all.filter((t) => t.skill === opts.skillName && t.split === 'sealed')

  const gate = await runArms(llm, gateTasks, opts.skillText, k, opts.timeoutMs)
  const sealed = await runArms(llm, sealedTasks, opts.skillText, k, opts.timeoutMs)

  // 正对照：同一臂两侧相等 ⇒ 率必须为 0。零成本，且能抓到臂接反/池映射错。
  // 取 **off 臂**：它的 headroom 正是真实率的分母，故真实率非 null 时这里必然也可算
  // （off 全满分的轮次本来就没有率，不需要另立一条「对照失效」的判据）。
  const offArm = [
    ...perTaskValue(
      gate.off.flatMap((r) => r.results),
      k,
    ),
  ].map(([taskId, value]) => ({
    taskId,
    value,
  }))
  const control = computeCapture({ off: offArm, on: offArm, total: gateTasks.length })

  const oraclePassed = gateTasks.every((t) => judgeGeneratedCode(t.testCode, t.oracleCode).passed)
  const sealedOraclePassed = sealedTasks.every(
    (t) => judgeGeneratedCode(t.testCode, t.oracleCode).passed,
  )

  return {
    off: gate.off,
    on: gate.on,
    capture: gate.capture,
    oraclePassed,
    controlRate: control.rate,
    sealed: { capture: sealed.capture, oraclePassed: sealedOraclePassed },
  }
}
