/**
 * SIS Phase 3 (RSI Level 3): Meta-Rule Engine — Rules About Rules
 *
 * The recursive core of CRSI: analyzes accumulated SIS data to
 * improve the rule-generation system itself.
 *
 * Meta-rule types:
 *   1. Threshold Tuning — adjust confidence thresholds based on outcomes
 *   2. Strategy Optimization — which fixStrategy works best per category?
 *   3. Cross-Rule Patterns — discover relationships across unrelated rules
 *   4. Category Emergence — detect new error categories not in the predefined set
 *
 * Flow:
 *   ErrorSignatureDB + EffectivenessTracker data
 *     → MetaRuleEngine.analyze()
 *       → MetaRule[] (actionable suggestions for rule system improvement)
 *         → /crsi meta displays + optionally auto-applies safe meta-rules
 */

import type { ErrorSignatureDB, ErrorSignature } from './error-signature-db.js'
import type { EffectivenessTracker, RuleEffectiveness } from '../agent/effectiveness-tracker.js'

// ── Types ──

export type MetaRuleCategory =
  | 'threshold-tuning'
  | 'strategy-optimization'
  | 'cross-rule-pattern'
  | 'category-emergence'

export type MetaRuleConfidence = 'high' | 'medium' | 'low'

export interface MetaRule {
  /** Unique identifier */
  id: string
  /** Type of meta-rule */
  category: MetaRuleCategory
  /** Human-readable title */
  title: string
  /** Detailed explanation */
  description: string
  /** Suggested action */
  recommendation: string
  /** Whether this can be auto-applied safely */
  autoApplicable: boolean
  /** Statistical evidence supporting this meta-rule */
  evidence: MetaEvidence
  /** Confidence level */
  confidence: MetaRuleConfidence
  /** When this meta-rule was generated */
  generatedAt: string
}

export interface MetaEvidence {
  /** Number of data points supporting this conclusion */
  sampleSize: number
  /** Key metrics */
  metrics: Record<string, number>
  /** Supporting rule/signature IDs */
  relatedIds: string[]
  /** Raw summary for display */
  summary: string
}

export interface MetaAnalysis {
  /** Discovered meta-rules */
  metaRules: MetaRule[]
  /** Overall system health assessment */
  systemHealth: SystemHealth
  /** When the analysis was performed */
  analyzedAt: string
}

export interface SystemHealth {
  /** Overall CRSI health score (0-100) */
  score: number
  /** Component-level scores */
  components: {
    errorSignatures: number // 0-100
    preflightPrevention: number
    autoCorrection: number
    immuneMemory: number
    ruleEffectiveness: number
  }
  /** Top-level assessment */
  assessment: string
  /** Recommended actions */
  recommendations: string[]
}

// ── Constants ──

/** Minimum data points needed to generate a meta-rule */
const MIN_SAMPLE_SIZE = 5

/** High-confidence threshold for auto-application */
const AUTO_APPLY_CONFIDENCE = 0.85

/** Categories ordered by severity for ranking */
const CATEGORY_SEVERITY: Record<string, number> = {
  timeout: 3,
  'tool-params': 3,
  import: 2,
  search: 2,
  semantic: 1,
}

// ── Engine ──

export class MetaRuleEngine {
  private errorDB?: ErrorSignatureDB
  private tracker?: EffectivenessTracker

  constructor(errorDB?: ErrorSignatureDB, tracker?: EffectivenessTracker) {
    this.errorDB = errorDB
    this.tracker = tracker
  }

  /** Set or update the data sources after construction. */
  setErrorDB(db: ErrorSignatureDB): void {
    this.errorDB = db
  }

  setTracker(tracker: EffectivenessTracker): void {
    this.tracker = tracker
  }

