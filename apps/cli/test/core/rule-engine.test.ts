import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { ExperienceRuleEngine } from '../../src/core/rule-engine.js'
import type { ToolRule } from '../../src/core/rule-engine.js'

// Isolate the rule-engine store from the real ~/.mipham — register()/setRuleEnabled()
// persist to disk, so tests must not pollute the user's live rules.json.
const TEST_DIR = join(tmpdir(), 'mipham-test-rule-engine')

describe('ExperienceRuleEngine', () => {
  it('intercept returns unmodified params when no rules match', () => {
    const engine = new ExperienceRuleEngine(TEST_DIR)
    const result = engine.intercept('Read', { file_path: '/tmp/test.txt' })
    expect(result.modified).toEqual({ file_path: '/tmp/test.txt' })
    expect(result.warnings).toEqual([])
  })

  it('builtin timeout rule matches npm install with low timeout', () => {
    const engine = new ExperienceRuleEngine(TEST_DIR)
    const result = engine.intercept('Bash', {
      command: 'npm install express',
      timeout: 120000,
      description: 'install deps',
    })
    expect(result.modified.timeout).toBe(300000)
    expect(result.warnings.length).toBe(1)
    expect(result.warnings[0]).toContain('timeout')
    expect(result.warnings[0]).toContain('300000')
  })

  it('builtin timeout rule also matches docker build', () => {
    const engine = new ExperienceRuleEngine(TEST_DIR)
    const result = engine.intercept('Bash', {
      command: 'docker build -t app .',
      description: 'build image',
    })
    expect(result.modified.timeout).toBe(300000)
    expect(result.warnings.length).toBe(1)
  })

  it('builtin timeout rule does not modify already-high timeout', () => {
    const engine = new ExperienceRuleEngine(TEST_DIR)
    const result = engine.intercept('Bash', {
      command: 'npm install express',
      timeout: 600000,
      description: 'install deps',
    })
    expect(result.modified.timeout).toBe(600000)
    expect(result.warnings).toEqual([])
  })

  it('builtin timeout rule does not match non-heavy commands', () => {
    const engine = new ExperienceRuleEngine(TEST_DIR)
    const result = engine.intercept('Bash', {
      command: 'echo hello',
      description: 'simple echo',
    })
    expect(result.modified.timeout).toBeUndefined()
    expect(result.warnings).toEqual([])
  })

  it('git force protection warns but does not modify params', () => {
    const engine = new ExperienceRuleEngine(TEST_DIR)
    const result = engine.intercept('Bash', {
      command: 'git push --force origin main',
      description: 'force push',
    })
    expect(result.warnings.length).toBe(1)
    expect(result.warnings[0]).toContain('--force')
    // params unchanged — only warning
    expect(result.modified.command).toBe('git push --force origin main')
  })

  it('git force with dangerouslyDisableSandbox is not warned', () => {
    const engine = new ExperienceRuleEngine(TEST_DIR)
    const result = engine.intercept('Bash', {
      command: 'git push --force origin main',
      dangerouslyDisableSandbox: true,
      description: 'force push',
    })
    expect(result.warnings).toEqual([])
  })

  it('custom rules can be registered and take effect', () => {
    const engine = new ExperienceRuleEngine(TEST_DIR)
    const customRule: ToolRule = {
      id: 'rule-test-custom',
      toolName: 'Write',
      category: 'tool-params',
      match: (p) => {
        const path = String(p.file_path ?? '')
        return path.endsWith('.ts') && !path.includes('.js')
      },
      fix: (p) => ({
        modified: { ...p, file_path: String(p.file_path) + '?' },
        warning: 'test warning for .ts file',
      }),
      source: 'manual',
      enabled: true,
    }
    engine.register(customRule)
    const result = engine.intercept('Write', { file_path: '/tmp/test.ts', content: 'x' })
    expect(result.warnings.length).toBe(1)
    expect(result.modified.file_path).toBe('/tmp/test.ts?')
  })

  it('disabled rules are skipped', () => {
    const engine = new ExperienceRuleEngine(TEST_DIR)
    const rule: ToolRule = {
      id: 'rule-disabled-test',
      toolName: 'Read',
      category: 'tool-params',
      match: () => true,
      fix: (p) => ({ modified: p, warning: 'should not appear' }),
      source: 'manual',
      enabled: false,
    }
    engine.register(rule)
    const result = engine.intercept('Read', { file_path: '/tmp/test.txt' })
    expect(result.warnings).toEqual([])
  })

  it('setRuleEnabled toggles rule state', () => {
    const engine = new ExperienceRuleEngine(TEST_DIR)
    const rules = engine.getActiveRules()
    const timeoutRule = rules.find((r) => r.id === 'rule-timeout-bash-heavy')
    expect(timeoutRule).toBeDefined()
    expect(timeoutRule!.enabled).toBe(true)

    engine.setRuleEnabled('rule-timeout-bash-heavy', false)
    const result = engine.intercept('Bash', {
      command: 'npm install express',
      description: 'install',
    })
    expect(result.warnings).toEqual([])

    engine.setRuleEnabled('rule-timeout-bash-heavy', true)
    const result2 = engine.intercept('Bash', {
      command: 'npm install express',
      description: 'install',
    })
    expect(result2.warnings.length).toBe(1)
  })

  it('convertFromExperienceRules converts ExperienceRule[] to ToolRule[]', () => {
    const engine = new ExperienceRuleEngine(TEST_DIR)
    const expRules = [
      {
        id: 'rule-timeout-xyz',
        type: 'mandatory' as const,
        condition: 'heavy CLI commands',
        action: 'set timeout ≥ 300s',
        evidence: { failureCount: 3, lastFailure: '2026-08-07', examples: ['npm install timeout'] },
        category: 'timeout' as const,
        source: 'agent-experience' as const,
        agentName: 'test',
        createdAt: '2026-08-08',
      },
    ]
    const toolRules = engine.convertFromExperienceRules(expRules)
    expect(toolRules.length).toBe(1)
    expect(toolRules[0]!.toolName).toBe('Bash')
    expect(toolRules[0]!.source).toBe('pattern-analyzer')
  })

  it('getActiveRules returns only enabled rules', () => {
    const engine = new ExperienceRuleEngine(TEST_DIR)
    const rules = engine.getActiveRules()
    expect(rules.length).toBeGreaterThan(0)
    expect(rules.every((r) => r.enabled)).toBe(true)
  })

  it('managed rules are source-only — never persisted to disk, still take effect in-memory', () => {
    const engine = new ExperienceRuleEngine(TEST_DIR)
    const managedRule: ToolRule = {
      id: 'managed-timeout-test',
      toolName: 'Bash',
      category: 'timeout',
      match: () => true,
      fix: (p) => ({ modified: p, warning: 'managed rule applied' }),
      source: 'managed',
      enabled: true,
    }
    engine.register(managedRule)

    const rulesJson = readFileSync(join(TEST_DIR, 'rules.json'), 'utf-8')
    expect(rulesJson).not.toContain('managed-timeout-test')

    // 源码规则仍在内存生效（restart 后由 MANAGED_RULES 重新 merge）。
    const result = engine.intercept('Bash', { command: 'x' })
    expect(result.warnings.length).toBeGreaterThan(0)
  })
})
