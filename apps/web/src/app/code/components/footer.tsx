'use client'

import { useI18n } from '@/i18n/context'

export function FooterSection() {
  const { t } = useI18n()
  return (
    <footer className="py-10 px-6 bg-gray-100 border-t border-gray-200">
      <div className="max-w-6xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4 text-sm text-gray-500">
        <div>{t('web.footer.copyright', { year: String(new Date().getFullYear()) })}</div>
        <div className="flex gap-6">
          <a href="/code/docs" className="hover:text-mipham-600 transition-colors">
            {t('web.footer.docs')}
          </a>
          <a href="/code/dashboard" className="hover:text-mipham-600 transition-colors">
            {t('web.footer.dashboard')}
          </a>
          <a
            href="https://github.com/mipham-ai/mipham-code"
            className="hover:text-mipham-600 transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('web.footer.github')}
          </a>
        </div>
      </div>
    </footer>
  )
}
