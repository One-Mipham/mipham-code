'use client'

import { useI18n } from '@/i18n/context'

export default function CodeError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const { t } = useI18n()
  return (
    <div className="max-w-4xl mx-auto py-24 px-6 text-center">
      <h1 className="text-4xl font-bold mb-4">{t('web.error.title')}</h1>
      <p className="text-gray-600 mb-8">
        {error.message || t('web.error.fallback_message')}
      </p>
      <button
        onClick={reset}
        className="bg-mipham-500 hover:bg-mipham-400 text-white font-semibold py-2 px-6 rounded-lg transition-colors"
      >
        {t('web.error.try_again')}
      </button>
    </div>
  )
}
