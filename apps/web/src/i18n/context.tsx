'use client'

import React, { createContext, useContext, useState, useMemo } from 'react'
import { bundles } from './index'
import { createT } from '@mipham/shared/i18n/t'
import type { Locale } from '@mipham/shared/i18n/types'

interface I18nContextValue {
  locale: Locale
  setLocale: (l: Locale) => void
  t: (key: string, params?: Record<string, string>) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({
  children,
  initialLocale,
}: {
  children: React.ReactNode
  initialLocale: Locale
}) {
  const [locale, setLocale] = useState<Locale>(initialLocale)
  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t: createT(bundles[locale] || bundles['en-US'], bundles['en-US']),
    }),
    [locale],
  )
  return React.createElement(I18nContext.Provider, { value }, children)
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}
