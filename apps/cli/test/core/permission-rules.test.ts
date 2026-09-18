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

describe('matchBashRule — Bash rules recurse into command substitutions', () => {
  it('matches a $() substitution buried in a variable assignment', () => {
    expect(matchBashRule('Bash(rm *)', 'Bash', { command: 'REPORTTIME=$(rm -rf ~)' })).toBe(true)
  })

  it('matches a backtick substitution', () => {
    expect(matchBashRule('Bash(rm *)', 'Bash', { command: 'REPORTTIME=`rm -rf ~`' })).toBe(true)
  })

  it('matches a substitution inside a compound command', () => {
    expect(matchBashRule('Bash(rm *)', 'Bash', { command: 'foo && echo $(rm -rf ~)' })).toBe(true)
  })

  it('does not match when the substitution contains a different command', () => {
    expect(matchBashRule('Bash(rm *)', 'Bash', { command: 'REPORTTIME=$(git status)' })).toBe(false)
  })
})

describe('matchBashRule — Bash rules strip wrapper prefix commands', () => {
  it('matches a Bash(pattern) rule against a wrapped command', () => {
    expect(matchBashRule('Bash(rm *)', 'Bash', { command: 'sudo rm -rf /' })).toBe(true)
    expect(matchBashRule('Bash(rm *)', 'Bash', { command: 'timeout 5 rm -rf /' })).toBe(true)
    expect(matchBashRule('Bash(rm *)', 'Bash', { command: 'env -C /tmp rm -rf /' })).toBe(true)
    expect(matchBashRule('Bash(git:*)', 'Bash', { command: 'sudo git status' })).toBe(true)
  })

  it('matches a wrapped command inside a compound command', () => {
    expect(matchBashRule('Bash(rm *)', 'Bash', { command: 'git status && sudo rm -rf /' })).toBe(
      true,
    )
  })

  it('does not strip a non-wrapper command', () => {
    expect(matchBashRule('Bash(rm *)', 'Bash', { command: 'echo rm -rf /' })).toBe(false)
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

describe('matchBashRule — prefix wrapper commands do not bypass Read/Write/Edit rules', () => {
  it('matches a reader command wrapped by sudo/env/timeout/nohup/command/eval/nice/xargs', () => {
    for (const cmd of [
      'sudo cat .git-credentials',
      'env cat .git-credentials',
      'timeout 5 cat .git-credentials',
      'nohup cat .git-credentials',
      'command cat .git-credentials',
      'eval cat .git-credentials',
      'nice cat .git-credentials',
      'xargs cat .git-credentials',
    ]) {
      expect(matchBashRule('Read(.git-credentials)', 'Bash', { command: cmd })).toBe(true)
    }
  })

  it('matches a writer command wrapped by a prefix command', () => {
    expect(matchBashRule('Edit(.npmrc)', 'Bash', { command: 'sudo tee .npmrc' })).toBe(true)
    expect(matchBashRule('Edit(.npmrc)', 'Bash', { command: 'timeout 5 sed -i x .npmrc' })).toBe(
      true,
    )
  })

  it('matches through prefix options (env -C, sudo -u, nice -n)', () => {
    expect(
      matchBashRule('Read(.git-credentials)', 'Bash', {
        command: 'env -C /tmp cat .git-credentials',
      }),
    ).toBe(true)
    expect(
      matchBashRule('Read(.git-credentials)', 'Bash', {
        command: 'sudo -u root cat .git-credentials',
      }),
    ).toBe(true)
    expect(
      matchBashRule('Read(.git-credentials)', 'Bash', {
        command: 'nice -n 5 cat .git-credentials',
      }),
    ).toBe(true)
  })

  it('does not treat a reader-named argument of a non-wrapper command as a command', () => {
    expect(
      matchBashRule('Read(.git-credentials)', 'Bash', { command: 'echo cat .git-credentials' }),
    ).toBe(false)
  })
})

describe('extractBashFileAccess — prefix wrapper commands', () => {
  it('extracts the file from a wrapped reader command', () => {
    expect(extractBashFileAccess('sudo cat .git-credentials').read).toContain('.git-credentials')
    expect(extractBashFileAccess('env -C /tmp cat .git-credentials').read).toContain(
      '.git-credentials',
    )
  })

  it('extracts the file from a reader inside a -c payload', () => {
    expect(extractBashFileAccess("bash -c 'cat .git-credentials'").read).toContain(
      '.git-credentials',
    )
    expect(extractBashFileAccess("sudo bash -c 'cat .git-credentials'").read).toContain(
      '.git-credentials',
    )
  })
})

describe('matchBashRule — Read rules cover text/byte readers', () => {
  // A formatter reads its file argument and writes to stdout, so `fmt secret` /
  // `column -t secret` reached the file through the Bash tool while the checker
  // did not recognise the command as a reader — `Read(secret)` let it past.
  // Mipham's scanner already treats every non-flag argument of a known reader as
  // a path, so the missing piece was the command list itself.
  it('matches a Read(path) rule against a formatter that writes to stdout', () => {
    for (const cmd of [
      'fmt .git-credentials',
      'column -t .git-credentials',
      'pr .git-credentials',
      'fold -w 40 .git-credentials',
      'expand .git-credentials',
      'unexpand .git-credentials',
      'rev .git-credentials',
      'look .git-credentials',
      'bat .git-credentials',
    ]) {
      expect(matchBashRule('Read(.git-credentials)', 'Bash', { command: cmd })).toBe(true)
    }
  })

  it('matches a Read(path) rule against a structured/byte reader', () => {
    for (const cmd of [
      'jq . .git-credentials',
      'yq . .git-credentials',
      'base64 .git-credentials',
      'md5sum .git-credentials',
      'sha256sum .git-credentials',
      'shasum .git-credentials',
      'cksum .git-credentials',
      'iconv -f utf-8 .git-credentials',
      'cmp .git-credentials /dev/null',
    ]) {
      expect(matchBashRule('Read(.git-credentials)', 'Bash', { command: cmd })).toBe(true)
    }
  })

  it('finds the file even when it follows an unrecognized option', () => {
    // The upstream bug: an option the checker does not know about sat between
    // the command and the path, and the path was never scanned.
    expect(
      matchBashRule('Read(.git-credentials)', 'Bash', {
        command: 'fmt -w 80 .git-credentials',
      }),
    ).toBe(true)
    expect(
      matchBashRule('Read(.git-credentials)', 'Bash', {
        command: 'column -t -s, .git-credentials',
      }),
    ).toBe(true)
  })

  it('applies the same reader set behind a prefix wrapper', () => {
    expect(
      matchBashRule('Read(.git-credentials)', 'Bash', {
        command: 'sudo fmt .git-credentials',
      }),
    ).toBe(true)
    expect(
      matchBashRule('Read(.git-credentials)', 'Bash', {
        command: 'echo $(jq . .git-credentials)',
      }),
    ).toBe(true)
  })

  it('does not match an unrelated path', () => {
    expect(matchBashRule('Read(.git-credentials)', 'Bash', { command: 'fmt .npmrc' })).toBe(false)
  })

  it('does not treat the new readers as writers', () => {
    expect(extractBashFileAccess('md5sum .git-credentials').write).not.toContain('.git-credentials')
  })
})

describe('matchBashRule — Read/Write/Edit rules see through shell -c payloads', () => {
  // A shell's `-c` argument is itself a complete command line, so it must be
  // re-parsed rather than treated as an opaque operand: otherwise
  // `bash -c 'cat .git-credentials'` slips past a `Read(.git-credentials)` deny
  // rule by adding four characters in front.
  it('matches a Read(path) rule behind every common shell invocation', () => {
    for (const command of [
      "bash -c 'cat .git-credentials'",
      "sh -c 'cat .git-credentials'",
      "zsh -c 'cat .git-credentials'",
      'dash -c "cat .git-credentials"',
      'ksh -c "cat .git-credentials"',
      "bash -lc 'cat .git-credentials'", // merged short-option cluster
      "bash -ic 'cat .git-credentials'",
      "bash -xc 'cat .git-credentials'",
      "bash -o pipefail -c 'cat .git-credentials'", // -o takes a value
      "bash -euo pipefail -c 'cat .git-credentials'",
      "bash --norc -c 'cat .git-credentials'",
      "/bin/bash -c 'cat .git-credentials'", // basename, not the full path
      "env sh -c 'cat .git-credentials'",
      "sudo bash -c 'cat .git-credentials'",
      "sudo -u root sh -c 'cat .git-credentials'",
    ]) {
      expect(matchBashRule('Read(.git-credentials)', 'Bash', { command }), command).toBe(true)
    }
  })

  it('parses a payload that spans several whitespace tokens', () => {
    // The payload is one shell word but several whitespace tokens — taking only
    // the token right after `-c` would yield `'cat`, which is not a reader.
    expect(matchBashRule('Read(b)', 'Bash', { command: "bash -c 'cat a b'" })).toBe(true)
  })

  it('matches through a doubly nested shell', () => {
    expect(
      matchBashRule('Read(.git-credentials)', 'Bash', {
        command: `bash -c 'bash -c "cat .git-credentials"'`,
      }),
    ).toBe(true)
  })

  it('matches an eval payload quoted as a single argument', () => {
    // `eval "cat X"` tokenizes to ['eval', '"cat', 'X"'] — the quotes land on
    // different tokens, so the base degrades to `"cat` and no reader is seen.
    expect(
      matchBashRule('Read(.git-credentials)', 'Bash', { command: 'eval "cat .git-credentials"' }),
    ).toBe(true)
  })

  it('propagates Write/Edit rules into a -c payload', () => {
    expect(matchBashRule('Write(.npmrc)', 'Bash', { command: "bash -c 'rm .npmrc'" })).toBe(true)
    expect(matchBashRule('Edit(.npmrc)', 'Bash', { command: "sh -c 'sed -i s/a/b/ .npmrc'" })).toBe(
      true,
    )
  })

  it('stops at the first operand so a script argument is not a payload', () => {
    // `-c` here belongs to the script, not to a shell: option parsing ended at
    // `script.sh`, so nothing is re-parsed.
    expect(
      matchBashRule('Read(.git-credentials)', 'Bash', {
        command: "bash script.sh -c 'cat .git-credentials'",
      }),
    ).toBe(false)
  })
})

describe('matchBashRule — Bash rules match -c payloads', () => {
  it('matches a Bash(pattern) rule against a payload', () => {
    expect(matchBashRule('Bash(rm *)', 'Bash', { command: "bash -c 'rm -rf /'" })).toBe(true)
    expect(matchBashRule('Bash(git:*)', 'Bash', { command: 'bash -c "git status"' })).toBe(true)
  })

  it('bounds payload recursion', () => {
    const nest = (n: number) => {
      let s = 'rm -rf /'
      for (let i = 0; i < n; i++) s = `bash -c '${s}'`
      return s
    }
    expect(matchBashRule('Bash(rm *)', 'Bash', { command: nest(3) })).toBe(true)
    expect(matchBashRule('Bash(rm *)', 'Bash', { command: nest(20) })).toBe(false)
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

  // Re-parsing a `-c` payload must not turn a quoted string into a command:
  // the payload is only re-parsed when a shell actually runs it, never when it
  // is merely an argument to `echo`.
  it('does not treat a quoted -c string as a command', () => {
    expect(matchBashRule('Read(secret)', 'Bash', { command: `echo "bash -c 'cat secret'"` })).toBe(
      false,
    )
    expect(matchBashRule('Read(secret)', 'Bash', { command: `bash -c 'echo "cat secret"'` })).toBe(
      false,
    )
    expect(matchBashRule('Bash(rm *)', 'Bash', { command: `bash -c 'echo "rm -rf /"'` })).toBe(
      false,
    )
  })

  it('does not extend a Read rule to every argument of a -c payload', () => {
    // Same shape as the 2.1.259→2.1.260 rollback above, one level deeper: the
    // payload's args are `npm`'s, not paths anyone is reading.
    expect(
      matchBashRule('Read(./**/build/**)', 'Bash', { command: "bash -c 'npm run build'" }),
    ).toBe(false)
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

describe('基命令前的 shell 噪声 —— Bash 通配匹配', () => {
  const denyRm = (cmd: string) => matchBashRule('Bash(rm *)', 'Bash', { command: cmd })

  it.each([
    ['裸命令', 'rm -rf x'],
    ['圆括号分组', '( rm -rf x )'],
    ['花括号分组', '{ rm -rf x; }'],
    ['复合命令里的分组', 'echo hi && ( rm -rf x )'],
    ['前导赋值', 'FOO=bar rm -rf x'],
    ['IFS 赋值', 'IFS=x rm -rf x'],
    ['LD_PRELOAD 赋值', 'LD_PRELOAD=x rm -rf x'],
    ['取反', '! rm -rf x'],
    ['time 关键字', 'time -p rm -rf x'],
    ['for 循环体', 'for f in *; do rm -rf x; done'],
  ])('%s：%s 命中 Bash(rm *)', (_label, cmd) => {
    expect(denyRm(cmd)).toBe(true)
  })
})

describe('基命令前的 shell 噪声 —— Read 桥接', () => {
  const denyRead = (cmd: string) => matchBashRule('Read(secret)', 'Bash', { command: cmd })

  it.each([
    ['裸命令', 'cat secret'],
    ['前导赋值', 'FOO=bar cat secret'],
    ['IFS 赋值', 'IFS=x cat secret'],
    ['LD_PRELOAD 赋值', 'LD_PRELOAD=x cat secret'],
    ['取反', '! cat secret'],
    ['time 关键字', 'time -p cat secret'],
  ])('%s：%s 命中 Read(secret)', (_label, cmd) => {
    expect(denyRead(cmd)).toBe(true)
  })
})

describe('timeout 的位置参数只吃 duration', () => {
  it('带 duration：仍能认出真正的命令', () => {
    expect(matchBashRule('Read(secret)', 'Bash', { command: 'timeout 5 cat secret' })).toBe(true)
  })

  it('不带 duration、只有裸 flag：不能把命令当 duration 吃掉', () => {
    expect(
      matchBashRule('Read(secret)', 'Bash', { command: 'timeout --preserve-status cat secret' }),
    ).toBe(true)
  })

  it('duration 带单位后缀', () => {
    expect(matchBashRule('Read(secret)', 'Bash', { command: 'timeout 30s cat secret' })).toBe(true)
  })

  it('防回归：time -p 不把 -p 当取值选项（-p 是 sudo 的取值选项）', () => {
    expect(matchBashRule('Read(secret)', 'Bash', { command: 'time -p cat secret' })).toBe(true)
  })
})
