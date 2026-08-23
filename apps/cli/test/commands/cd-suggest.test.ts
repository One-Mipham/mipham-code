import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { suggestDirectories } from '../../src/commands/cd-suggest'

describe('suggestDirectories', () => {
  let base: string

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'cd-suggest-'))
    mkdirSync(join(base, 'src', 'components'), { recursive: true })
    mkdirSync(join(base, 'src', 'config'), { recursive: true })
    mkdirSync(join(base, 'src', 'utils'), { recursive: true })
    writeFileSync(join(base, 'src', 'coffee.md'), '')
  })

  afterAll(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('suggests directories matching a partial path', () => {
    expect(suggestDirectories(join(base, 'src', 'co'))).toEqual([
      join(base, 'src', 'components'),
      join(base, 'src', 'config'),
    ])
  })

  it('excludes files and non-matching directories', () => {
    const got = suggestDirectories(join(base, 'src', 'co'))
    expect(got).not.toContain(join(base, 'src', 'coffee.md'))
    expect(got).not.toContain(join(base, 'src', 'utils'))
  })

  it('returns empty when the target exists', () => {
    expect(suggestDirectories(join(base, 'src'))).toEqual([])
  })

  it('returns empty when nothing matches', () => {
    expect(suggestDirectories(join(base, 'zzz'))).toEqual([])
  })
})