  /**
   * Run a full meta-analysis across all available data sources.
   *
   * @returns MetaAnalysis with discovered meta-rules and system health
   */
  analyze(): MetaAnalysis {
    const metaRules: MetaRule[] = []

    // Phase 1: Threshold tuning recommendations
    metaRules.push(...this.analyzeThresholds())

    // Phase 2: Strategy effectiveness per category
    metaRules.push(...this.analyzeStrategies())

    // Phase 3: Cross-rule pattern discovery
    metaRules.push(...this.discoverCrossRulePatterns())

    // Phase 4: Emergent category detection
    metaRules.push(...this.detectEmergentCategories())

    // Sort by confidence (high → medium → low), then by category severity
    metaRules.sort((a, b) => {
      const confOrder = { high: 0, medium: 1, low: 2 }
      const confDiff = confOrder[a.confidence] - confOrder[b.confidence]
      if (confDiff !== 0) return confDiff
      return b.evidence.sampleSize - a.evidence.sampleSize
    })

    const systemHealth = this.computeSystemHealth(metaRules)

    return {
      metaRules,
      systemHealth,
      analyzedAt: new Date().toISOString(),
    }
  }

  // ── Phase 1: Threshold Tuning ──

  /**
   * Analyze whether current thresholds (AUTO_RETRY_THRESHOLD, ZERO_SUCCESS_THRESHOLD,
   * SIMILARITY_THRESHOLD) are optimal based on observed outcomes.
   */
  private analyzeThresholds(): MetaRule[] {
    const rules: MetaRule[] = []
    const sigs = this.errorDB?.getActive() || []
    if (sigs.length < MIN_SAMPLE_SIZE) return rules

    // Check if many signatures plateau just below AUTO_RETRY_THRESHOLD (0.7)
    const nearThreshold = sigs.filter(
      (s) => s.successRate >= 0.5 && s.successRate < 0.7 && s.occurrences >= 5,
    )

    if (nearThreshold.length >= 3) {
      const avgRate =
        nearThreshold.reduce((sum, s) => sum + s.successRate, 0) / nearThreshold.length
      rules.push({
        id: `meta-threshold-retry-${Date.now().toString(36)}`,
        category: 'threshold-tuning',
        title: '降低自动重试阈值建议',
        description: `${nearThreshold.length} 个错误签名成功率在 50%-70% 之间（平均 ${Math.round(avgRate * 100)}%），但不足以触发自动重试。如果阈值从 70% 降到 60%，可自动修复其中 ${Math.round(nearThreshold.filter((s) => s.successRate >= 0.6).length)} 个签名。`,
        recommendation: `考虑将 AUTO_RETRY_THRESHOLD 从 0.7 降至 0.6，或对特定类别（如 timeout）使用差异化阈值`,
        autoApplicable: false, // threshold changes need human review
        evidence: {
          sampleSize: nearThreshold.length,
          metrics: {
            avgSuccessRate: Math.round(avgRate * 100) / 100,
            belowThreshold: nearThreshold.length,
            totalSignatures: sigs.length,
          },
          relatedIds: nearThreshold.map((s) => s.id),
          summary: `${nearThreshold.length}/${sigs.length} 签名接近但未达到自动重试阈值`,
        },
        confidence: nearThreshold.length >= 5 ? 'high' : 'medium',
        generatedAt: new Date().toISOString(),
      })
    }

    // Check if ZERO_SUCCESS_THRESHOLD (10) is appropriate
    const zeroSuccess = sigs.filter((s) => s.successCount === 0 && s.occurrences >= 3)
    if (zeroSuccess.length >= 5) {
      rules.push({
        id: `meta-threshold-zero-${Date.now().toString(36)}`,
        category: 'threshold-tuning',
        title: '加速零成功率签名淘汰',
        description: `${zeroSuccess.length} 个签名成功率始终为 0，其中 ${zeroSuccess.filter((s) => s.occurrences >= 5).length} 个已发生 ≥5 次。当前零成功淘汰阈值是 10 次，可考虑降至 5-7 次以加速清理无效签名。`,
        recommendation: '将 ZERO_SUCCESS_THRESHOLD 从 10 降至 7，加速淘汰无效签名',
        autoApplicable: false,
        evidence: {
          sampleSize: zeroSuccess.length,
          metrics: {
            zeroSuccessCount: zeroSuccess.length,
            avgOccurrences:
              Math.round(
                (zeroSuccess.reduce((sum, s) => sum + s.occurrences, 0) / zeroSuccess.length) * 10,
              ) / 10,
            wouldRetireAt7: zeroSuccess.filter((s) => s.occurrences >= 7).length,
          },
          relatedIds: zeroSuccess.map((s) => s.id),
          summary: `${zeroSuccess.length} 签名零成功率，可加速淘汰`,
        },
        confidence: zeroSuccess.length >= 8 ? 'high' : 'medium',
        generatedAt: new Date().toISOString(),
      })
    }

    return rules
  }

