import { describe, it, expect } from 'vitest'
import {
  matchBashRule,
  wildcardMatch,
  compileRule,
  validateRulePattern,
  splitShellSegments,
  extractBashFileAccess,
} from '../../src/core/permission-rules'

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

describe('splitShellSegments', () => {
  it('splits a compound command on &&, ;, |, ||, and newline', () => {
    expect(splitShellSegments('foo && rm -rf /')).toEqual(['foo', 'rm -rf /'])
    expect(splitShellSegments('cd /tmp; rm -rf /')).toEqual(['cd /tmp', 'rm -rf /'])
    expect(splitShellSegments('git status | rm -rf /')).toEqual(['git status', 'rm -rf /'])
    expect(splitShellSegments('npm test || rm -rf /')).toEqual(['npm test', 'rm -rf /'])
    expect(splitShellSegments('a\nb')).toEqual(['a', 'b'])
  })

  it('keeps a single simple command intact', () => {
    expect(splitShellSegments('git status')).toEqual(['git status'])
  })

  it('returns [] for empty/whitespace input', () => {
    expect(splitShellSegments('')).toEqual([])
    expect(splitShellSegments('   ')).toEqual([])
  })
})

describe('extractBashFileAccess', () => {
  it('extracts read paths from reader commands', () => {
    expect(extractBashFileAccess('cat .git-credentials').read).toContain('.git-credentials')
    expect(extractBashFileAccess('tac .git-credentials').read).toContain('.git-credentials')
    expect(extractBashFileAccess('egrep pattern .git-credentials').read).toContain(
      '.git-credentials',
    )
  })

  it('extracts read paths from input redirects', () => {
    expect(extractBashFileAccess('cat < .git-credentials').read).toContain('.git-credentials')
  })

  it('extracts write paths from output redirects', () => {
    expect(extractBashFileAccess('echo x > .npmrc').write).toContain('.npmrc')
    expect(extractBashFileAccess('echo x >> .npmrc').write).toContain('.npmrc')
  })

  it('extracts write paths from in-place editors', () => {
    expect(extractBashFileAccess("sed -i 's/x/y/' .npmrc").write).toContain('.npmrc')
  })

  it('returns no paths for unrelated commands', () => {
    expect(extractBashFileAccess('echo hello')).toEqual({ read: [], write: [] })
    expect(extractBashFileAccess('git status').read).toEqual([])
  })

  it('extracts read paths from command substitution and backticks', () => {
    expect(extractBashFileAccess('echo $(cat .git-credentials)').read).toContain('.git-credentials')
    expect(extractBashFileAccess('echo `cat .git-credentials`').read).toContain('.git-credentials')
  })
})

describe('matchBashRule — Bash rules match compound-command segments', () => {
  it('matches a segment buried in a compound command', () => {
    expect(matchBashRule('Bash(rm *)', 'Bash', { command: 'foo && rm -rf /' })).toBe(true)
    expect(matchBashRule('Bash(rm *)', 'Bash', { command: 'cd /tmp; rm -rf /' })).toBe(true)
    expect(matchBashRule('Bash(rm *)', 'Bash', { command: 'git status | rm -rf /' })).toBe(true)
    expect(matchBashRule('Bash(rm *)', 'Bash', { command: 'npm test || rm -rf /' })).toBe(true)
  })

  it('does not match when no segment matches', () => {
    expect(matchBashRule('Bash(rm *)', 'Bash', { command: 'git status && npm test' })).toBe(false)
  })
})

