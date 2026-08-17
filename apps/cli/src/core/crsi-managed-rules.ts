/**
 * CRSI 受管理规则（source='managed'）——producer 的「行为」产物。
 *
 * 由 `/crsi propose --rule` 产出、经 CrsiSandbox 跑全量测试 + 人类批准后合入。
 * 与 builtin 同权重（构造时 merge 进 ExperienceRuleEngine），但永不落盘——源码即
 * 真相，restart 后仍生效。producer 通过模板化追加此数组，把一条失败信号固化成
 * 真实拦截行为（而非 prose 教训）。
 */
import type { ToolRule } from './rule-engine'
import { MANAGED_DANGEROUS_RE } from './crsi-producer'

/** 危险命令正则（与 crsi-producer.MANAGED_DANGEROUS_RE 单一真源）。 */
const DANGEROUS_RE = new RegExp(MANAGED_DANGEROUS_RE)

export const MANAGED_RULES: ToolRule[] = [
  // ── CRSI producer 追加点（勿删此标记）──
  {
    id: 'managed-tool-params-dangerous-commands',
    toolName: 'Bash',
    category: 'tool-params',
    match: (p) => {
      const cmd = String(p.command ?? '')
      return DANGEROUS_RE.test(cmd) && !p.dangerouslyDisableSandbox
    },
    fix: (p) => ({
      modified: p,
      warning:
        '⚠️ 检测到危险命令（rm -rf / 管道投毒 / git reset --hard / chmod 777 / 格盘 / 关停主机 / 清空 cron）。如需执行请设置 dangerouslyDisableSandbox: true',
    }),
    source: 'managed',
    enabled: true,
  },
]