  // ── Phase 2: Strategy Optimization ──

  /**
   * Analyze which fixStrategy works best for each error category.
   * e.g., "replace outperforms warn for timeout errors"
   */
  private analyzeStrategies(): MetaRule[] {
    const rules: MetaRule[] = []
    const sigs = this.errorDB?.getActive() || []
    if (sigs.length < MIN_SAMPLE_SIZE) return rules

    // Group by category + fixStrategy
    const byCatStrategy = new Map<string, { successRates: number[]; occurrences: number[]; ids: string[] }>()

    for (const sig of sigs) {
      if (sig.occurrences < 3) continue // too new to evaluate
      const key = `${sig.category}:${sig.fixStrategy}`
      const entry = byCatStrategy.get(key) || { successRates: [], occurrences: [], ids: [] }
      entry.successRates.push(sig.successRate)
      entry.occurrences.push(sig.occurrences)
      entry.ids.push(sig.id)
      byCatStrategy.set(key, entry)
    }

    // For each category, compare strategies
    const categories = new Set(sigs.map((s) => s.category))
    for (const cat of categories) {
      const strategies = new Map<
        string,
        { avgRate: number; count: number; totalOcc: number; ids: string[] }
      >()

      for (const [key, data] of byCatStrategy) {
        if (!key.startsWith(cat + ':')) continue
        const strategy = key.split(':')[1]!
        if (!strategy) continue
        const avgRate = data.successRates.reduce((a, b) => a + b, 0) / data.successRates.length
        const totalOcc = data.occurrences.reduce((a, b) => a + b, 0)
        strategies.set(strategy, {
          avgRate,
          count: data.successRates.length,
          totalOcc,
          ids: data.ids,
        })
      }

      if (strategies.size < 2) continue

      // Find best and worst strategy for this category
      const sorted = [...strategies.entries()].sort((a, b) => b[1].avgRate - a[1].avgRate)
      const best = sorted[0]!
      const worst = sorted[sorted.length - 1]!
      if (!best || !worst) continue

      if (best[1].avgRate - worst[1].avgRate > 0.2 && best[1].count >= 2) {
        rules.push({
          id: `meta-strategy-${cat}-${Date.now().toString(36)}`,
          category: 'strategy-optimization',
          title: `${cat} 类别最优策略: ${best[0]}`,
          description: `在 ${cat} 类别中，\`${best[0]}\` 策略平均成功率 ${Math.round(best[1].avgRate * 100)}%（${best[1].count} 个签名），\`${worst[0]}\` 仅 ${Math.round(worst[1].avgRate * 100)}%（${worst[1].count} 个签名），差距 ${Math.round((best[1].avgRate - worst[1].avgRate) * 100)} 个百分点。`,
          recommendation: `将 ${cat} 类别的新签名默认策略设为 \`${best[0]}\`，并考虑将现有 \`${worst[0]}\` 策略签名迁移为 \`${best[0]}\``,
          autoApplicable: best[1].avgRate > 0.85 && best[1].count >= 5,
          evidence: {
            sampleSize: best[1].count + worst[1].count,
            metrics: {
              bestStrategyAvg: Math.round(best[1].avgRate * 100) / 100,
              worstStrategyAvg: Math.round(worst[1].avgRate * 100) / 100,
              gap: Math.round((best[1].avgRate - worst[1].avgRate) * 100) / 100,
              bestCount: best[1].count,
              worstCount: worst[1].count,
            },
            relatedIds: [...best[1].ids, ...worst[1].ids],
            summary: `${best[0]} 比 ${worst[0]} 高 ${Math.round((best[1].avgRate - worst[1].avgRate) * 100)}%`,
          },
          confidence: best[1].count >= 5 ? 'high' : 'medium',
          generatedAt: new Date().toISOString(),
        })
      }
    }

    return rules
  }

