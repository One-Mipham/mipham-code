/**
 * Capability Inventory — 能力自报告。
 *
 * 聚合 CRSI 学习 / SIS 免疫 / 宪法对齐 / 未接线子系统的实时状态，
 * 让「我有什么 / 缺什么」这类问题的答案来自持久化状态，
 * 而非 prompt 里的静态工具清单。
 */

/** 报告所需的最小引擎面。`QueryEngine` 结构上满足此接口（各 getter 均为可选，空实现安全）。 */
export interface CapabilitySources {
  getRuleEngine?: () => { getActiveRules(): Array<{ source?: string }> } | undefined
  getPatternAnalyzer?: () => { analyzeAllAgents(): unknown[] }
  getAutoMemory?: () => { accumulatedInsights: unknown[] }
  getMetaRuleEngine?: () => { analyze(): { metaRules: unknown[] } }
  getErrorSignatureDB?: () => {
    getStats(): {
      total: number
      active: number
      degraded: number
      retired: number
      avgSuccessRate: number
      totalInterceptions: number
    }
  }
  getConstitutionLoader?: () => {
    load(): { version: string; principles: Array<{ facet?: string }>; preamble?: string }
  }
  getSelfCritique?: () => { getConfig(): { enabled: boolean } }
}

/** 元规则分析是报告里最重/最脆弱的一步——独立隔离，失败时归零而非让整份报告崩溃。 */
function safeMetaRuleCount(engine: CapabilitySources): number {
  try {
    return engine.getMetaRuleEngine?.()?.analyze().metaRules.length ?? 0
  } catch {
    return 0
  }
}

export function buildCapabilityReport(engine: CapabilitySources): string {
  const lines: string[] = ['## 🧭 能力自报告 (CRSI Inventory)', '']

  // ── 🧠 学习 (CRSI) ──
  const rules = engine.getRuleEngine?.()?.getActiveRules() ?? []
  const builtin = rules.filter((r) => r.source === 'builtin').length
  const auto = rules.filter((r) => r.source === 'pattern-analyzer').length
  const manual = rules.filter((r) => r.source === 'manual').length
  const patterns = engine.getPatternAnalyzer?.()?.analyzeAllAgents() ?? []
  const insights = engine.getAutoMemory?.()?.accumulatedInsights ?? []

  lines.push('### 🧠 学习 (CRSI)', '')
  lines.push('| 指标 | 值 |')
  lines.push('|------|----|')
  lines.push(`| 活跃规则 | ${rules.length} (内置 ${builtin} · 自动 ${auto} · 手动 ${manual}) |`)
  lines.push(`| 已检测模式 | ${patterns.length} |`)
  lines.push(`| 反思洞察 | ${insights.length} |`)
  lines.push(`| 元规则 | ${safeMetaRuleCount(engine)} |`)

  // ── 🛡️ 免疫 (SIS) ──
  const sis = engine.getErrorSignatureDB?.()?.getStats()
  lines.push('', '### 🛡️ 免疫 (SIS)', '')
  if (sis) {
    lines.push('| 指标 | 值 |')
    lines.push('|------|----|')
    lines.push(
      `| 错误签名 | ${sis.total} 条 (🟢${sis.active} · 🟡${sis.degraded} · ⚫${sis.retired}) |`,
    )
    lines.push(`| 平均成功率 | ${Math.round(sis.avgSuccessRate * 100)}% |`)
    lines.push(`| 总拦截 | ${sis.totalInterceptions} 次 |`)
  } else {
    lines.push('_未初始化_')
  }

  // ── 🔒 宪法 (对齐) ──
  const constitution = engine.getConstitutionLoader?.()?.load()
  lines.push('', '### 🔒 宪法 (对齐)', '')
  if (constitution) {
    const karuna = constitution.principles.filter((p) => p.facet === 'karuna').length
    const prajna = constitution.principles.filter((p) => p.facet === 'prajna').length
    const vajra = constitution.principles.filter((p) => p.facet === 'vajra').length
    lines.push('| 指标 | 值 |')
    lines.push('|------|----|')
    lines.push(`| 版本 | ${constitution.version} |`)
    lines.push(
      `| 原则 | ${constitution.principles.length} 条 (悲 ${karuna} · 智 ${prajna} · 金刚 ${vajra}) |`,
    )
    lines.push(`| 愿力序言 | ${constitution.preamble ? '已注入 self-critique' : '无'} |`)
  } else {
    lines.push('_未初始化_')
  }

  // ── ⚠️ 未接线 / 待启用 ──
  const selfCritique = engine.getSelfCritique?.()?.getConfig()
  lines.push('', '### ⚠️ 未接线 / 待启用', '')
  lines.push(`| self-critique | ${selfCritique?.enabled ? '🟢 已启用' : '⚫ 未启用 (opt-in)'} |`)

  return lines.join('\n')
}
