'use client'

import { useI18n } from '@/i18n/context'

export default function DashboardPage() {
  const { t } = useI18n()
  return (
    <div className="max-w-4xl mx-auto py-16 px-6 text-center">
      <h1 className="text-4xl font-bold mb-8">{t('web.dashboard.title')}</h1>

      <div className="max-w-lg mx-auto mb-12">
        <div className="p-8 bg-gradient-to-br from-mipham-50 to-white rounded-2xl border border-mipham-100">
          <div className="text-6xl mb-4">{'\u{1F6A7}'}</div>
          <h2 className="text-2xl font-semibold text-mipham-800 mb-3">
            {t('web.dashboard.coming_soon')}
          </h2>
          <p className="text-gray-600 leading-relaxed">{t('web.dashboard.description')}</p>
        </div>
      </div>

      <div className="grid md:grid-cols-3 gap-6 max-w-2xl mx-auto">
        <div className="p-6 bg-white rounded-lg border border-gray-200 opacity-60">
          <div className="text-lg font-medium text-gray-400">{t('web.dashboard.sessions')}</div>
          <div className="text-sm text-gray-400 mt-1">{t('web.dashboard.sessions_desc')}</div>
        </div>
        <div className="p-6 bg-white rounded-lg border border-gray-200 opacity-60">
          <div className="text-lg font-medium text-gray-400">{t('web.dashboard.tokens')}</div>
          <div className="text-sm text-gray-400 mt-1">{t('web.dashboard.tokens_desc')}</div>
        </div>
        <div className="p-6 bg-white rounded-lg border border-gray-200 opacity-60">
          <div className="text-lg font-medium text-gray-400">{t('web.dashboard.skills')}</div>
          <div className="text-sm text-gray-400 mt-1">{t('web.dashboard.skills_desc')}</div>
        </div>
      </div>
    </div>
  )
}
