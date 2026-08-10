/**
 * CRSI Phase 2: Auto-Reflection Engine
 *
 * Structured API for post-turn conversation reflection, CRSI pipeline
 * integration, and persistent memory management. Builds on top of the
 * Phase 1 rule-level self-improvement (PatternAnalyzer, RuleEngine,
 * EffectivenessTracker) to enable code-level and session-level learning.
 *
 * Architecture:
 *   Turn completes → analyzeTurn() → persist() → CRSI pipeline feed
 *   AI does the thinking; this module provides storage + integration.
 */

import { MemoryManager, type MemoryEntry } from './memory/memory-manager.js'
import type { PatternAnalyzer, Pattern } from '../agent/pattern-analyzer.js'
import type { ExperienceRuleEngine, ToolRule } from './rule-engine.js'
import type { EffectivenessTracker } from '../agent/effectiveness-tracker.js'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ── Types ──

export interface ToolCallRecord {
  /** Tool name (Bash, Read, Write, Edit, Agent, etc.) */
  name: string
  /** Tool input parameters */
  input: Record<string, unknown>
  /** Whether the tool executed successfully */
  success: boolean
  /** Error message if the tool failed */
  error?: string
  /** Duration in ms */
  durationMs?: number
}

export interface CrsiInsight {
  /** Category: timeout | tool-params | search | import | semantic */
  category: string
  /** Human-readable description of the insight */
  description: string
  /** Severity: 'info' | 'warning' | 'critical' */
  severity: 'info' | 'warning' | 'critical'
  /** Suggested action (e.g. "增加 Bash timeout 到 300000ms") */
  suggestion: string
  /** Evidence: concrete examples supporting this insight */
  evidence: string[]
  /** Whether this insight can be auto-applied as a CRSI rule */
  autoApplicable: boolean
}

export interface TurnReflection {
  /** Unique ID for this reflection */
  id: string
  /** Session ID */
  sessionId: string
  /** Timestamp */
  timestamp: string
  /** Summary of the turn (1-3 sentences) */
  summary: string
  /** What went well */
  successes: string[]
  /** What failed or could be improved */
  failures: string[]
  /** CRSI-specific insights for rule generation */
  crsiInsights: CrsiInsight[]
  /** Key decisions made during this turn */
  decisions: string[]
  /** Action items for future sessions */
  actionItems: string[]
}

// ── Constants ──

const DEFAULT_MEMORY_DIR = join(homedir(), '.mipham', 'memory')

/** Minimum number of similar failures before a CRSI rule is generated. */
const CRSI_RULE_THRESHOLD = 2

/** How many past reflections to recall for context. */
const MAX_RECALL = 5

// ── Engine ──

export class AutoMemoryEngine {
  private memoryManager: MemoryManager
  private patternAnalyzer?: PatternAnalyzer
  private ruleEngine?: ExperienceRuleEngine
  private effectivenessTracker?: EffectivenessTracker

  /** Accumulated reflections for the current session (not yet persisted to disk). */
  private sessionReflections: TurnReflection[] = []

  constructor(memoryDir: string = DEFAULT_MEMORY_DIR) {
    this.memoryManager = new MemoryManager(memoryDir)
    this.memoryManager.loadAll()
  }

  // ── CRSI Pipeline Wiring ──

  /**
   * Wire the CRSI Phase 1 pipeline into the auto-memory engine.
   * Enables insights → rule generation and effectiveness tracking.
   */
  setCrsiPipeline(
    patternAnalyzer: PatternAnalyzer,
    ruleEngine: ExperienceRuleEngine,
    effectivenessTracker: EffectivenessTracker,
  ): void {
    this.patternAnalyzer = patternAnalyzer
    this.ruleEngine = ruleEngine
    this.effectivenessTracker = effectivenessTracker
  }

  // ── Core API ──

