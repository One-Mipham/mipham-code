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
      fixable: number
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

/**
 * Ledger-backed numbers, already loaded and summarised by the caller.
 *
 * Kept out of `buildCapabilityReport` so the report stays pure and testable:
 * the command reads `~/.mipham/crsi/*.jsonl`, the builder only renders.
 */
export interface CapabilityLedgers {
  lastEval?: { score: number; passed: number; total: number; timestamp: string }
  improvements?: { count: number; verdicts: Record<string, number>; latestTimestamp: string }
  probation?: { count: number; latestTimestamp: string }
}

/** A ledger row, stamped with the file and the record's own timestamp. */
function ledgerRow(metric: string, value: string, file: string, timestamp?: string): string {
  const source = timestamp ? `ledger:${file}@${timestamp}` : `ledger:${file}（未找到）`
  return `| ${metric} | ${value} | ${source} |`
}

/**
 * 能力自报告。
 *
 * **每个数字都带出处**：`now（getter）` 是本次调用实时读到的，`ledger:…@…` 是台账
 * 里那条记录的时间戳。这份报告刻意不引用文档数字 —— 文档值不是实测值，而两者
 * 混在一张「读数」表里，正是 2026-11-26 那次自评把 CLAUDE.md 的 5,349 当成
 * 实测结果的原因。
 */
export function buildCapabilityReport(
  engine: CapabilitySources,
  ledgers: CapabilityLedgers = {},
): string {
  const lines: string[] = ['## 🧭 能力自报告 (CRSI Inventory)', '']

  // ── 🧠 学习 (CRSI) ──
  const rules = engine.getRuleEngine?.()?.getActiveRules() ?? []
  const builtin = rules.filter((r) => r.source === 'builtin').length
  const auto = rules.filter((r) => r.source === 'pattern-analyzer').length
  const manual = rules.filter((r) => r.source === 'manual').length
  const patterns = engine.getPatternAnalyzer?.()?.analyzeAllAgents() ?? []
  const insights = engine.getAutoMemory?.()?.accumulatedInsights ?? []

  lines.push('### 🧠 学习 (CRSI)', '')
  lines.push('| 指标 | 值 | 出处 |')
  lines.push('|------|----|------|')
  lines.push(
    `| 活跃规则 | ${rules.length} (内置 ${builtin} · 自动 ${auto} · 手动 ${manual}) | now（getRuleEngine） |`,
  )
  lines.push(`| 已检测模式 | ${patterns.length} | now（getPatternAnalyzer） |`)
  lines.push(`| 反思洞察 | ${insights.length} | now（getAutoMemory） |`)
  lines.push(`| 元规则 | ${safeMetaRuleCount(engine)} | now（getMetaRuleEngine） |`)

  // ── 🛡️ 免疫 (SIS) ──
  const sis = engine.getErrorSignatureDB?.()?.getStats()
  lines.push('', '### 🛡️ 免疫 (SIS)', '')
  if (sis) {
    lines.push('| 指标 | 值 | 出处 |')
    lines.push('|------|----|------|')
    lines.push(
      `| 错误签名 | ${sis.total} 条 (🟢${sis.active} · 🟡${sis.degraded} · ⚫${sis.retired}) | now（getErrorSignatureDB） |`,
    )
    lines.push(
      `| 平均成功率 | ${
        sis.fixable > 0 ? `${Math.round(sis.avgSuccessRate * 100)}%` : '—（无可自动修复签名）'
      } | now（getErrorSignatureDB） |`,
    )
    lines.push(`| 总拦截 | ${sis.totalInterceptions} 次 | now（getErrorSignatureDB） |`)
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
    lines.push('| 指标 | 值 | 出处 |')
    lines.push('|------|----|------|')
    lines.push(`| 版本 | ${constitution.version} | now（getConstitutionLoader） |`)
    lines.push(
      `| 原则 | ${constitution.principles.length} 条 (悲 ${karuna} · 智 ${prajna} · 金刚 ${vajra}) | now（getConstitutionLoader） |`,
    )
    lines.push(
      `| 愿力序言 | ${constitution.preamble ? '已注入 self-critique' : '无'} | now（getConstitutionLoader） |`,
    )
  } else {
    lines.push('_未初始化_')
  }

  // ── ⚠️ 未接线 / 待启用 ──
  const selfCritique = engine.getSelfCritique?.()?.getConfig()
  lines.push('', '### ⚠️ 未接线 / 待启用', '')
  lines.push('| 指标 | 值 | 出处 |')
  lines.push('|------|----|------|')
  lines.push(
    `| self-critique | ${selfCritique?.enabled ? '🟢 已启用' : '⚫ 未启用 (opt-in)'} | now（getSelfCritique） |`,
  )

  // ── 📊 真值评估（台账） ──
  lines.push('', '### 📊 真值评估（台账）', '')
  lines.push('| 指标 | 值 | 出处 |')
  lines.push('|------|----|------|')
  if (ledgers.lastEval) {
    const e = ledgers.lastEval
    lines.push(
      ledgerRow(
        '最近机制 eval',
        `${e.passed}/${e.total}（score ${e.score}）`,
        'eval-scores.jsonl',
        e.timestamp,
      ),
    )
  } else {
    lines.push(ledgerRow('最近机制 eval', '无记录', 'eval-scores.jsonl'))
  }
  if (ledgers.improvements) {
    const im = ledgers.improvements
    const verdicts = Object.entries(im.verdicts)
      .map(([verdict, count]) => `${verdict} ${count}`)
      .join(' · ')
    lines.push(
      ledgerRow(
        '改进台账',
        `${im.count} 条${verdicts ? `（${verdicts}）` : ''}`,
        'improvements.jsonl',
        im.latestTimestamp,
      ),
    )
  } else {
    lines.push(ledgerRow('改进台账', '无记录', 'improvements.jsonl'))
  }
  if (ledgers.probation) {
    lines.push(
      ledgerRow(
        '试用期',
        `${ledgers.probation.count} 条`,
        'probation.jsonl',
        ledgers.probation.latestTimestamp,
      ),
    )
  } else {
    lines.push(ledgerRow('试用期', '无记录', 'probation.jsonl'))
  }

  lines.push(
    '',
    '> 出处：`now（getter）` = 本次调用实时读取；`ledger:<文件>@<ISO 时间>` = 该台账最后一条记录。',
    '> 本报告不引用文档数字 —— 文档值不能当作实测值。',
  )

  return lines.join('\n')
}
