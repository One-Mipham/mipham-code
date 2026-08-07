'use client'

import { I18nProvider } from './context'
import { detectWebLocale } from './index'

export function I18nLayoutWrapper({ children }: { children: React.ReactNode }) {
  const locale = detectWebLocale()
  return (
    <html lang={locale}>
      <I18nProvider initialLocale={locale}>{children}</I18nProvider>
    </html>
  )
}
