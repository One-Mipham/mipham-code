import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Isolate from the real ~/.mipham — loadSettingsJson reads settings.json there.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-settings-json`,
  }
})

import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadSettingsJson, addSettingsRule, removeSettingsRule } from '../../src/config/loader'

const MIPHAM_HOME = join(homedir(), '.mipham')
const CWD = join(homedir(), 'proj')

describe('loadSettingsJson', () => {
  beforeEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
    mkdirSync(join(CWD, '.mipham'), { recursive: true })
    mkdirSync(MIPHAM_HOME, { recursive: true })
  })

  afterEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
  })

  it('returns empty when no settings.json exists', () => {
    expect(loadSettingsJson(CWD)).toEqual({ hooks: {}, permissions: { allow: [], deny: [] } })
  })

  it('loads project-level hooks', () => {
    writeFileSync(
      join(CWD, '.mipham', 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'block.sh' }] }],
        },
      }),
    )
    const r = loadSettingsJson(CWD)
    expect(r.hooks.PreToolUse).toHaveLength(1)
    expect(r.hooks.PreToolUse![0]!.matcher).toBe('Bash')
  })

  it('merges project + user hooks additively (Claude convention)', () => {
    writeFileSync(
      join(CWD, '.mipham', 'settings.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'p.sh' }] }] },
      }),
    )
    writeFileSync(
      join(MIPHAM_HOME, 'settings.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'u.sh' }] }] },
      }),
    )
    const r = loadSettingsJson(CWD)
    expect(r.hooks.PreToolUse).toHaveLength(2)
  })

  it('loads and dedupes permissions allow/deny across levels', () => {
    writeFileSync(
      join(CWD, '.mipham', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(git:*)'], deny: ['Bash(rm:*)'] } }),
    )
    writeFileSync(
      join(MIPHAM_HOME, 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(git:*)', 'Read(*)'], deny: ['Bash(rm:*)'] } }),
    )
    const r = loadSettingsJson(CWD)
    expect(r.permissions.allow).toEqual(['Bash(git:*)', 'Read(*)'])
    expect(r.permissions.deny).toEqual(['Bash(rm:*)'])
  })

  it('skips corrupt JSON files', () => {
    writeFileSync(join(CWD, '.mipham', 'settings.json'), 'not json')
    const r = loadSettingsJson(CWD)
    expect(r.hooks).toEqual({})
    expect(r.permissions).toEqual({ allow: [], deny: [] })
  })
})

describe('settings rule persistence', () => {
  const projectSettings = join(CWD, '.mipham', 'settings.json')

  beforeEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
    mkdirSync(join(CWD, '.mipham'), { recursive: true })
    mkdirSync(MIPHAM_HOME, { recursive: true })
  })

  afterEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
  })

  const read = () => JSON.parse(readFileSync(projectSettings, 'utf-8'))

  it('creates settings.json with the rule', () => {
    const path = addSettingsRule('allow', 'Bash(npm test)', 'project', CWD)
    expect(path).toBe(projectSettings)
    expect(read().permissions.allow).toEqual(['Bash(npm test)'])
  })

  it('round-trips through loadSettingsJson', () => {
    addSettingsRule('deny', 'Bash(rm *)', 'project', CWD)
    expect(loadSettingsJson(CWD).permissions.deny).toEqual(['Bash(rm *)'])
  })

  it('preserves hooks and unmodelled keys', () => {
    writeFileSync(
      projectSettings,
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] },
        futureKey: { keep: true },
      }),
    )
    addSettingsRule('allow', 'Read', 'project', CWD)
    const doc = read()
    expect(doc.hooks.PreToolUse).toHaveLength(1)
    expect(doc.futureKey).toEqual({ keep: true })
    expect(doc.permissions.allow).toEqual(['Read'])
  })

  it('is idempotent — re-adding does not duplicate', () => {
    addSettingsRule('allow', 'Read', 'project', CWD)
    addSettingsRule('allow', 'Read', 'project', CWD)
    expect(read().permissions.allow).toEqual(['Read'])
  })

  it('refuses to clobber a malformed file', () => {
    writeFileSync(projectSettings, 'not json')
    expect(() => addSettingsRule('allow', 'Read', 'project', CWD)).toThrow(/not valid JSON/)
    expect(readFileSync(projectSettings, 'utf-8')).toBe('not json')
  })

  it('removes from allow and reports where it was', () => {
    addSettingsRule('allow', 'Read', 'project', CWD)
    expect(removeSettingsRule('Read', 'project', CWD)).toEqual({
      path: projectSettings,
      key: 'allow',
    })
    expect(read().permissions.allow).toEqual([])
  })

  it('removes from deny when the rule lives there', () => {
    addSettingsRule('deny', 'Bash(rm *)', 'project', CWD)
    expect(removeSettingsRule('Bash(rm *)', 'project', CWD)?.key).toBe('deny')
    expect(read().permissions.deny).toEqual([])
  })

  it('returns null and leaves the file alone when the rule is absent', () => {
    addSettingsRule('allow', 'Read', 'project', CWD)
    const before = readFileSync(projectSettings, 'utf-8')
    expect(removeSettingsRule('Bash(nope)', 'project', CWD)).toBeNull()
    expect(readFileSync(projectSettings, 'utf-8')).toBe(before)
  })
})
