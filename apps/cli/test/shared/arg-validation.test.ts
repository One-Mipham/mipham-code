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
    for (const flag of ['--version', '-v', '-V', '--help', '-h', '--dump-config', '--safe-mode']) {
      expect(detectUnknownArgument([flag])).toBeNull()
    }
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
