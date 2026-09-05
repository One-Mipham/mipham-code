import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// Isolate from the real ~/.mipham/skill-usage.json — otherwise these tests would
// pollute the live usage record. Mock homedir to a temp dir.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-skill-usage`,
  }
})

import { loadSkillUsage, recordSkillUsage } from '../../src/skills/usage'

const MIPHAM_DIR = join(homedir(), '.mipham')
const USAGE_FILE = join(MIPHAM_DIR, 'skill-usage.json')

beforeEach(() => {
  rmSync(MIPHAM_DIR, { recursive: true, force: true })
})

afterEach(() => {
  rmSync(MIPHAM_DIR, { recursive: true, force: true })
})

describe('skill usage persistence', () => {
  it('returns an empty map when no file exists', () => {
    expect(loadSkillUsage()).toEqual(new Map())
  })

  it('round-trips record → load', () => {
    recordSkillUsage('code-review', 1000)
    recordSkillUsage('tdd', 2000)
    const map = loadSkillUsage()
    expect(map.get('code-review')).toBe(1000)
    expect(map.get('tdd')).toBe(2000)
  })

  it('overwrites the timestamp for an already-recorded skill', () => {
    recordSkillUsage('code-review', 1000)
    recordSkillUsage('code-review', 2000)
    expect(loadSkillUsage().get('code-review')).toBe(2000)
  })

  it('returns an empty map on a corrupt file', () => {
    mkdirSync(MIPHAM_DIR, { recursive: true })
    writeFileSync(USAGE_FILE, '{invalid json')
    expect(loadSkillUsage()).toEqual(new Map())
  })

  it('ignores non-number values on load', () => {
    mkdirSync(MIPHAM_DIR, { recursive: true })
    writeFileSync(USAGE_FILE, JSON.stringify({ a: 'not-a-number', b: 42 }))
    const map = loadSkillUsage()
    expect(map.get('a')).toBeUndefined()
    expect(map.get('b')).toBe(42)
  })
})
