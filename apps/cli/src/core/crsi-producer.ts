/**
 * CRSI Producer — 把累积的失败信号转成「教训文件」代码改动候选。
 *
 * 这是 CRSI 闭环「reflect → verify → consolidate」的 reflect→verify 桥：
 *   - 输入：AutoMemoryEngine 的 CrsiInsight + MetaRuleEngine 的 MetaRule（都是「建议」）。
 *   - 输出：一个 CrsiProposal —— 对 `crsi-lessons.md` 的追加（模板化，不动 LLM 判断）。
 *   - 走 runCrsiModification（沙箱 gate）→ 人类批准 → merge。
 *
 * 诚实标注：沙箱的 verify 是「防回归」（测试仍绿），不是「证明更好」——
 * 后者需要 ground-truth eval harness，是独立的下一步。
 */

import type { CrsiInsight } from './auto-memory'
import type { MetaRule } from './meta-rule-engine'

/** 教训文件（相对仓库根）。预建，沙箱只能改已存在文件。 */
export const LESSONS_FILE = 'apps/cli/crsi-lessons.md'

/** 归一化的教训信号（insight 与 meta-rule 的公共面）。 */
export interface CrsiSignal {
  category: string
  title: string
  severity?: string
  suggestion: string
  evidence: string[]
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 }

/**
 * 选一条「最该固化成教训」的信号：
 *   1. 优先 autoApplicable 的 insight，按严重度排序（critical > warning > info）。
 *   2. 没有 insight 时，回退到高置信、autoApplicable 的元规则。
 */
export function selectCrsiSignal(
  insights: CrsiInsight[],
  metaRules: MetaRule[],
): CrsiSignal | null {
  const best = insights
    .filter((i) => i.autoApplicable)
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3))[0]
  if (best) {
    return {
      category: best.category,
      title: best.description,
      severity: best.severity,
      suggestion: best.suggestion,
      evidence: best.evidence,
    }
  }

  const mr = metaRules.find((m) => m.autoApplicable && m.confidence === 'high')
  if (mr) {
    return {
      category: mr.category,
      title: mr.title,
      suggestion: mr.recommendation,
      evidence: [mr.evidence.summary],
    }
  }

  return null
}

/** 模板化地把信号渲染成一段教训 markdown（不动 LLM）。 */
export function buildLessonContent(signal: CrsiSignal, timestamp: string): string {
  const lines: string[] = [
    `## ${signal.category}: ${signal.title}`,
    '',
    `- 建议: ${signal.suggestion}`,
  ]
  if (signal.severity) lines.push(`- 严重度: ${signal.severity}`)
  lines.push(`- 生成时间: ${timestamp}`, '- 来源: CRSI producer (autoApplicable)', '', '### 证据')
  for (const e of signal.evidence) lines.push(`- ${e}`)
  lines.push('')
  return lines.join('\n')
}

/** 产出教训文件变更候选。无合格信号时返回 null。 */
export function produceCrsiProposal(
  insights: CrsiInsight[],
  metaRules: MetaRule[],
  currentLessons: string,
  timestamp: string,
): { description: string; filePath: string; newContent: string; originalContent: string } | null {
  const signal = selectCrsiSignal(insights, metaRules)
  if (!signal) return null

  const lesson = buildLessonContent(signal, timestamp)
  const newContent = currentLessons ? `${currentLessons.trimEnd()}\n\n${lesson}\n` : `${lesson}\n`

  return {
    description: `CRSI lesson: ${signal.category} — ${signal.title}`,
    filePath: LESSONS_FILE,
    newContent,
    originalContent: currentLessons,
  }
}
