/**
 * CRSI 受管理规则（source='managed'）——producer 的「行为」产物。
 *
 * 由 `/crsi propose --rule` 产出、经 CrsiSandbox 跑全量测试 + 人类批准后合入。
 * 与 builtin 同权重（构造时 merge 进 ExperienceRuleEngine），但永不落盘——源码即
 * 真相，restart 后仍生效。producer 通过模板化追加此数组，把一条失败信号固化成
 * 真实拦截行为（而非 prose 教训）。
 */
import type { ToolRule } from './rule-engine'

export const MANAGED_RULES: ToolRule[] = [
  // ── CRSI producer 追加点（勿删此标记）──
]
