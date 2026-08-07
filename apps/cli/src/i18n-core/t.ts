import type { TranslationMap } from './types'

function getNested(obj: TranslationMap, key: string): unknown {
  return key.split('.').reduce((o, k) => (o as any)?.[k], obj as any)
}

export function createT(
  current: TranslationMap,
  fallback: TranslationMap,
): (key: string, params?: Record<string, string>) => string {
  return function t(key: string, params?: Record<string, string>): string {
    const val = getNested(current, key) ?? getNested(fallback, key) ?? key
    if (typeof val !== 'string') return key
    if (params) {
      return val.replace(/\{(\w+)\}/g, (_, k: string) => params[k] ?? '')
    }
    return val
  }
}