  // ── Phase 3: Cross-Rule Pattern Discovery ──

  /**
   * Discover patterns that span multiple unrelated rules.
   * e.g., "all rules targeting Bash with high success share the pattern
   *        of increasing timeout or adding --no-* flags"
   */
  private discoverCrossRulePatterns(): MetaRule[] {
    const rules: MetaRule[] = []
    const sigs = this.errorDB?.getActive() || []
    if (sigs.length < 8) return rules

    // Pattern 1: Check if high-success signatures cluster by tool
    const highSuccess = sigs.filter((s) => s.successRate >= 0.8 && s.occurrences >= 5)
    const byTool = new Map<string, ErrorSignature[]>()
    for (const s of highSuccess) {
      const list = byTool.get(s.toolName) || []
      list.push(s)
      byTool.set(s.toolName, list)
    }

    // If one tool dominates high-success signatures
    const toolEntries = [...byTool.entries()].sort((a, b) => b[1].length - a[1].length)
    const dominant = toolEntries[0]
    const runnerUp = toolEntries[1]
    if (dominant && runnerUp && toolEntries.length >= 2 && dominant[1].length > runnerUp[1].length * 2) {
      rules.push({
        id: `meta-cross-tool-${Date.now().toString(36)}`,
        category: 'cross-rule-pattern',
        title: `${dominant[0]} 工具规则最成熟`,
        description: `${dominant[0]} 工具有 ${dominant[1].length} 个高成功率签名（≥80%），远超第二名 ${runnerUp[0]}（${runnerUp[1].length} 个）。SIS 对 ${dominant[0]} 类错误的免疫力最强。`,
        recommendation: `优先在其他工具（${toolEntries.slice(1).map((e) => e[0]).join(', ')}）上扩展签名覆盖，追赶 ${dominant[0]} 的成熟度`,
        autoApplicable: false,
        evidence: {
          sampleSize: highSuccess.length,
          metrics: {
            dominantCount: dominant[1].length,
            runnerUpCount: runnerUp[1].length,
            totalHighSuccess: highSuccess.length,
          },
          relatedIds: dominant[1].map((s) => s.id),
          summary: `${dominant[0]} 领先 ${runnerUp[1].length}→${dominant[1].length}`,
        },
        confidence: dominant[1].length >= 10 ? 'high' : 'medium',
        generatedAt: new Date().toISOString(),
      })
    }

    // Pattern 2: Detect fix action patterns (common substrings in fix actions)
    const fixActions = sigs.filter((s) => s.fixAction && s.fixAction.length > 0)
    if (fixActions.length >= 5) {
      const commonPrefixes = new Map<string, number>()
      for (const s of fixActions) {
        const words = s.fixAction.split(/\s+/)
        if (words.length >= 2) {
          const bigram = words.slice(0, 2).join(' ')
          commonPrefixes.set(bigram, (commonPrefixes.get(bigram) || 0) + 1)
        }
      }

      const topBigrams = [...commonPrefixes.entries()]
        .filter(([, count]) => count >= 3)
        .sort((a, b) => b[1] - a[1])

      for (const [bigram, count] of topBigrams.slice(0, 3)) {
        rules.push({
          id: `meta-cross-bigram-${Date.now().toString(36)}`,
          category: 'cross-rule-pattern',
          title: `修复模式复用: "${bigram}..."`,
          description: `${count} 个签名使用以 "${bigram}" 开头的修复动作。这是高频修复模式，可能值得提升为内置规则模板。`,
          recommendation: `为 "${bigram}" 模式创建快速修复模板，加速新签名创建`,
          autoApplicable: false,
          evidence: {
            sampleSize: count,
            metrics: { count, totalFixActions: fixActions.length },
            relatedIds: fixActions
              .filter((s) => s.fixAction.startsWith(bigram))
              .map((s) => s.id),
            summary: `${count}/${fixActions.length} 修复动作以 "${bigram}" 开头`,
          },
          confidence: count >= 5 ? 'high' : 'low',
          generatedAt: new Date().toISOString(),
        })
      }
    }

    return rules
  }

