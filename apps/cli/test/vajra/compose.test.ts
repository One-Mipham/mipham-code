import { it, expect } from 'vitest'
import { assemble, dumpConfig, loadBundle, loadProfile } from '../../src/vajra/compose'
import type { Bundle, BundleLine, Profile } from '../../src/vajra/compose'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

it('assemble concatenates bundles in order', () => {
  const b1: Bundle = { name: 'b1', lines: [{ id: 't1', kind: 'tool', config: {} }] }
  const b2: Bundle = { name: 'b2', lines: [{ id: 'p1', kind: 'provider', config: {} }] }
  const profile: Profile = { name: 'p', bundles: ['b1', 'b2'] }
  const resolve = (n: string) => (n === 'b1' ? b1 : b2)
  expect(assemble(profile, resolve).map((l) => l.id)).toEqual(['t1', 'p1'])
})

it('dumpConfig prints one line per resolved line', () => {
  const lines: BundleLine[] = [{ id: 't1', kind: 'tool', config: { a: 1 } }]
  expect(dumpConfig(lines)).toContain('t1')
  expect(dumpConfig(lines)).toContain('tool')
})

it('loadBundle parses a yaml bundle file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm3-bundle-'))
  const p = join(dir, 'b.yml')
  writeFileSync(p, 'name: b\nlines:\n  - id: t1\n    kind: tool\n    config: {}\n')
  const b = loadBundle(p)
  expect(b.name).toBe('b')
  expect(b.lines[0]!.id).toBe('t1')
  rmSync(dir, { recursive: true, force: true })
})

it('loadProfile parses a yaml profile file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm3-profile-'))
  const p = join(dir, 'p.yml')
  writeFileSync(p, 'name: p\nbundles:\n  - b1\n  - b2\n')
  const profile = loadProfile(p)
  expect(profile.name).toBe('p')
  expect(profile.bundles).toEqual(['b1', 'b2'])
  rmSync(dir, { recursive: true, force: true })
})

it('patch replaces a line by id', () => {
  const b1: Bundle = { name: 'b1', lines: [{ id: 'ver', kind: 'skill', config: { version: '1.0.0' } }] }
  const profile: Profile = { name: 'p', bundles: ['b1'], patch: { ver: { config: { version: '2.0.0' } } } }
  const lines = assemble(profile, () => b1)
  expect(lines.find((l) => l.id === 'ver')!.config.version).toBe('2.0.0')
})

it('package/version change lives in one bundle line', () => {
  const b: Bundle = { name: 'meta', lines: [{ id: 'package-info', kind: 'provider', config: { version: '1.0.0' } }] }
  b.lines[0]!.config.version = '2.0.0'
  expect(dumpConfig(assemble({ name: 'p', bundles: ['meta'] }, () => b))).toContain('2.0.0')
})
