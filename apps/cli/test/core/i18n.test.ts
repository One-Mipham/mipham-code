import { describe, it, expect, afterEach, vi } from 'vitest'
import { createT } from '@mipham/shared/i18n/t'
import { detectLocale } from '@mipham/shared/i18n/detect'
import type { TranslationMap } from '@mipham/shared/i18n/types'

// Prevent detectOSLocale() from leaking the host machine's locale.
// The static import of execSync in detect.ts is intercepted by vitest.
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => {
    throw new Error('OS locale detection disabled in test — use env vars instead')
  }),
}))

const en: TranslationMap = {
  hello: 'Hello',
  greeting: 'Hello {name}',
  nested: { key: 'Nested value' },
  commands: { clear: { confirmed: '✓ Cleared' } },
}
const zh: TranslationMap = {
  hello: '你好',
  greeting: '你好 {name}',
  commands: { clear: { confirmed: '✓ 对话已清除' } },
}

describe('t()', () => {
  const t = createT(zh, en)

  it('returns translation for known key', () => {
    expect(t('hello')).toBe('你好')
  })

  it('falls back to en-US for missing key in current locale', () => {
    expect(t('nested.key')).toBe('Nested value')
  })

  it('returns key itself when missing in both locales', () => {
    expect(t('nonexistent.key')).toBe('nonexistent.key')
  })

  it('interpolates params with {param} syntax', () => {
    expect(t('greeting', { name: 'World' })).toBe('你好 World')
  })

  it('retains unmatched params as {param}', () => {
    expect(t('hello', { extra: 'x' })).toBe('你好')
  })

  it('handles empty string keys', () => {
    expect(t('')).toBe('')
  })

  it('returns key when nested value is an object, not string', () => {
    const t2 = createT({}, { commands: { clear: { confirmed: 'OK' } } })
    expect(t2('commands')).toBe('commands')
  })
})

describe('detectLocale()', () => {
  afterEach(() => {
    delete process.env.LANG
    delete process.env.LC_ALL
  })

  it('returns locale from --lang flag', () => {
    expect(detectLocale({ lang: 'zh-CN' })).toBe('zh-CN')
  })

  it('returns locale from --lang flag (en-US)', () => {
    expect(detectLocale({ lang: 'en-US' })).toBe('en-US')
  })

  it('ignores invalid --lang values and falls through', () => {
    process.env.LANG = 'zh_CN.UTF-8'
    expect(detectLocale({ lang: 'fr-FR' })).toBe('zh-CN')
  })

  it('detects zh-CN from LANG env var (zh_CN.UTF-8)', () => {
    process.env.LANG = 'zh_CN.UTF-8'
    expect(detectLocale({})).toBe('zh-CN')
  })

  it('detects zh-CN from LC_ALL', () => {
    process.env.LC_ALL = 'zh_CN.UTF-8'
    expect(detectLocale({})).toBe('zh-CN')
  })

  it('detects simplified Chinese prefix (zh_*)', () => {
    process.env.LANG = 'zh_SG.UTF-8'
    expect(detectLocale({})).toBe('zh-CN')
  })

  it('falls back to en-US when nothing matches', () => {
    process.env.LANG = 'C'
    expect(detectLocale({})).toBe('en-US')
  })
})
