'use client'

import { PACKAGE_NAME } from '@mipham/shared'
import { useI18n } from '@/i18n/context'

export function InstallSection() {
  const { t } = useI18n()
  return (
    <section className="py-20 px-6 bg-mipham-900 text-white">
      <div className="max-w-3xl mx-auto text-center">
        <h2 className="text-3xl font-bold mb-6">{t('web.install_section.title')}</h2>
        <p className="text-mipham-300 mb-8">{t('web.install_section.subtitle')}</p>

        {/* npm */}
        <h3 className="text-lg font-semibold text-mipham-200 mb-2">
          {t('web.install_section.npm_recommended')}
        </h3>
        <div className="bg-mipham-950 rounded-lg p-4 font-mono text-sm text-left text-mipham-200 mb-6 max-w-md mx-auto overflow-x-auto">
          <span className="text-mipham-400">$</span> npm install -g {PACKAGE_NAME}
          <br />
          <span className="text-mipham-400">$</span> mipham
        </div>

        {/* macOS / Linux curl */}
        <h3 className="text-lg font-semibold text-mipham-200 mb-2">
          {t('web.install_section.curl_label')}
        </h3>
        <div className="bg-mipham-950 rounded-lg p-4 font-mono text-sm text-left text-mipham-200 mb-2 max-w-md mx-auto overflow-x-auto">
          <span className="text-mipham-400">$</span> curl -fsSL https://mipham.ai/install.sh | bash
        </div>
        <p className="text-mipham-500 text-xs mb-1">{t('web.install_section.label_international')}</p>
        <div className="bg-mipham-950 rounded-lg p-4 font-mono text-sm text-left text-mipham-200 mb-6 max-w-md mx-auto overflow-x-auto">
          <span className="text-mipham-400">$</span> curl -fsSL https://onemipham.com/install.sh |
          bash
        </div>
        <p className="text-mipham-500 text-xs mb-6">{t('web.install_section.label_china')}</p>

        {/* Windows PowerShell */}
        <h3 className="text-lg font-semibold text-mipham-200 mb-2">
          {t('web.install_section.powershell_label')}
        </h3>
        <div className="bg-mipham-950 rounded-lg p-4 font-mono text-sm text-left text-mipham-200 mb-2 max-w-md mx-auto overflow-x-auto">
          <span className="text-mipham-400">&gt;</span> irm https://mipham.ai/install.ps1 | iex
        </div>
        <p className="text-mipham-500 text-xs mb-1">{t('web.install_section.label_international')}</p>
        <div className="bg-mipham-950 rounded-lg p-4 font-mono text-sm text-left text-mipham-200 mb-6 max-w-md mx-auto overflow-x-auto">
          <span className="text-mipham-400">&gt;</span> irm https://onemipham.com/install.ps1 | iex
        </div>
        <p className="text-mipham-500 text-xs mb-6">{t('web.install_section.label_china')}</p>

        <p className="text-mipham-400 text-sm">
          {t('web.install_section.requirements')}{' '}
          <a href="/code/install" className="text-mipham-300 underline">
            {t('web.install_section.full_guide')}
          </a>
        </p>
      </div>
    </section>
  )
}
