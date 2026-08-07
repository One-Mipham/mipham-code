'use client'

import Link from 'next/link'
import { useI18n } from '@/i18n/context'

export default function CodeNotFound() {
  const { t } = useI18n()
  return (
    <div className="max-w-4xl mx-auto py-24 px-6 text-center">
      <h1 className="text-6xl font-bold text-mipham-600 mb-4">{t('web.not_found.code')}</h1>
      <h2 className="text-2xl font-semibold mb-4">{t('web.not_found.title')}</h2>
      <p className="text-gray-600 mb-8">{t('web.not_found.description')}</p>
      <Link
        href="/code"
        className="bg-mipham-500 hover:bg-mipham-400 text-white font-semibold py-2 px-6 rounded-lg transition-colors inline-block"
      >
        {t('web.not_found.back')}
      </Link>
    </div>
  )
}
