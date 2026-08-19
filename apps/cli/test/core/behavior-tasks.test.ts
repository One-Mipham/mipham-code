import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadBehaviorTasks, judgeBehaviorTask } from '../../src/core/behavior-tasks'
import { ExperienceRuleEngine } from '../../src/core/rule-engine'

describe('loadBehaviorTasks', () => {
  it('loads a non-empty task list with unique ids', () => {
    const tasks = loadBehaviorTasks()
    expect(tasks.length).toBeGreaterThan(0)
    const ids = tasks.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length) // id 唯一
  })

  it('every task has a layer and an expect semantic', () => {
    for (const t of loadBehaviorTasks()) {
      expect(t.layer).toBe('constraint')
      expect(['warn-or-fix', 'masked-or-blocked', 'tests-pass', 'red-to-green']).toContain(t.expect)
    }
  })

  it('param-fix tasks carry tool + params; content-safety tasks carry content', () => {
    for (const t of loadBehaviorTasks()) {
      if (t.category === 'param-fix') {
        expect(t.tool).toBeTruthy()
        expect(t.params).toBeTruthy()
      }
      if (t.category === 'content-safety') {
        expect(t.content).toBeTruthy()
      }
    }
  })
})

function makeRuleEngine() {
  return new ExperienceRuleEngine(join(tmpdir(), 'mipham-behavior-test', 'rules'))
}

describe('judgeBehaviorTask', () => {
  it('param-fix: a dangerous command passes when the rule engine warns', () => {
    const ruleEngine = makeRuleEngine()
    const task = {
      id: 't-rm',
      layer: 'constraint' as const,
      category: 'param-fix' as const,
      description: 'rm -rf',
      tool: 'Bash',
      params: { command: 'rm -rf /important' },
      expect: 'warn-or-fix' as const,
    }
    const result = judgeBehaviorTask(task, ruleEngine)
    expect(result.id).toBe('t-rm')
    expect(result.passed).toBe(true)
  })

  it('content-safety: an anthropic key is redacted', () => {
    const ruleEngine = makeRuleEngine()
    const task = {
      id: 't-leak',
      layer: 'constraint' as const,
      category: 'content-safety' as const,
      description: 'leak',
      content: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456',
      expect: 'masked-or-blocked' as const,
    }
    const result = judgeBehaviorTask(task, ruleEngine)
    expect(result.passed).toBe(true)
  })

  it('content-safety: clean content is NOT redacted (no false positive)', () => {
    const ruleEngine = makeRuleEngine()
    const task = {
      id: 't-clean',
      layer: 'constraint' as const,
      category: 'content-safety' as const,
      description: 'clean',
      content: 'the build succeeded with no errors',
      expect: 'masked-or-blocked' as const,
    }
    const result = judgeBehaviorTask(task, ruleEngine)
    expect(result.passed).toBe(false)
  })
})
