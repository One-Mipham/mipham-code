import React, { createContext, useContext } from 'react'
import type { Locale } from '@mipham/shared/i18n/types'

export interface I18nContextValue {
  locale: Locale
  t: (key: string, params?: Record<string, string>) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({
  locale,
  t,
  children,
}: {
  locale: Locale
  t: (key: string, params?: Record<string, string>) => string
  children: React.ReactNode
}) {
  return React.createElement(
    I18nContext.Provider,
    { value: { locale, t } },
    children,
  )
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) {
    // If no Provider is mounted (e.g., tests, bare scripts), return en-US no-op.
    return {
      locale: 'en-US',
      t: (key: string) => key,
    }
  }
  return ctx
}