  /**
   * Analyze a completed conversation turn and produce a structured reflection.
   *
   * The AI calls this after each response completes. The engine:
   * 1. Analyzes tool call patterns (successes, failures, timeouts)
   * 2. Cross-references with CRSI pipeline for rule suggestions
   * 3. Produces a TurnReflection ready for persistence
   */
  analyzeTurn(params: {
    sessionId: string
    userMessage: string
    assistantContent: string
    toolCalls: ToolCallRecord[]
    modelProvider: string
    modelId: string
    turnDurationMs: number
  }): TurnReflection {
    const { sessionId, userMessage, assistantContent, toolCalls, modelProvider, modelId } = params

    // 1. Categorize tool calls
    const successes: string[] = []
    const failures: string[] = []
    for (const tc of toolCalls) {
      if (tc.success) {
        successes.push(`${tc.name}: ${this.summarizeToolInput(tc)}`)
      } else {
        failures.push(`${tc.name}: ${tc.error || 'unknown error'} — ${this.summarizeToolInput(tc)}`)
      }
    }

    // 2. Extract CRSI insights from tool failures
    const crsiInsights = this.extractCrsiInsights(toolCalls)

    // 3. Cross-reference with existing CRSI rules
    this.crossReferenceWithRules(crsiInsights)

    // 4. Analyze for decisions and action items
    const decisions = this.extractDecisions(userMessage, assistantContent)
    const actionItems = this.extractActionItems(assistantContent, toolCalls)

    // 5. Build summary
    const summary = this.buildSummary(successes, failures, crsiInsights, decisions)

    const reflection: TurnReflection = {
      id: `reflection-${sessionId}-${Date.now().toString(36)}`,
      sessionId,
      timestamp: new Date().toISOString(),
      summary,
      successes,
      failures,
      crsiInsights,
      decisions,
      actionItems,
    }

    this.sessionReflections.push(reflection)
    return reflection
  }

  /**
   * Persist a turn reflection to the memory store.
   *
   * Writes a structured .md file with frontmatter to ~/.mipham/memory/
   * and updates the MEMORY.md index. CRSI insights that meet the threshold
   * are fed into the rule engine for auto-rule generation.
   */
  persist(reflection: TurnReflection): void {
    const content = this.formatReflectionContent(reflection)
    const relevance = this.extractRelevance(reflection)

    this.memoryManager.write(reflection.id, content, {
      type: 'feedback',
      relevance,
      why: `CRSI Phase 2 自动复盘 — 会话 ${reflection.sessionId}`,
      howToApply: '下次会话开始时回顾此文件，检查是否有可操作的改进项',
    })

    // Feed CRSI insights into the rule engine
    this.feedCrsiPipeline(reflection)
  }

  /**
   * Persist ALL accumulated session reflections at once (e.g. on session end).
   */
  persistAll(): void {
    for (const reflection of this.sessionReflections) {
      this.persist(reflection)
    }

    // Also write a session-level summary
    if (this.sessionReflections.length > 0) {
      this.writeSessionSummary()
    }

    // Flush CRSI state
    if (this.effectivenessTracker) {
      this.effectivenessTracker.persist()
    }
  }

  /**
   * Recall relevant past reflections for a given context.
   */
  recall(context: string, limit: number = MAX_RECALL): MemoryEntry[] {
    return this.memoryManager.recall(context, limit)
  }

  /**
   * Build a system reminder string from past reflections for injection
   * into the next session's system prompt.
   */
  buildReminder(context: string, maxTokens?: number): string {
    return this.memoryManager.buildSystemReminder(context, maxTokens)
  }

  /**
   * Get the session reflection count (useful for stats).
   */
  get sessionReflectionCount(): number {
    return this.sessionReflections.length
  }

  /**
   * Get accumulated CRSI insights across all session reflections.
   */
  get accumulatedInsights(): CrsiInsight[] {
    return this.sessionReflections.flatMap((r) => r.crsiInsights)
  }

  // ── Private: CRSI Integration ──

  /**
   * Extract CRSI insights from tool call records.
   *
   * Identifies patterns like:
   * - timeout: heavy commands without explicit timeout
   * - tool-params: git --force without sandbox disable
   * - import: ESM imports missing .js extension (from Edit/Write errors)
   * - search: full-repo Grep without directory scoping
   */
  private extractCrsiInsights(toolCalls: ToolCallRecord[]): CrsiInsight[] {
    const insights: CrsiInsight[] = []
    const seen = new Set<string>()

    for (const tc of toolCalls) {
      if (tc.success) continue

      const category = this.categorizeFailure(tc)
      const key = `${category}:${tc.name}`
      if (seen.has(key)) continue
      seen.add(key)

      const evidence = this.gatherEvidence(tc, toolCalls)
      const autoApplicable = ['timeout', 'tool-params'].includes(category)

      const insight: CrsiInsight = {
        category,
        description: `${tc.name} 工具调用失败: ${tc.error || 'unknown'}`,
        severity: tc.error?.includes('timeout') ? 'critical' : 'warning',
        suggestion: this.suggestFix(category, tc),
        evidence,
        autoApplicable,
      }

      insights.push(insight)
    }

    return insights
  }

