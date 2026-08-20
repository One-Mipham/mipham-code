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

  it('matches Read(file_path) pattern', () => {
    expect(
      matchBashRule('Read(**/.ssh/id_rsa)', 'Read', { file_path: '/home/u/.ssh/id_rsa' }),
    ).toBe(true)
    expect(matchBashRule('Read(**/.ssh/id_rsa)', 'Read', { file_path: '/home/u/app.ts' })).toBe(
      false,
    )
  })

  it('matches Grep(path) pattern', () => {
    expect(
      matchBashRule('Grep(**/node_modules)', 'Grep', { pattern: 'x', path: '/proj/node_modules' }),
    ).toBe(true)
    expect(
      matchBashRule('Grep(**/node_modules)', 'Grep', { pattern: 'x', path: '/proj/src' }),
    ).toBe(false)
  })

  it('matches Glob(path) pattern', () => {
    expect(matchBashRule('Glob(**/.ssh)', 'Glob', { pattern: '**', path: '/home/u/.ssh' })).toBe(
      true,
    )
    expect(matchBashRule('Glob(**/.ssh)', 'Glob', { pattern: '**', path: '/home/u/src' })).toBe(
      false,
    )
  })

  it('treats * as a single path segment (does not cross /)', () => {
    expect(matchBashRule('Read(/etc/*)', 'Read', { file_path: '/etc/passwd' })).toBe(true)
    expect(matchBashRule('Read(/etc/*)', 'Read', { file_path: '/etc/nginx/sites/foo' })).toBe(false)
  })

  it('matches Windows drive-letter paths literally (colon not mangled)', () => {
    expect(matchBashRule('Read(C:/Users/*)', 'Read', { file_path: 'C:/Users/alice' })).toBe(true)
    expect(matchBashRule('Read(C:/Users/*)', 'Read', { file_path: 'D:/other' })).toBe(false)
  })
})

describe('compileRule', () => {
  it('compiles pattern to regex', () => {
    const rule = compileRule('Bash(git:*)', 'allow')
    expect(rule.level).toBe('allow')
    expect(rule.compiled.test('Bash(git status)')).toBe(true)
  })
})
