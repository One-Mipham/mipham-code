import { describe, it, expect } from 'vitest'
import { DEFAULT_CREDENTIAL_MASKING_CONFIG } from '../../src/config/defaults'
import { filterEnv } from '../../src/core/credential-masker/env-filter'
import { maskOutput } from '../../src/core/credential-masker/output-scrub'
import { CREDENTIAL_SENTINEL } from '../../src/core/credential-masker'

// ============================================================
// 这里测的是**出厂默认**（`DEFAULT_CREDENTIAL_MASKING_CONFIG`）本身。
//
// `credential-masker.test.ts` 里的 `makeConfig()` 自带一份**同样的** pattern
// 字面量 —— 它测的是那份副本，改 defaults 它一个字都不会动（「测副本 = 没测」）。
// 默认值是安全控制的实际生效内容，所以它需要自己的判据。
//
// 原默认按**名字后缀**匹配：`(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)$`。
// 于是 `AWS_ACCESS_KEY_ID`（秘密词在中间）、`GH_PAT`、`MYSQL_PWD` 全部原样放行 ——
// 本机实测（filterEnv 直接跑）确认三条都是 pass-through。
//
// 修法是「按**词**匹配，不是按后缀」：`_KEY_` / `KEY$` 算，`MONKEY` 不算。
// 这一条限定不是洁癖 —— 不限定就会掩掉 `SSH_AUTH_SOCK`（Bash 里的 ssh/git 当场
// 连不上 agent）与 `GIT_AUTHOR_NAME`（git commit 的作者变成哨兵）。
// 下半部分的 keep 用例就是钉这两条反方向的。
// ============================================================

const envWith = (names: string[]) =>
  Object.fromEntries(names.map((n) => [n, 'PLAINTEXT-VALUE'])) as Record<string, string>

const isBlocked = (name: string) =>
  filterEnv(envWith([name]), DEFAULT_CREDENTIAL_MASKING_CONFIG)[name] === CREDENTIAL_SENTINEL

describe('默认 env 过滤：按词匹配，不按后缀', () => {
  it('秘密词在名字中间也算（`*_KEY_ID` / `*_KEY_BASE`）', () => {
    expect(isBlocked('AWS_ACCESS_KEY_ID')).toBe(true)
    expect(isBlocked('SECRET_KEY_BASE')).toBe(true)
  })

  it('`GH_PAT` / `MYSQL_PWD` 这类后缀不在原词表里的也算', () => {
    expect(isBlocked('GH_PAT')).toBe(true)
    expect(isBlocked('MYSQL_PWD')).toBe(true)
  })

  it('`HTTP_AUTHORIZATION` 算（原 pattern 只认结尾的 AUTH）', () => {
    expect(isBlocked('HTTP_AUTHORIZATION')).toBe(true)
  })

  it('原本就中招的那几个不能因为改法而漏掉', () => {
    for (const name of [
      'OPENAI_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'NPM_TOKEN',
      'GITHUB_TOKEN',
      'PGPASSWORD',
      'SMTP_AUTH',
      'PROXY_AUTH',
    ]) {
      expect(isBlocked(name), `${name} 应当被掩码`).toBe(true)
    }
  })
})

describe('默认 env 过滤：反方向 —— 不是秘密的一个都不许掩', () => {
  it('`SSH_AUTH_SOCK` / `GIT_AUTHOR_*` 必须原样（按段匹配才做得到）', () => {
    const names = ['SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL']
    const out = filterEnv(envWith(names), DEFAULT_CREDENTIAL_MASKING_CONFIG)
    for (const name of names) {
      expect(out[name], `${name} 不该被掩码`).toBe('PLAINTEXT-VALUE')
    }
  })

  it('`PATH` / `PWD` / 常规变量必须原样', () => {
    const names = ['PATH', 'HOME', 'PWD', 'OLDPWD', 'NODE_ENV', 'LANG', 'TERM', 'GPG_TTY']
    const out = filterEnv(envWith(names), DEFAULT_CREDENTIAL_MASKING_CONFIG)
    for (const name of names) {
      expect(out[name], `${name} 不该被掩码`).toBe('PLAINTEXT-VALUE')
    }
  })

  it('`KEYBOARD_LAYOUT` 不是秘密（子串 KEY 不构成秘密词）', () => {
    expect(isBlocked('KEYBOARD_LAYOUT')).toBe(false)
  })
})

// ============================================================
// 输出擦洗。原 pattern 是 `(api[_-]?key|secret|token|password|credential)\s*[:=]\s*\S+`，
// 实测漏三种形状：① 名字里带 `_key` 的（`AWS_ACCESS_KEY_ID=…`）② JSON 的
// `"apiKey": "…"`（名字与分隔符之间隔着一个引号）③ `DATABASE_URL=postgres://u:p@h/db`
// 这类**值里内嵌**的凭据 —— 名字里根本没有秘密词。
// ============================================================

const outOf = (line: string) => maskOutput(line, DEFAULT_CREDENTIAL_MASKING_CONFIG)

describe('默认输出擦洗：三种漏掉的形状', () => {
  it('`AWS_ACCESS_KEY_ID=<值>` 整条擦掉（原 pattern 只认 api_key 那种拼写）', () => {
    const result = outOf('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE')
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(result).toContain(CREDENTIAL_SENTINEL)
  })

  it('JSON 形状 `{"apiKey": "…"}` 也擦（名字与 `:` 之间可以隔一个引号）', () => {
    const result = outOf('{"apiKey": "abc123"}')
    expect(result).not.toContain('abc123')
    expect(result).toContain(CREDENTIAL_SENTINEL)
  })

  it('URL 内嵌的用户口令擦掉，主机名留着（否则输出没法读）', () => {
    const result = outOf('DATABASE_URL=postgres://appuser:s3cr3t@db.internal/prod')
    expect(result).not.toContain('s3cr3t')
    expect(result).toContain('db.internal')
    expect(result).toContain('appuser')
  })

  it('原本就擦的几种不能因为改法而漏掉', () => {
    for (const line of [
      'API_KEY=sk-abc123xyz',
      'api-key: abc123',
      'password=hunter2',
      'secret=shhh',
      'token: abc123',
    ]) {
      expect(outOf(line), `${line} 应当被擦洗`).toContain(CREDENTIAL_SENTINEL)
    }
  })
})

describe('默认输出擦洗：反方向 —— 普通输出不许被吃掉', () => {
  it('含 `path` / `patch` / `compat` 的普通输出原样（`pat` 不能当子串匹配）', () => {
    for (const line of [
      'path: /usr/bin',
      'patch: applied cleanly',
      'compat: yes',
      'npm ERR! path /Users/x/node_modules',
    ]) {
      expect(outOf(line), `${line} 不该被改`).toBe(line)
    }
  })

  it('`tokens` / `keys` 这类复数不是秘密（名字类不许吞后缀字符）', () => {
    for (const line of ['total tokens: 1234', '"keys": ["a", "b"]']) {
      expect(outOf(line), `${line} 不该被改`).toBe(line)
    }
  })

  it('没有内嵌凭据的 URL 原样（`https://` 不能被当成秘密）', () => {
    for (const line of ['https://github.com/a/b', 'connecting to db: postgres://h/db']) {
      expect(outOf(line), `${line} 不该被改`).toBe(line)
    }
  })
})
