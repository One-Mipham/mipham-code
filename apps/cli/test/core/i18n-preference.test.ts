/**
 * /lang persistence: the choice survives restart, and detection prefers it
 * over the environment (otherwise `LANG=zh_CN.UTF-8` would override a user who
 * explicitly chose en-US).
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => `${actual.tmpdir()}/mipham-test-i18n-pref-home` }
})
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => {
    throw new Error('OS locale detection disabled in test — use env vars instead')
  }),
}))

const { detectLocale } = await import('../../src/i18n-core/detect')
const { readLocalePreference, saveLocalePreference } =
  await import('../../src/i18n-core/preference')

const HOME = join(tmpdir(), 'mipham-test-i18n-pref-home')
const SETTINGS = join(HOME, '.mipham', 'settings.json')

beforeEach(() => {
  rmSync(HOME, { recursive: true, force: true })
  delete process.env.LANG
  delete process.env.LC_ALL
})

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true })
  delete process.env.LANG
  delete process.env.LC_ALL
})

describe('locale preference store', () => {
  it('round-trips a saved locale', () => {
    expect(saveLocalePreference('zh-CN')).toBe(true)
    expect(readLocalePreference()).toBe('zh-CN')
  })

  it('preserves unrelated settings keys', () => {
    mkdirSync(join(HOME, '.mipham'), { recursive: true })
    writeFileSync(SETTINGS, JSON.stringify({ telemetry: { enabled: true } }), 'utf-8')
    saveLocalePreference('en-US')
    const parsed = JSON.parse(readFileSync(SETTINGS, 'utf-8'))
    expect(parsed.telemetry).toEqual({ enabled: true })
    expect(parsed.locale).toBe('en-US')
  })

  it('treats an unsupported stored value as absent', () => {
    mkdirSync(join(HOME, '.mipham'), { recursive: true })
    writeFileSync(SETTINGS, JSON.stringify({ locale: 'fr-FR' }), 'utf-8')
    expect(readLocalePreference()).toBeNull()
  })

  it('treats a corrupt file as absent', () => {
    mkdirSync(join(HOME, '.mipham'), { recursive: true })
    writeFileSync(SETTINGS, '{not json', 'utf-8')
    expect(readLocalePreference()).toBeNull()
  })
})

describe('detectLocale precedence', () => {
  it('--lang wins over a saved preference', () => {
    expect(detectLocale({ lang: 'en-US', settingsLocale: 'zh-CN' })).toBe('en-US')
  })

  it('a saved preference wins over LANG', () => {
    process.env.LANG = 'zh_CN.UTF-8'
    expect(detectLocale({ settingsLocale: 'en-US' })).toBe('en-US')
  })

  it('falls through to LANG when nothing is saved', () => {
    process.env.LANG = 'zh_CN.UTF-8'
    expect(detectLocale({ settingsLocale: null })).toBe('zh-CN')
  })
})
