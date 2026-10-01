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

// ============================================================
// 口令里含**字面 `@`**。
//
// URL 语法不允许 userinfo 里出现裸 `@`，但 `postgres://user:p@ss@host` 恰恰就是
// 连接串被粘进 shell 的样子 —— 语法错误正是它常见的来源。原 password 组是
// `([^/\s@]+)`，把 `@` 一并排除 ⇒ 组在**第一个** `@` 就停，只遮掉 `p`，尾部
// `ss@host` 整段留在明文里（而遮蔽默认开启，挂点在 bash stdout/stderr、grep 文件
// 内容、config 文本上）。
//
// 判据两头：**整个口令都得走**（用「后缀还在不在」当断言，不是「哨兵出现了没」
// —— 后者在只遮一个字符时同样成立），**主机名必须留下**（否则这条修法把可读性
// 也一起擦掉，就退化成「凡 URL 一律不可读」）。
// ============================================================

describe('默认输出擦洗：口令里含字面 `@`', () => {
  it('`postgres://user:p@ss@host` 的整个口令都擦掉，主机名留着', () => {
    const result = outOf('DATABASE_URL=postgres://appuser:p@ss@db.internal/prod')
    expect(result).not.toContain('p@ss')
    expect(result).not.toContain('ss@') // 旧码只遮到第一个 `@` 前，`ss@db…` 会在这里露出
    expect(result).toContain(CREDENTIAL_SENTINEL)
    expect(result).toContain('db.internal')
    expect(result).toContain('appuser')
  })

  it('逐字边界：遮完是 `user:哨兵@host`，不是 `user:哨兵@ss@host`', () => {
    expect(outOf('postgres://u:p@ss@h.example/x')).toBe(
      `postgres://u:${CREDENTIAL_SENTINEL}@h.example/x`,
    )
  })

  it('反方向：口令里没有 `@` 的仍然只擦口令（改法不许吞主机名）', () => {
    expect(outOf('postgres://u:plainpw@h.example/x')).toBe(
      `postgres://u:${CREDENTIAL_SENTINEL}@h.example/x`,
    )
  })

  it('反方向：`@` 只出现在主机部分的 URL 原样（那不是 userinfo）', () => {
    for (const line of ['https://cdn.example/a@b.png', 'mailto:a@b.com']) {
      expect(outOf(line), `${line} 不该被改`).toBe(line)
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

// ============================================================
// `Authorization: Bearer …`。
//
// 名字类 pattern 认的是 `apiKey` / `secret` / `token` / `…_pat` 这些**键名**，
// 而 `authorization` 不是，`bearer` / `basic` 也不是 —— 于是整条头**一个字符都不匹配**，
// 令牌原样进 stdout。curl 的 `-H`、日志、`git config --list` 都是这个形状。
// ============================================================

describe('默认输出擦洗：Authorization 头', () => {
  // Tokens here are deliberately **not** JWTs and not `sk-`-shaped: both of those
  // are caught by `SecurityGate.redactCredentialLeak` further down the same
  // function, so a test written with one would stay green with this whole rule
  // deleted — it would be measuring the *other* defence. These shapes are redacted
  // by the header rule or by nothing at all.
  const TOKEN = 'abc123def456ghi789jkl'

  it('`Authorization: Bearer <token>` 的令牌擦掉，头名与方案留着', () => {
    const result = outOf(`Authorization: Bearer ${TOKEN}`)
    expect(result).not.toContain(TOKEN)
    expect(result).toContain('Authorization')
    expect(result).toContain('Bearer')
    expect(result).toContain(CREDENTIAL_SENTINEL)
  })

  it('curl 形状 `-H "Authorization: Basic <b64>"` 也擦', () => {
    const result = outOf('-H "Authorization: Basic dXNlcjpwYXNzd29yZA=="')
    expect(result).not.toContain('dXNlcjpwYXNzd29yZA==')
    expect(result).toContain('Basic')
    expect(result).toContain(CREDENTIAL_SENTINEL)
  })

  it('`Proxy-Authorization` 同样算', () => {
    const result = outOf('Proxy-Authorization: token abcdef1234567890')
    expect(result).not.toContain('abcdef1234567890')
    expect(result).toContain('Proxy-Authorization')
  })

  it('裸 `Bearer <token>`（没有头名）也擦', () => {
    const result = outOf(`curl -H "Bearer ${TOKEN}" https://api.example/v1`)
    expect(result).not.toContain(TOKEN)
    expect(result).toContain(CREDENTIAL_SENTINEL)
  })

  it('反方向：`Bearer` / `Basic` 后面是**词**不是令牌 ⇒ 原样', () => {
    for (const line of [
      'Bearer authentication is required',
      'Basic authentication over TLS',
      'bearer tokens are rotated weekly',
    ]) {
      expect(outOf(line), `${line} 不该被改`).toBe(line)
    }
  })
})

// ============================================================
// 键名里插**不可见字符**。
//
// `{"api​Key": "…"}` 人读出来就是 `apiKey`，正则却看不见 —— 名字类的
// pattern 一个字都不匹配，值整段放行。这不是理论：零宽字符插进标识符是现成的
// 规避手法，而遮蔽默认开启。
//
// 修法是**匹配前先剥掉**这些格式字符。ZWJ / ZWNJ 有意保留（emoji 序列与若干
// 文字系统要靠它们），代价是拿这两个拼的键名仍能逃 —— 比剥掉整段正文可接受。
// ============================================================

describe('默认输出擦洗：键名里插不可见字符', () => {
  const ZWSP = String.fromCharCode(0x200b)
  const SOFT_HYPHEN = String.fromCharCode(0xad)

  it('`api\\u200bKey` 仍被认作 apiKey', () => {
    const result = outOf(`{"api${ZWSP}Key": "abc123"}`)
    expect(result).not.toContain('abc123')
    expect(result).toContain(CREDENTIAL_SENTINEL)
  })

  it('归一是实做的：返回值里不再有那个不可见字符', () => {
    expect(outOf(`{"api${ZWSP}Key": "abc123"}`)).not.toContain(ZWSP)
  })

  it('软连字符（U+00AD）同样剥掉', () => {
    const result = outOf(`password${SOFT_HYPHEN}=hunter2`)
    expect(result).not.toContain('hunter2')
    expect(result).toContain(CREDENTIAL_SENTINEL)
  })
})

// ============================================================
// 擦洗之后**仍是合法 JSON**。
//
// 原替换式是 `match.replace(/\s*["']?\s*[:=]\s*["']?\S+/, '=哨兵')` —— 它把
// 分隔符换成 `=` 并**吞掉**值前面的那个引号：`{"apiKey": "sk-…"}` 回来变成
// `{"apiKey=哨兵}`，引号不成对、JSON 解析直接失败。
//
// 要命的是**被擦的正是最可能被交给 `jq` 的那种输出** —— 擦洗把工具的出口
// 打坏，等于擦完还得手工修。判据因此不能只断言「哨兵出现过」（旧码同样成立），
// 必须断言**解析得开**、且解析出来的值就是哨兵。
// ============================================================

describe('默认输出擦洗：擦完仍是合法 JSON', () => {
  it('`{"apiKey": "…"}` 擦完可被 JSON.parse，取值是哨兵', () => {
    const result = outOf('{"apiKey": "sk-live-abcdef123456"}')
    expect(() => JSON.parse(result)).not.toThrow()
    expect(JSON.parse(result)).toEqual({ apiKey: CREDENTIAL_SENTINEL })
  })

  it('嵌套对象：只擦目标键，兄弟键与结构原样', () => {
    const result = outOf('{"a": {"apiKey": "x1y2z3"}, "b": 1}')
    expect(() => JSON.parse(result)).not.toThrow()
    expect(JSON.parse(result)).toEqual({ a: { apiKey: CREDENTIAL_SENTINEL }, b: 1 })
  })

  it('单引号形状也是成对的引号', () => {
    expect(outOf("'apiKey': 'abc123'")).toBe(`'apiKey': '${CREDENTIAL_SENTINEL}'`)
  })

  // 紧凑 JSON **没有空格**，于是 pattern 自带的 `\S+` 一路吃到行尾：第一对的匹配
  // **包含**后面所有的对，`String.replace` 从整段之后接着扫 ⇒ 只擦掉第一对。
  // 这不是假想形状 —— `/config` 打印的就是 `JSON.stringify(config)`，里面好几个
  // `apiKey`。旧码把整个 `\S+` 换成哨兵，把尾巴**毁掉**因而看不出泄漏；一改成保留
  // 形状，毁掉就变成了**泄漏**。判据因此必须落在「第二段也擦了吗」。
  it('紧凑 JSON：每一段都擦，不是只擦第一段', () => {
    const result = outOf('{"apiKey":"sk-a","token":"abc123"}')
    expect(() => JSON.parse(result)).not.toThrow()
    expect(JSON.parse(result)).toEqual({ apiKey: CREDENTIAL_SENTINEL, token: CREDENTIAL_SENTINEL })
  })

  it('`/config` 形状（多个 apiKey）：每个都擦，非秘密键原样', () => {
    const result = outOf(
      '{"providers":[{"id":"a","apiKey":"sk-one"},{"id":"b","apiKey":"sk-two"}]}',
    )
    expect(() => JSON.parse(result)).not.toThrow()
    const parsed = JSON.parse(result)
    expect(parsed.providers.map((p: { apiKey: string }) => p.apiKey)).toEqual([
      CREDENTIAL_SENTINEL,
      CREDENTIAL_SENTINEL,
    ])
    expect(parsed.providers.map((p: { id: string }) => p.id)).toEqual(['a', 'b'])
  })

  it('反方向：非 JSON 的 `KEY=value` 仍保持 `KEY=哨兵`（分隔符不被改写成 `:`）', () => {
    expect(outOf('API_KEY=sk-abc123xyz')).toBe(`API_KEY=${CREDENTIAL_SENTINEL}`)
    expect(outOf('api-key: abc123')).toBe(`api-key: ${CREDENTIAL_SENTINEL}`)
  })

  it('反方向：值里含空格时，引号也得成对（`\\S+` 会把匹配截在值中间）', () => {
    const result = outOf('{"password": "a b"}')
    expect(() => JSON.parse(result)).not.toThrow()
  })
})
