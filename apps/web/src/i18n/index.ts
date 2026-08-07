import enUS from '@mipham/shared/i18n/locales/en-US.json'
import zhCN from '@mipham/shared/i18n/locales/zh-CN.json'
import type { TranslationMap, Locale } from '@mipham/shared/i18n/types'

export const bundles: Record<Locale, TranslationMap> = {
  'en-US': enUS as TranslationMap,
  'zh-CN': zhCN as TranslationMap,
}

export function detectWebLocale(): Locale {
  if (typeof window === 'undefined') return 'en-US'
  const nav = window.navigator.language
  if (nav.toLowerCase().startsWith('zh')) return 'zh-CN'
  return 'en-US'
}
