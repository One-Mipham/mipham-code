import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Isolate from the real ~/.mipham — loadSettingsJson reads settings.json there.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-settings-json`,
  }
})

import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadSettingsJson } from '../../src/config/loader'

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
