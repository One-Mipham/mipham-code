'use client'

import { useI18n } from '@/i18n/context'

const featureKeys = [
  {
    key: 'multi_model',
    icon: '\u{1F504}',
  },
  {
    key: 'slash_commands',
    icon: '\u{26A1}',
  },
  {
    key: 'plugins',
    icon: '\u{1F4E6}',
  },
  {
    key: 'loopkit',
    icon: '\u{1F3D7}\u{FE0F}',
  },
  {
    key: 'mcp',
    icon: '\u{1F50C}',
  },
  {
    key: 'secure',
    icon: '\u{1F512}',
  },
]

export function FeaturesSection() {
  const { t } = useI18n()
  return (
    <section className="py-20 px-6 bg-white">
      <div className="max-w-6xl mx-auto">
        <h2 className="text-3xl font-bold text-center mb-12">{t('web.features.title')}</h2>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
          {featureKeys.map((f) => (
            <div
              key={f.key}
              className="p-6 rounded-xl border border-gray-200 hover:border-mipham-300 hover:shadow-lg transition-all"
            >
              <div className="text-3xl mb-3">{f.icon}</div>
              <h3 className="text-xl font-semibold mb-2">
                {t(`web.features.${f.key}.title`)}
              </h3>
              <p className="text-gray-600">{t(`web.features.${f.key}.desc`)}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
