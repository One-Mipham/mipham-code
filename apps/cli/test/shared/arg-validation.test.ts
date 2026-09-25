import { describe, it, expect } from 'vitest'
import {
  detectUnknownArgument,
  firstPositional,
  parsePermissionFlag,
} from '../../src/shared/arg-validation'
import { ALL_MODES } from '../../src/core/permission-config'

describe('detectUnknownArgument — unknown options', () => {
  it('flags a typo of --version as an unknown option', () => {
    const result = detectUnknownArgument(['--cersion'])
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('option')
    expect(result!.arg).toBe('--cersion')
    expect(result!.suggestions).toContain('--version')
  })

  it('flags an unrecognized flag with no close match', () => {
    const result = detectUnknownArgument(['--totally-unknown'])
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('option')
    expect(result!.arg).toBe('--totally-unknown')
    expect(result!.suggestions).toEqual([])
  })

  it('flags an unknown option even after a known flag', () => {
    const result = detectUnknownArgument(['--safe-mode', '--cersion'])
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('option')
    expect(result!.arg).toBe('--cersion')
  })

  it('accepts known top-level flags', () => {
    for (const flag of [
      '--version',
      '-v',
      '-V',
      '--help',
      '-h',
      '--dump-config',
      '--safe-mode',
      '--resume',
      '--permission',
      '--provider',
      '--model',
    ]) {
      expect(detectUnknownArgument([flag])).toBeNull()
    }
  })
})

describe('detectUnknownArgument — value-taking flags', () => {
  // `mipham --resume "my session"`：值本身不是命令。旧扫描会挑出第一个不以 `-` 开头的
  // token，报 `Unknown command: mipham my session` —— 怪罪会话名，且从不提真正写错的
  // 那个参数（`--resume` 当时压根不在 KNOWN_FLAGS 里）。这几条钉住修正后的判据。
  it("does not read a value-flag's value as a command", () => {
    expect(detectUnknownArgument(['--resume', 'my-session'])).toBeNull()
  })

  it('skips exactly one token — a real stray command after the value is still caught', () => {
    // 判别力所在：若实现改成「`-` 之后的 token 一律跳过」，这条会变绿，而它必须红。
    const result = detectUnknownArgument(['--resume', 'my-session', 'bogus'])
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('command')
    expect(result!.arg).toBe('bogus')
  })

  it('a value flag with no value is still a known flag (bin prints usage itself)', () => {
    // 缺值由 bin/mipham.ts 报 `Usage: mipham --resume "<session-name>"`；这里不该
    // 抢先说成 `Unknown option` —— 那会把「忘写值」误导成「flag 不存在」。
    expect(detectUnknownArgument(['--resume'])).toBeNull()
  })

  it('the `--resume=<name>` form is not a known flag (space form only)', () => {
    // 只支持 `--resume <name>` 这一种写法（`--help` 里也只写这一种）。`=` 形式会走到
    // 未知选项那条路：报错**点名**了那个参数，所以 `=` 是问题所在看得出来。
    // 但**没有**建议：`closest` 的阈值是 3 次编辑，而 `--resume=my-session` 与
    // `--resume` 的距离是 11 ⇒ 命中不了。这是如实记下的行为，不是期望的行为。
    const result = detectUnknownArgument(['--resume=my-session'])
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('option')
    expect(result!.arg).toBe('--resume=my-session')
    expect(result!.suggestions).toEqual([])
  })

  it('两个 IDE 插件拼出来的那条命令原样放行（这是实测到的形状）', () => {
    // `infrastructure/vscode/extension.js` 的 buildFlags() 与 `MiphamAction.kt` 的
    // buildCommand() 都拼 `mipham --provider <id> --model <id>`。修之前，这条命令的
    // 回答是 `Unknown command: mipham deepseek`（rc=1，CLI 根本起不来）—— 怪的是
    // provider 的**值**，只因为 `--provider` 当时不在 VALUE_FLAGS 里，值就落进了
    // 位置参数。这条就是那次事故的回归位。
    expect(detectUnknownArgument(['--provider', 'deepseek', '--model', 'deepseek-chat'])).toBeNull()
    // 单给一个也要放行：插件只填了 provider（model 留空）是常态。
    expect(detectUnknownArgument(['--provider', 'deepseek'])).toBeNull()
    expect(detectUnknownArgument(['--model', 'deepseek-chat'])).toBeNull()
  })

  it('两个 flag 的顺序无关，且值后面的真·野命令仍会被抓', () => {
    // 与上面 `--resume` 那条同一个判别力要求：实现若退化成「`-` 之后的都跳过」，
    // 后半条会变绿 —— 而它必须红。
    expect(detectUnknownArgument(['--model', 'x', '--provider', 'y'])).toBeNull()
    const result = detectUnknownArgument(['--provider', 'deepseek', 'bogus'])
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('command')
    expect(result!.arg).toBe('bogus')
  })
})

