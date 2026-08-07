import type { Metadata } from 'next'
import './globals.css'
import { I18nLayoutWrapper } from '@/i18n/layout'

export const metadata: Metadata = {
  title: 'Mipham Code — AI Coding Terminal',
  description:
    'Multi-model open-core intelligent coding terminal. Powered by One Mipham Corporation.',
}

export default function CodeLayout({ children }: { children: React.ReactNode }) {
  return (
    <I18nLayoutWrapper>
      <body className="bg-white text-gray-900 antialiased">{children}</body>
    </I18nLayoutWrapper>
  )
}
