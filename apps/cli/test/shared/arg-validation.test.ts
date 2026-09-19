import { describe, it, expect } from 'vitest'
import { detectUnknownArgument } from '../../src/shared/arg-validation'

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

describe('detectUnknownArgument — empty input', () => {
  it('returns null when there are no arguments', () => {
    expect(detectUnknownArgument([])).toBeNull()
  })
})