describe('detectUnknownArgument — unknown commands', () => {
  it('flags an unknown positional command', () => {
    const result = detectUnknownArgument(['foo'])
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('command')
    expect(result!.arg).toBe('foo')
  })

  it('suggests the closest known command for a typo', () => {
    const result = detectUnknownArgument(['updat'])
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('command')
    expect(result!.suggestions).toContain('update')
  })

  it('reports the positional command, not trailing flags', () => {
    const result = detectUnknownArgument(['foo', '--bar'])
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('command')
    expect(result!.arg).toBe('foo')
  })

  it('accepts known commands', () => {
    for (const cmd of ['update', 'daemon', 'attach', 'agent', 'workflow']) {
      expect(detectUnknownArgument([cmd])).toBeNull()
    }
  })
})

describe('firstPositional — attach 的会话 id 也走这条判据', () => {
  // `bin/mipham.ts` 的 attach 分支原先取 `args[1]`，一旦带值 flag 排在前头就会把 flag 的
  // **值**当成会话 id（`mipham attach --permission plan` ⇒ 去找一个叫 `plan` 的会话）。
  it('skips flag values, in either order', () => {
    expect(firstPositional(['--permission', 'plan', 'sess-1'])).toBe('sess-1')
    expect(firstPositional(['sess-1', '--permission', 'plan'])).toBe('sess-1')
    expect(firstPositional(['--safe-mode', 'sess-1'])).toBe('sess-1')
  })

  it('returns null when there is no positional at all', () => {
    expect(firstPositional(['--permission', 'plan'])).toBeNull()
    expect(firstPositional([])).toBeNull()
  })
})

describe('parsePermissionFlag — 取值域恰好就是 ALL_MODES', () => {
  it('accepts every mode ALL_MODES accepts', () => {
    for (const mode of ALL_MODES) {
      expect(parsePermissionFlag(['--permission', mode])).toEqual({ kind: 'ok', mode })
    }
  })

  it('returns absent when the flag is not there', () => {
    expect(parsePermissionFlag([])).toEqual({ kind: 'absent' })
    expect(parsePermissionFlag(['--safe-mode', 'foo'])).toEqual({ kind: 'absent' })
  })

  it('an unknown value is an error, never a fallback to `default`', () => {
    // 这条是本模块存在的理由：`default` 比用户十有八九想说的那一档（`plan` /
    // `acceptEdits`）**更宽**，回退就是一次静默放宽 —— 与 bin 的 `--resume` 拒绝
    // 未知会话名形同。
    const result = parsePermissionFlag(['--permission', 'nonsense'])
    expect(result.kind).toBe('error')
    expect(result).not.toEqual({ kind: 'ok', mode: 'default' })
  })

  it('the error message lists the valid modes, derived from ALL_MODES', () => {
    const result = parsePermissionFlag(['--permission', 'nonsense'])
    expect(result.kind).toBe('error')
    const message = result.kind === 'error' ? result.message : ''
    expect(message).toContain('nonsense')
    expect(message).toContain(ALL_MODES.join(', '))
  })

  it('refuses the legacy spellings setDefaultLevel would have mapped', () => {
    // `setDefaultLevel` 还认 `self`/`ask`/`bypass`。flag 不认：报错信息点名的就是它收的
    // 那几种拼法，而 `bypass` 根本不在 daemon 的 `set_mode` 白名单里 —— 收下它，同一个
    // flag 会本地可用、`mipham attach` 下被静默钳到别处。
    for (const legacy of ['self', 'ask', 'bypass']) {
      expect(parsePermissionFlag(['--permission', legacy]).kind).toBe('error')
    }
  })

  it('is case-sensitive and matches whole tokens', () => {
    for (const near of ['Plan', 'PLAN', 'plan-mode', 'auto ']) {
      expect(parsePermissionFlag(['--permission', near]).kind).toBe('error')
    }
  })

  it('a missing value is a usage error, not `ok` and not an unknown option', () => {
    const result = parsePermissionFlag(['--permission'])
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' ? result.message : '').toContain('Usage')
  })

  it('a flag-shaped value is refused instead of being eaten as a mode', () => {
    // `mipham --permission --safe-mode`：把 `--safe-mode` 当成档名会报「未知模式
    // --safe-mode」，读起来像那个 flag 不存在 —— 而真正的问题是 `--permission` 没拿到值。
    const result = parsePermissionFlag(['--permission', '--safe-mode'])
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' ? result.message : '').toContain('Usage')
  })

  it('the `=` form is refused here, not left to detectUnknownArgument', () => {
    // attach 分支**从不**跑 detectUnknownArgument（它在未知参数扫描之前就返回了），
    // 所以只靠那一处，`mipham attach <id> --permission=plan` 会是唯一的静默无操作路径。
    const result = parsePermissionFlag(['--permission=plan'])
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' ? result.message : '').toContain('--permission=plan')
    expect(result).not.toEqual({ kind: 'ok', mode: 'plan' })
  })

  it('the first occurrence wins (documented, not incidental)', () => {
    expect(parsePermissionFlag(['--permission', 'plan', '--permission', 'auto'])).toEqual({
      kind: 'ok',
      mode: 'plan',
    })
  })
})

describe('detectUnknownArgument — empty input', () => {
  it('returns null when there are no arguments', () => {
    expect(detectUnknownArgument([])).toBeNull()
  })
})
