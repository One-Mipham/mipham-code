import { describe, it, expect } from 'vitest'
import { createT } from '../../src/i18n-core/t'
import type { TranslationMap } from '../../src/i18n-core/types'
import en from '../../src/i18n-core/locales/en-US.json'
import zh from '../../src/i18n-core/locales/zh-CN.json'

/**
 * C4: the permission-denial message must name the command that actually
 * resolves the denial. A hint that points at the wrong verb is worse than no
 * hint — a deny rule is *not* lifted by an allow rule (deny always wins), so
 * each reason has to point at its own remedy.
 */
describe('permission denial hints name the resolving command', () => {
  const locales: Array<[string, TranslationMap]> = [
    ['en-US', en as TranslationMap],
    ['zh-CN', zh as TranslationMap],
  ]

  it.each(locales)('%s: deny-rule points at remove, not allow', (_name, locale) => {
    const t = createT(locale, en as TranslationMap)
    const msg = t('errors.tool_denied_deny_rule', { name: 'Bash', pattern: 'Bash(git:*)' })
    expect(msg).toContain('/permissions remove')
    expect(msg).not.toContain('/permissions allow')
  })

  it.each(locales)('%s: ask-rule points at allow', (_name, locale) => {
    const t = createT(locale, en as TranslationMap)
    const msg = t('errors.tool_denied_ask_rule', { name: 'Bash', pattern: 'Bash(npm:*)' })
    expect(msg).toContain('/permissions allow')
  })

  it.each(locales)('%s: mode denial points at allow with the tool name', (_name, locale) => {
    const t = createT(locale, en as TranslationMap)
    const msg = t('errors.tool_denied_mode', { name: 'Write', mode: 'plan' })
    expect(msg).toContain('/permissions allow')
    expect(msg).toContain('Write')
  })

  it.each(locales)('%s: interpolates the rule pattern verbatim', (_name, locale) => {
    const t = createT(locale, en as TranslationMap)
    const msg = t('errors.tool_denied_deny_rule', { name: 'Bash', pattern: 'Bash(rm:*)' })
    expect(msg).toContain('Bash(rm:*)')
  })
})
