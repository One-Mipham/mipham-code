import { describe, it, expect } from 'vitest'
import { buildCapabilityReport, type CapabilitySources } from '../../src/core/capability-inventory'
import { InstructionsLoader } from '../../src/core/instructions'

function stubEngine(overrides: Partial<CapabilitySources> = {}): CapabilitySources {
  return {
    getRuleEngine: () => ({
      getActiveRules: () => [
        { source: 'builtin' },
        { source: 'pattern-analyzer' },
        { source: 'manual' },
      ],
    }),
    getPatternAnalyzer: () => ({ analyzeAllAgents: () => [{}, {}] }),
    getAutoMemory: () => ({ accumulatedInsights: [{}, {}, {}] }),
    getMetaRuleEngine: () => ({ analyze: () => ({ metaRules: [{}, {}] }) }),
    getErrorSignatureDB: () => ({
      getStats: () => ({
        total: 3,
        active: 2,
        degraded: 1,
        retired: 0,
        avgSuccessRate: 0.82,
        totalInterceptions: 10,
      }),
    }),
    getConstitutionLoader: () => ({
      load: () => ({
        version: '1.0.0',
        principles: [
          { facet: 'prajna' },
          { facet: 'prajna' },
          { facet: 'prajna' },
          { facet: 'vajra' },
          { facet: 'vajra' },
          { facet: 'vajra' },
          { facet: 'vajra' },
          { facet: 'vajra' },
        ],
        preamble: '愿力（序言）',
      }),
    }),
    getSelfCritique: () => ({ getConfig: () => ({ enabled: false }) }),
    ...overrides,
  }
}

describe('buildCapabilityReport', () => {
  it('reflects persisted CRSI/SIS/constitution state, not a static tool list', () => {
    const report = buildCapabilityReport(stubEngine())

    // 🧠 学习 (CRSI) — 规则/模式/洞察/元规则均来自 getter 返回值
    expect(report).toContain('活跃规则 | 3 (内置 1 · 自动 1 · 手动 1)')
    expect(report).toContain('已检测模式 | 2')
    expect(report).toContain('反思洞察 | 3')
    expect(report).toContain('元规则 | 2')

    // 🛡️ 免疫 (SIS) — 签名计数 + 成功率来自 getStats()
    expect(report).toContain('错误签名 | 3 条')
    expect(report).toContain('平均成功率 | 82%')

    // 🔒 宪法 (对齐) — 8 原则 + facet 映射来自 load()
    expect(report).toContain('原则 | 8 条 (悲 0 · 智 3 · 金刚 5)')
    expect(report).toContain('愿力序言 | 已注入 self-critique')

    // ⚠️ 未接线 — self-critique 状态
    expect(report).toContain('未启用 (opt-in)')
  })

  it('handles uninitialized subsystems gracefully without crashing', () => {
    const report = buildCapabilityReport({})
    expect(report).toContain('能力自报告')
    expect(report).toContain('_未初始化_')
    expect(report).toContain('未启用 (opt-in)')
  })

  it('marks self-critique as enabled when wired', () => {
    const report = buildCapabilityReport(
      stubEngine({ getSelfCritique: () => ({ getConfig: () => ({ enabled: true }) }) }),
    )
    expect(report).toContain('已启用')
  })
})

describe('instructions capability-report rule', () => {
  it('buildSystemPrompt injects the /crsi inventory rule', () => {
    const loader = new InstructionsLoader()
    const prompt = loader.buildSystemPrompt()
    expect(prompt).toContain('/crsi inventory')
  })
})