  // ── Phase 4: Emergent Category Detection ──

  /**
   * Detect error categories that don't fit the predefined set.
   * e.g., if many errors contain "rate limit" or "quota exceeded",
   * we may need a new 'rate-limit' category.
   */
  private detectEmergentCategories(): MetaRule[] {
    const rules: MetaRule[] = []
    const sigs = this.errorDB?.getActive() || []
    if (sigs.length < 10) return rules

    // Known categories
    const knownCats = new Set(['timeout', 'tool-params', 'import', 'search', 'semantic'])

    // Look for signature clusters that don't clearly fit known categories
    // by analyzing pattern keywords
    const keywords = new Map<string, { count: number; sigs: ErrorSignature[] }>()

    const candidateKeywords = [
      'rate limit',
      'quota',
      'network',
      'connection',
      'auth',
      'token',
      'memory',
      'disk',
      'parse',
      'syntax',
      'version',
      'conflict',
    ]

    for (const sig of sigs) {
      const pattern = sig.pattern.toLowerCase()
      for (const kw of candidateKeywords) {
        if (pattern.includes(kw)) {
          const entry = keywords.get(kw) || { count: 0, sigs: [] }
          entry.count++
          entry.sigs.push(sig)
          keywords.set(kw, entry)
        }
      }
    }

    for (const [kw, data] of keywords) {
      if (data.count >= 3) {
        // Check if these signatures' current categories are mostly 'semantic'
        // (meaning the system couldn't classify them well)
        const semanticRatio =
          data.sigs.filter((s) => s.category === 'semantic').length / data.count

        rules.push({
          id: `meta-emergent-${kw.replace(/\s+/g, '-')}-${Date.now().toString(36)}`,
          category: 'category-emergence',
          title: `新错误类别候选: "${kw}"`,
          description: `${data.count} 个签名包含关键词 "${kw}"，其中 ${Math.round(semanticRatio * 100)}% 被归类为 'semantic'（无法精细分类）。这可能是一个值得独立追踪的新错误类别。`,
          recommendation:
            semanticRatio > 0.5
              ? `创建新类别 \`${kw.replace(/\s+/g, '-')}\`，将 ${data.count} 个签名重新分类`
              : `监控 "${kw}" 相关签名增长趋势，若持续增长则创建独立类别`,
          autoApplicable: false,
          evidence: {
            sampleSize: data.count,
            metrics: {
              count: data.count,
              semanticRatio: Math.round(semanticRatio * 100) / 100,
              avgSuccessRate:
                Math.round(
                  (data.sigs.reduce((sum, s) => sum + s.successRate, 0) / data.count) * 100,
                ) / 100,
            },
            relatedIds: data.sigs.map((s) => s.id),
            summary: `${data.count} 签名匹配 "${kw}"，${Math.round(semanticRatio * 100)}% 为 semantic`,
          },
          confidence: data.count >= 5 ? 'high' : data.count >= 4 ? 'medium' : 'low',
          generatedAt: new Date().toISOString(),
        })
      }
    }

    return rules
  }

  // ── System Health Computation ──

