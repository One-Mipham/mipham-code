export type Locale = 'en-US' | 'zh-CN'

export const SUPPORTED_LOCALES: Locale[] = ['en-US', 'zh-CN']

export const FALLBACK_LOCALE: Locale = 'en-US'

/** A TranslationMap is a nested object where leaves are template strings. */
export interface TranslationMap {
  [key: string]: string | TranslationMap
}