describe('matchBashRule — Read/Write/Edit rules match Bash file access', () => {
  it('matches a Read(path) rule against a reader command via Bash', () => {
    expect(
      matchBashRule('Read(.git-credentials)', 'Bash', { command: 'cat .git-credentials' }),
    ).toBe(true)
    expect(
      matchBashRule('Read(.git-credentials)', 'Bash', { command: 'tac .git-credentials' }),
    ).toBe(true)
    expect(
      matchBashRule('Read(.git-credentials)', 'Bash', {
        command: 'egrep pattern .git-credentials',
      }),
    ).toBe(true)
  })

  it('matches a Read(path) rule against an input redirect via Bash', () => {
    expect(
      matchBashRule('Read(.git-credentials)', 'Bash', { command: 'cat < .git-credentials' }),
    ).toBe(true)
  })

  it('matches a Write/Edit(path) rule against an output redirect via Bash', () => {
    expect(matchBashRule('Edit(.npmrc)', 'Bash', { command: 'echo x > .npmrc' })).toBe(true)
    expect(matchBashRule('Write(.npmrc)', 'Bash', { command: 'echo x >> .npmrc' })).toBe(true)
  })

  it('matches an Edit(path) rule against an in-place editor via Bash', () => {
    expect(matchBashRule('Edit(.npmrc)', 'Bash', { command: "sed -i 's/x/y/' .npmrc" })).toBe(true)
  })

  it('does not match an unrelated path', () => {
    expect(matchBashRule('Read(.git-credentials)', 'Bash', { command: 'cat .npmrc' })).toBe(false)
    expect(matchBashRule('Read(.git-credentials)', 'Bash', { command: 'echo hello' })).toBe(false)
  })

  it('matches a Read(path) rule against a command substitution via Bash', () => {
    expect(
      matchBashRule('Read(.git-credentials)', 'Bash', { command: 'echo $(cat .git-credentials)' }),
    ).toBe(true)
    expect(
      matchBashRule('Read(.git-credentials)', 'Bash', { command: 'echo `cat .git-credentials`' }),
    ).toBe(true)
  })
})

describe('matchBashRule — conservative scoping avoids upstream false positives', () => {
  // Claude Code 2.1.259 extended Read() deny rules to ALL Bash arguments, then
  // 2.1.260 REVERTED it: it denied `npm run build` under `Read(./**/build/**)`
  // in every mode and made `cd … && grep` prompt even in auto mode. Mipham's
  // version only scans reader/writer commands + redirects, so these do NOT match.
  it('does not match `npm run build` under a Read(./**/build/**) rule', () => {
    expect(matchBashRule('Read(./**/build/**)', 'Bash', { command: 'npm run build' })).toBe(false)
  })

  it('does not match `cd src && grep foo` under a Read(./**/build/**) rule', () => {
    expect(matchBashRule('Read(./**/build/**)', 'Bash', { command: 'cd src && grep foo' })).toBe(
      false,
    )
  })

  it('does not match a git subcommand under a Read rule (git is not a reader/writer)', () => {
    expect(matchBashRule('Read(./**/build/**)', 'Bash', { command: 'git grep foo ./src' })).toBe(
      false,
    )
  })
})

describe('validateRulePattern', () => {
  it('accepts a plain tool name', () => {
    expect(validateRulePattern('Bash')).toBeNull()
    expect(validateRulePattern('Write')).toBeNull()
  })

  it('accepts a well-formed parenthesized rule', () => {
    expect(validateRulePattern('Bash(git:*)')).toBeNull()
    expect(validateRulePattern('Read(**/.ssh/id_rsa)')).toBeNull()
    expect(validateRulePattern('Write(/etc/*)')).toBeNull()
  })

  it('accepts parentheses inside the path', () => {
    expect(validateRulePattern('Read(./dir/(name)/file)')).toBeNull()
  })

  it('flags an empty or whitespace-only pattern', () => {
    expect(validateRulePattern('')).not.toBeNull()
    expect(validateRulePattern('   ')).not.toBeNull()
  })

  it('flags an unclosed parenthesis', () => {
    expect(validateRulePattern('Read(foo')).not.toBeNull()
  })

  it('flags text after the closing parenthesis', () => {
    expect(validateRulePattern('Bash(ls) x')).not.toBeNull()
    expect(validateRulePattern('Read(/a/b) ')).not.toBeNull()
  })

  it('flags an empty parameter', () => {
    expect(validateRulePattern('Bash()')).not.toBeNull()
  })

  it('flags a non-word plain name', () => {
    expect(validateRulePattern('Bash x')).not.toBeNull()
  })
})

describe('compileRule', () => {
  it('compiles pattern to regex', () => {
    const rule = compileRule('Bash(git:*)', 'allow')
    expect(rule.level).toBe('allow')
    expect(rule.compiled.test('Bash(git status)')).toBe(true)
    expect(rule.invalid).toBeUndefined()
  })

  it('marks a malformed pattern invalid', () => {
    const rule = compileRule('Bash(ls) x', 'deny')
    expect(rule.invalid).toBeDefined()
  })
})
