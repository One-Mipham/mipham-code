import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Isolate config loading from the real ~/.mipham — loadConfig() reads config.yml
// and (after a restore) writes it, so tests must not touch the user's live config.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-config-restore`,
  }
})

import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadConfig } from '../../src/config/loader'

const MIPHAM_HOME = join(homedir(), '.mipham')
const FAKE_CWD = join(homedir(), 'project-cwd')

describe('loadConfig — restore config.yml from backup when missing', () => {
  beforeEach(() => {
    rmSync(MIPHAM_HOME, { recursive: true, force: true })
    mkdirSync(MIPHAM_HOME, { recursive: true })
  })

  afterEach(() => {
    rmSync(MIPHAM_HOME, { recursive: true, force: true })
    rmSync(FAKE_CWD, { recursive: true, force: true })
  })

  it('restores from the most recent backup when config.yml is missing', () => {
    // Backup with a non-default provider, but NO config.yml alongside it
    writeFileSync(
      join(MIPHAM_HOME, 'config.backup-2026-08-01T00-00-00-000Z.yml'),
      'defaultProvider: openai\ndefaultModel: gpt-4o\n',
      'utf-8',
    )

    const config = loadConfig(FAKE_CWD)

    // Non-default values prove the backup was restored (defaults are deepseek)
    expect(config.defaultProvider).toBe('openai')
    expect(config.defaultModel).toBe('gpt-4o')
  })

  it('falls back to defaults when neither config.yml nor a backup exists (first run)', () => {
    const config = loadConfig(FAKE_CWD)

    // No config.yml, no backup → defaults (deepseek), not the backup values
    expect(config.defaultProvider).toBe('deepseek')
    expect(config.defaultModel).toBe('deepseek-v4-flash')
  })

  it('an empty config.yml is treated as missing, not as corruption (318-044)', () => {
    // A backup that *would* change settings if the loader decided to restore it.
    writeFileSync(
      join(MIPHAM_HOME, 'config.backup-2026-08-01T00-00-00-000Z.yml'),
      'defaultProvider: openai\ndefaultModel: gpt-4o\n',
      'utf-8',
    )
    const emptyPath = join(MIPHAM_HOME, 'config.yml')
    writeFileSync(emptyPath, '  \n', 'utf-8')

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const config = loadConfig(FAKE_CWD)
      const out = stderr.mock.calls.map((c) => String(c[0])).join('')
      // Empty is what `: > config.yml` leaves behind — not a broken file.
      expect(out).not.toContain('corrupted')
      // And it is not "recovered" from the backup: the user emptied it on purpose.
      expect(config.defaultProvider).toBe('deepseek')
      expect(readFileSync(emptyPath, 'utf-8')).toBe('  \n')
    } finally {
      stderr.mockRestore()
    }
  })

  it('an empty project config.yml is also not reported as corruption', () => {
    const projectConfig = join(FAKE_CWD, '.mipham', 'config.yml')
    mkdirSync(join(FAKE_CWD, '.mipham'), { recursive: true })
    writeFileSync(projectConfig, '', 'utf-8')

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const config = loadConfig(FAKE_CWD)
      const out = stderr.mock.calls.map((c) => String(c[0])).join('')
      expect(out).not.toContain('project config is corrupted')
      expect(config.defaultProvider).toBe('deepseek')
    } finally {
      stderr.mockRestore()
    }
  })
})