  /**
   * Cross-reference new insights with existing CRSI rules.
   * If a similar rule already exists, mark the insight as already-covered.
   */
  private crossReferenceWithRules(insights: CrsiInsight[]): void {
    if (!this.ruleEngine) return

    const activeRules = this.ruleEngine.getActiveRules()
    for (const insight of insights) {
      const covered = activeRules.some((r) => r.category === insight.category)
      if (covered) {
        insight.description += ' (已有对应 CRSI 规则覆盖)'
        insight.autoApplicable = false // Don't create duplicate rules
      }
    }
  }

  /**
   * Feed CRSI insights into the rule engine for automatic rule generation.
   * Only insights that are auto-applicable and have sufficient evidence
   * (≥ CRSI_RULE_THRESHOLD similar failures) are converted to rules.
   */
  private feedCrsiPipeline(reflection: TurnReflection): void {
    if (!this.ruleEngine || !this.patternAnalyzer) return

    // Count failures by category across ALL reflections (not just this one)
    const categoryCounts = new Map<string, number>()
    for (const r of this.sessionReflections) {
      for (const insight of r.crsiInsights) {
        if (!insight.autoApplicable) continue
        const count = categoryCounts.get(insight.category) || 0
        categoryCounts.set(insight.category, count + 1)
      }
    }

    // Generate rules for categories that meet the threshold
    for (const [category, count] of categoryCounts) {
      if (count < CRSI_RULE_THRESHOLD) continue

      // Use PatternAnalyzer to generate a proper ToolRule
      const pattern: Pattern = {
        id: `auto-${category}-${Date.now().toString(36)}`,
        category: category as Pattern['category'],
        agentName: 'auto-memory',
        frequency: count,
        confidence: count >= 5 ? 'high' : 'medium',
        examples: this.sessionReflections
          .flatMap((r) => r.crsiInsights)
          .filter((i) => i.category === category)
          .flatMap((i) => i.evidence)
          .slice(0, 5),
        firstSeen: this.sessionReflections[0]?.timestamp || '',
        lastSeen: this.sessionReflections[this.sessionReflections.length - 1]?.timestamp || '',
      }

      const toolRule = this.patternAnalyzer.toToolRule(pattern)
      this.ruleEngine.register(toolRule)

      // Track the new rule's effectiveness
      if (this.effectivenessTracker) {
        this.effectivenessTracker.recordApplication(toolRule.id, true)
      }
    }
  }

  // ── Private: Analysis Helpers ──

  private categorizeFailure(tc: ToolCallRecord): string {
    const err = (tc.error || '').toLowerCase()
    const cmd = String(tc.input?.command || tc.input?.description || '').toLowerCase()

    if (err.includes('timeout') || err.includes('timed out')) return 'timeout'
    if (cmd.includes('--force') || cmd.includes('rm -rf')) return 'tool-params'
    if (err.includes('import') || err.includes('module') || err.includes('.js')) return 'import'
    if (tc.name === 'Grep' && err.includes('no matches')) return 'search'
    if (err.includes('permission') || err.includes('denied')) return 'tool-params'

    return 'semantic'
  }

  private gatherEvidence(tc: ToolCallRecord, allCalls: ToolCallRecord[]): string[] {
    const evidence: string[] = []
    evidence.push(`${tc.name}: ${this.summarizeToolInput(tc)}`)

    // Find similar failures in the same batch
    const similar = allCalls.filter(
      (c) => c !== tc && !c.success && this.categorizeFailure(c) === this.categorizeFailure(tc),
    )
    if (similar.length > 0) {
      evidence.push(`同一轮中还有 ${similar.length} 个同类失败`)
    }

    return evidence
  }