  /**
   * Compute overall CRSI system health from meta-analysis results.
   */
  private computeSystemHealth(metaRules: MetaRule[]): SystemHealth {
    const sigs = this.errorDB?.getActive() || []
    const stats = this.errorDB?.getStats() || { total: 0, active: 0, avgSuccessRate: 0 }

    // ── Error Signatures health ──
    let errorSignaturesScore = 50 // baseline
    if (sigs.length > 0) {
      const coverageBonus = Math.min(sigs.length * 2, 30) // up to 30 for volume
      const successBonus = Math.round(stats.avgSuccessRate * 20) // up to 20 for quality
      errorSignaturesScore = Math.min(50 + coverageBonus + successBonus, 100)
    }

    // ── Preflight Prevention health ──
    const warnBlockSigs = sigs.filter(
      (s) => s.fixStrategy === 'warn' || s.fixStrategy === 'block',
    ).length
    const fixSigs = sigs.filter(
      (s) => s.fixStrategy === 'replace' || s.fixStrategy === 'prepend' || s.fixStrategy === 'append',
    ).length
    let preflightScore = 50
    if (sigs.length > 0) {
      const fixRatio = fixSigs / sigs.length
      preflightScore = Math.min(50 + Math.round(fixRatio * 50), 100)
    }

    // ── Auto Correction health ──
    const highConfSigs = sigs.filter((s) => s.successRate >= 0.7).length
    let autoCorrectionScore = 50
    if (sigs.length > 0) {
      autoCorrectionScore = Math.min(50 + Math.round((highConfSigs / sigs.length) * 50), 100)
    }

    // ── Immune Memory health ──
    let immuneScore = 50
    if (stats.total > 0) {
      const activeRatio = stats.active / stats.total
      immuneScore = Math.min(50 + Math.round(activeRatio * 50), 100)
    }

    // ── Rule Effectiveness health (from tracker) ──
    let ruleEffectivenessScore = 50 // default if no tracker
    if (this.tracker) {
      const allEff = this.tracker.allRules
      if (allEff.length > 0) {
        const avgSuccess =
          allEff.reduce((sum, e) => {
            const rate =
              e.appliedCount > 0 ? e.successAfterCount / e.appliedCount : 0
            return sum + rate
          }, 0) / allEff.length
        ruleEffectivenessScore = Math.min(50 + Math.round(avgSuccess * 50), 100)
      }
    }

    // ── Composite Score ──
    const score = Math.round(
      errorSignaturesScore * 0.25 +
        preflightScore * 0.2 +
        autoCorrectionScore * 0.25 +
        immuneScore * 0.15 +
        ruleEffectivenessScore * 0.15,
    )

    // ── Assessment ──
    let assessment: string
    if (score >= 80) assessment = '🟢 SIS 免疫系统运行良好。错误覆盖率、自动修复率均处于健康水平。'
    else if (score >= 60)
      assessment = '🟡 SIS 免疫系统基本正常。部分组件需要关注，建议按下方推荐优化。'
    else if (score >= 40)
      assessment = '🟠 SIS 免疫系统有待加强。错误签名覆盖不足或自动修复率偏低。'
    else assessment = '🔴 SIS 免疫系统薄弱。需要大量积累错误签名并提升修复成功率。'

    // ── Recommendations ──
    const recommendations: string[] = []
    if (errorSignaturesScore < 60) recommendations.push('增加错误签名积累：让系统经历更多错误场景')
    if (preflightScore < 60) recommendations.push('提升预防能力：将更多 warn 策略升级为 fix 策略')
    if (autoCorrectionScore < 60)
      recommendations.push('提升自动修复率：验证并提升现有签名的成功率至 70%+')
    if (immuneScore < 60) recommendations.push('清理免疫记忆：运行 /sis cleanup 移除过期和无效签名')
    if (ruleEffectivenessScore < 60)
      recommendations.push('提升规则有效性：检查 EffectivenessTracker 中低效规则')

    // Add meta-rule driven recommendations
    const highConfMeta = metaRules.filter((m) => m.confidence === 'high')
    if (highConfMeta.length > 0) {
      recommendations.push(`发现 ${highConfMeta.length} 个高置信度元规则，建议审查后应用`)
    }

    const autoApplicable = metaRules.filter((m) => m.autoApplicable)
    if (autoApplicable.length > 0) {
      recommendations.push(`${autoApplicable.length} 个元规则可自动应用，执行 /crsi meta --apply`)
    }

    if (recommendations.length === 0) {
      recommendations.push('系统运行良好，无需立即行动。持续监控即可。')
    }

    return {
      score,
      components: {
        errorSignatures: errorSignaturesScore,
        preflightPrevention: preflightScore,
        autoCorrection: autoCorrectionScore,
        immuneMemory: immuneScore,
        ruleEffectiveness: ruleEffectivenessScore,
      },
      assessment,
      recommendations,
    }
  }

  /**
   * Get a summary of auto-applicable meta-rules for safe auto-application.
   */
  getAutoApplicable(metaRules: MetaRule[]): MetaRule[] {
    return metaRules.filter((m) => m.autoApplicable && m.confidence === 'high')
  }
}
