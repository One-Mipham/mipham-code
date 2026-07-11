import { describe, it, expect } from 'vitest'
import { matchBashRule, wildcardMatch, compileRule } from '../../src/core/permission-rules'

describe('wildcardMatch', () => {
  it('matches exact strings', () => {
    expect(wildcardMatch('git status', 'git status')).toBe(true)
  })

  it('matches wildcard prefix', () => {
    expect(wildcardMatch('git:*', 'git status')).toBe(true)
    expect(wildcardMatch('git:*', 'git diff --cached')).toBe(true)
  })

  it('rejects non-matching wildcard', () => {
    expect(wildcardMatch('git:*', 'npm test')).toBe(false)
  })

  it('matches mid-pattern wildcard', () => {
    expect(wildcardMatch('npm *:*', 'npm test --coverage')).toBe(true)
  })
})

describe('matchBashRule', () => {
  it('matches plain tool name', () => {
    expect(matchBashRule('Bash', 'Bash', { command: 'anything' })).toBe(true)
    expect(matchBashRule('Bash', 'Write', {})).toBe(false)
  })

  it('matches Bash(command) pattern', () => {
    expect(matchBashRule('Bash(git:*)', 'Bash', { command: 'git status' })).toBe(true)
    expect(matchBashRule('Bash(rm *)', 'Bash', { command: 'rm -rf /' })).toBe(true)
  })

  it('matches Write(path) pattern', () => {
    expect(matchBashRule('Write(/etc/*)', 'Write', { file_path: '/etc/passwd' })).toBe(true)
    expect(matchBashRule('Write(/etc/*)', 'Write', { file_path: '/home/user/file' })).toBe(false)
  })

  it('handles missing command gracefully', () => {
    expect(matchBashRule('Bash(git:*)', 'Bash', {})).toBe(false)
  })
})

describe('compileRule', () => {
  it('compiles pattern to regex', () => {
    const rule = compileRule('Bash(git:*)', 'allow')
    expect(rule.level).toBe('allow')
    expect(rule.compiled.test('Bash(git status)')).toBe(true)
  })
})
