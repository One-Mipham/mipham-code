import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PatternAnalyzer } from '../../src/agent/pattern-analyzer.js'
import { AgentExperience } from '../../src/agent/agent-experience.js'

function setupAgentDir(baseDir: string, agentName: string, failures: string[]): AgentExperience {
  const exp = new AgentExperience(agentName, baseDir)
  for (const f of failures) {
    exp.logFailure(f, `Avoid ${f.slice(0, 30)}`)
  }
  return exp
}

describe('PatternAnalyzer', () => {
  let baseDir: string

  beforeEach(() => {
    baseDir = join(tmpdir(), `crsi-test-${Date.now()}`)
  })

  afterEach(() => {
    if (existsSync(baseDir)) {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it('returns empty array when no experience exists', () => {
    const analyzer = new PatternAnalyzer()
    const patterns = analyzer.analyzeAgent('nonexistent-agent', baseDir)
    expect(patterns).toEqual([])
  })

  it('detects timeout pattern with 3+ failures', () => {
    setupAgentDir(baseDir, 'test-agent', [
      'npm install timeout at 120s',
      'docker build timeout at 120s',
      'pnpm install timeout at default',
    ])
    const analyzer = new PatternAnalyzer()
    const patterns = analyzer.analyzeAgent('test-agent', baseDir)
    const timeoutPattern = patterns.find(p => p.category === 'timeout')
    expect(timeoutPattern).toBeDefined()
    expect(timeoutPattern!.frequency).toBeGreaterThanOrEqual(3)
    expect(timeoutPattern!.confidence).toBe('high')
  })

  it('does not detect pattern with only 2 failures', () => {
    setupAgentDir(baseDir, 'test-agent', [
      'npm install timeout at 120s',
      'npm install timeout at 120s',
    ])
    const analyzer = new PatternAnalyzer()
    const patterns = analyzer.analyzeAgent('test-agent', baseDir)
    // 2 failures → no pattern (only warning rule, not auto-created ToolRule)
    expect(patterns.filter(p => p.frequency >= 3)).toEqual([])
  })

  it('detects import error pattern', () => {
    setupAgentDir(baseDir, 'test-agent', [
      'MODULE_NOT_FOUND for ./foo',
      'MODULE_NOT_FOUND for ./bar',
      'MODULE_NOT_FOUND for ./baz',
    ])
    const analyzer = new PatternAnalyzer()
    const patterns = analyzer.analyzeAgent('test-agent', baseDir)
    const importPattern = patterns.find(p => p.category === 'import')
    expect(importPattern).toBeDefined()
    expect(importPattern!.frequency).toBe(3)
  })

  it('toRule converts pattern to ExperienceRule', () => {
    setupAgentDir(baseDir, 'test-agent', [
      'npm install timeout at 120s',
      'npm install timeout at 120s',
      'npm install timeout at 120s',
    ])
    const analyzer = new PatternAnalyzer()
    const patterns = analyzer.analyzeAgent('test-agent', baseDir)
    const timeoutPattern = patterns.find(p => p.category === 'timeout')
    expect(timeoutPattern).toBeDefined()

    const rule = analyzer.toRule(timeoutPattern!)
    expect(rule.type).toBe('mandatory')
    expect(rule.category).toBe('timeout')
    expect(rule.source).toBe('pattern-analyzer')
    expect(rule.evidence.failureCount).toBeGreaterThanOrEqual(3)
  })

  it('toToolRule converts pattern to ToolRule', () => {
    setupAgentDir(baseDir, 'test-agent', [
      'npm install timeout at 120s',
      'npm install timeout at 120s',
      'npm install timeout at 120s',
    ])
    const analyzer = new PatternAnalyzer()
    const patterns = analyzer.analyzeAgent('test-agent', baseDir)
    const timeoutPattern = patterns.find(p => p.category === 'timeout')
    expect(timeoutPattern).toBeDefined()

    const toolRule = analyzer.toToolRule(timeoutPattern!)
    expect(toolRule.toolName).toBe('Bash')
    expect(toolRule.source).toBe('pattern-analyzer')
    expect(toolRule.enabled).toBe(true)
    expect(typeof toolRule.match).toBe('function')
    expect(typeof toolRule.fix).toBe('function')
  })
})