  private suggestFix(category: string, tc: ToolCallRecord): string {
    switch (category) {
      case 'timeout':
        return `为 ${tc.name} 增加 timeout 参数至 300000ms（5分钟）`
      case 'tool-params':
        return `检查 ${tc.name} 的参数安全性，考虑添加 dangerouslyDisableSandbox`
      case 'import':
        return '检查 ESM 模块导入是否缺少 .js 扩展名'
      case 'search':
        return '建议先用 Glob 缩小搜索范围，再使用 Grep'
      default:
        return '人工审查此工具调用的参数和上下文'
    }
  }

  private extractDecisions(userMessage: string, assistantContent: string): string[] {
    const decisions: string[] = []
    const decisionPatterns = [
      /决定使用\s*(.+)/g,
      /选择\s*(.+?)(?:作为|方案)/g,
      /采用\s*(.+?)(?:方案|架构|设计)/g,
      /decided?\s*(?:to|on)\s*(.+)/gi,
      /opted\s*(?:for|to)\s*(.+)/gi,
    ]

    for (const pattern of decisionPatterns) {
      let match: RegExpExecArray | null
      while ((match = pattern.exec(assistantContent)) !== null) {
        decisions.push(match[1]!.trim())
      }
    }

    // Also check for explicit decisions in user message
    const userDecisionMatch = userMessage.match(/用\s*(.+?)(?:吧|方案|方法)/)
    if (userDecisionMatch?.[1]) {
      decisions.push(`用户决定: ${userDecisionMatch[1].trim()}`)
    }

    return decisions.slice(0, 5)
  }

  private extractActionItems(assistantContent: string, toolCalls: ToolCallRecord[]): string[] {
    const items: string[] = []

    // Check for TODO markers in assistant content
    const todoMatches = assistantContent.matchAll(/[-*]\s*\[ \]\s*(.+)/g)
    for (const match of todoMatches) {
      items.push(match[1]!.trim())
    }

    // Failed tool calls become action items
    for (const tc of toolCalls) {
      if (!tc.success) {
        items.push(`修复 ${tc.name} 调用失败: ${tc.error || 'unknown'}`)
      }
    }

    return items.slice(0, 8)
  }

  private buildSummary(
    successes: string[],
    failures: string[],
    insights: CrsiInsight[],
    decisions: string[],
  ): string {
    const parts: string[] = []

    if (successes.length > 0) {
      parts.push(`${successes.length} 个工具调用成功`)
    }
    if (failures.length > 0) {
      parts.push(`${failures.length} 个失败`)
    }
    if (insights.length > 0) {
      const criticalCount = insights.filter((i) => i.severity === 'critical').length
      if (criticalCount > 0) {
        parts.push(`${criticalCount} 个关键 CRSI 洞察`)
      } else {
        parts.push(`${insights.length} 个 CRSI 洞察`)
      }
    }
    if (decisions.length > 0) {
      parts.push(`${decisions.length} 个关键决策`)
    }

    return parts.length > 0 ? parts.join('，') : '本轮无特殊事件'
  }

  private summarizeToolInput(tc: ToolCallRecord): string {
    switch (tc.name) {
      case 'Bash':
        return String(tc.input?.command || '').slice(0, 80)
      case 'Read':
        return String(tc.input?.file_path || '').slice(0, 80)
      case 'Write':
        return String(tc.input?.file_path || '').slice(0, 80)
      case 'Edit':
        return `${String(tc.input?.file_path || '').slice(0, 60)}: ${String(tc.input?.old_string || '').slice(0, 20)}...`
      case 'Grep':
        return String(tc.input?.pattern || '').slice(0, 80)
      case 'Agent':
        return String(tc.input?.description || tc.input?.prompt || '').slice(0, 80)
      default:
        return JSON.stringify(tc.input).slice(0, 80)
    }
  }

  // ── Private: Persistence ──

