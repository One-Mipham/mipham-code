'use client'

import { PACKAGE_NAME } from '@mipham/shared'
import { useI18n } from '@/i18n/context'

export default function DocsPage() {
  const { t } = useI18n()
  return (
    <div className="max-w-3xl mx-auto py-16 px-6">
      <h1 className="text-4xl font-bold mb-8">{t('web.docs.title')}</h1>
      <div className="prose max-w-none">
        <h2>{t('web.docs.quick_start')}</h2>
        <pre className="bg-gray-100 p-4 rounded-lg">
          {`npm install -g ${PACKAGE_NAME}
mipham --model claude-sonnet-4-6`}
        </pre>

        <h2>{t('web.docs.configuration')}</h2>
        <p>
          Create <code>~/.mipham/config.yml</code>:
        </p>
        <pre className="bg-gray-100 p-4 rounded-lg">
          {`version: "0.2.2"
defaultProvider: anthropic
defaultModel: claude-sonnet-4-6
permission: auto`}
        </pre>

        <h2>{t('web.docs.commands')}</h2>
        <ul>
          <li>
            <code>/help</code> — {t('web.docs.help')}
          </li>
          <li>
            <code>/model</code> — {t('web.docs.model')}
          </li>
          <li>
            <code>/switch &lt;provider&gt; &lt;model&gt;</code> — {t('web.docs.switch')}
          </li>
          <li>
            <code>/clear</code> — {t('web.docs.clear')}
          </li>
          <li>
            <code>/exit</code> — {t('web.docs.exit')}
          </li>
        </ul>
      </div>
    </div>
  )
}
