// CRSI RewardFn 接口——reward function = policy→feedback 抽象。
// 统一「给一个 policy 打分」：机制哨兵（runEval）与任务表现（runTaskPerformance）
// 都 conform 成 RewardFn，自改进环的 verify 阶段可对任意奖励源比分数、判退化。
import type { Llm } from '../providers/llm'
import { runEval } from './eval-harness'
import { runTaskPerformance } from './task-performance'

/** 奖励函数统一输出的「分数」形状——所有 RewardFn 的 evaluate 都产出它。 */
export interface ScoreReport {
  total: number
  passed: number
  score: number // 0-100
  failures: string[]
}

/** 奖励函数（reward function = policy→feedback）：一个具名、可替换的打分器。 */
export interface RewardFn {
  name: string
  description: string
  evaluate(): Promise<ScoreReport> | ScoreReport
}

/** 机制哨兵：冻结契约评当前仓库机制代码（无 LLM，同步）。 */
export function mechanismSentinel(): RewardFn {
  return {
    name: 'mechanism-sentinel',
    description: '冻结契约评当前仓库机制代码（无 LLM）',
    evaluate: () => runEval(),
  }
}

/** 任务表现：LLM 生成代码 + 冻结测试判定（有 LLM，异步）。 */
export function taskPerformanceRewardFn(llm: Llm): RewardFn {
  return {
    name: 'task-performance',
    description: 'LLM 生成 + 冻结测试评 skill/通用任务',
    evaluate: () => runTaskPerformance(llm),
  }
}

/** 可枚举的奖励函数注册表。llm 缺省时只含无 LLM 的机制哨兵。 */
export function listRewardFns(llm?: Llm): RewardFn[] {
  return [mechanismSentinel(), ...(llm ? [taskPerformanceRewardFn(llm)] : [])]
}