  private formatReflectionContent(reflection: TurnReflection): string {
    const lines: string[] = [
      `# 会话复盘: ${reflection.id}`,
      '',
      `**会话**: ${reflection.sessionId}`,
      `**时间**: ${reflection.timestamp}`,
      `**摘要**: ${reflection.summary}`,
      '',
      '---',
      '',
      '## 成功项',
      '',
      ...(reflection.successes.length > 0
        ? reflection.successes.map((s) => `- ✅ ${s}`)
        : ['- _(本轮无记录的成功项)_']),
      '',
      '## 失败项',
      '',
      ...(reflection.failures.length > 0
        ? reflection.failures.map((f) => `- ❌ ${f}`)
        : ['- _(本轮无失败)_']),
      '',
      '## CRSI 洞察',
      '',
      ...(reflection.crsiInsights.length > 0
        ? reflection.crsiInsights.map(
            (i) =>
              `- 🔧 [${i.severity === 'critical' ? '⚠️' : '📝'} ${i.category}] ${i.description}\n  → 建议: ${i.suggestion}${i.autoApplicable ? ' _(可自动应用)_' : ''}`,
          )
        : ['- _(本轮无 CRSI 洞察)_']),
      '',
      '## 关键决策',
      '',
      ...(reflection.decisions.length > 0
        ? reflection.decisions.map((d) => `- 🎯 ${d}`)
        : ['- _(本轮无关键决策)_']),
      '',
      '## 待办项',
      '',
      ...(reflection.actionItems.length > 0
        ? reflection.actionItems.map((a) => `- [ ] ${a}`)
        : ['- _(本轮无待办项)_']),
      '',
      '---',
      '',
      `_由 CRSI Phase 2 AutoMemoryEngine 自动生成_`,
    ]

    return lines.join('\n')
  }

  private extractRelevance(reflection: TurnReflection): string[] {
    const keywords = new Set<string>()

    // Extract from CRSI insights
    for (const insight of reflection.crsiInsights) {
      keywords.add(insight.category)
    }

    // Extract from decisions
    for (const d of reflection.decisions) {
      const words = d.split(/\s+/).filter((w) => w.length > 2)
      for (const w of words.slice(0, 3)) {
        keywords.add(w.toLowerCase())
      }
    }

    // Always include core tags
    keywords.add('crsi-phase-2')
    keywords.add('turn-reflection')
    keywords.add(reflection.sessionId)

    return Array.from(keywords).slice(0, 10)
  }

  private writeSessionSummary(): void {
    const totalSuccesses = this.sessionReflections.reduce((s, r) => s + r.successes.length, 0)
    const totalFailures = this.sessionReflections.reduce((s, r) => s + r.failures.length, 0)
    const totalInsights = this.sessionReflections.reduce((s, r) => s + r.crsiInsights.length, 0)
    const criticalInsights = this.sessionReflections.flatMap((r) =>
      r.crsiInsights.filter((i) => i.severity === 'critical'),
    )

    const content = [
      `# 会话总结`,
      '',
      `**会话 ID**: ${this.sessionReflections[0]?.sessionId || 'unknown'}`,
      `**复盘数**: ${this.sessionReflections.length}`,
      `**时间**: ${new Date().toISOString()}`,
      '',
      '---',
      '',
      '## 统计',
      '',
      `| 指标 | 数值 |`,
      `|------|------|`,
      `| 成功工具调用 | ${totalSuccesses} |`,
      `| 失败工具调用 | ${totalFailures} |`,
      `| CRSI 洞察 | ${totalInsights} |`,
      `| 关键洞察 | ${criticalInsights.length} |`,
      `| 成功率 | ${totalSuccesses + totalFailures > 0 ? Math.round((totalSuccesses / (totalSuccesses + totalFailures)) * 100) : 100}% |`,
      '',
      ...(criticalInsights.length > 0
        ? [
            '## ⚠️ 关键洞察',
            '',
            ...criticalInsights.map(
              (i) => `- **${i.category}**: ${i.description}\n  → ${i.suggestion}`,
            ),
          ]
        : []),
      '',
      '---',
      '',
      `_由 CRSI Phase 2 AutoMemoryEngine 在会话结束时自动生成_`,
    ].join('\n')

    const name = `session-summary-${this.sessionReflections[0]?.sessionId || Date.now().toString(36)}`
    this.memoryManager.write(name, content, {
      type: 'feedback',
      relevance: ['session-summary', 'crsi-phase-2', ...criticalInsights.map((i) => i.category)],
      why: 'CRSI Phase 2 会话级自动总结',
      howToApply: '在下次会话开始时回顾，重点关注关键洞察和失败模式',
    })
  }
}
