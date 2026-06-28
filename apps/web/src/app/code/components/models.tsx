import { DEFAULT_PROVIDERS } from '@mipham/shared'

// Derive display data from the shared source of truth.
// Select the top ~3 active models per provider for the marketing overview.
function getDisplayModels(): Array<{
  provider: string
  models: string[]
  status: string
}> {
  return DEFAULT_PROVIDERS.map((p) => {
    const active = p.models.filter((m) => m.status !== 'deprecated')
    // Take top models (max 4 for providers with many models, 2-3 for others)
    const top = active.slice(0, p.id === 'hunyuan' || p.id === 'doubao' ? 4 : 3)
    return {
      provider: p.name,
      models: top.map((m) => m.name),
      status: p.status === 'upcoming' ? 'Upcoming' : 'Active',
    }
  })
}

export function ModelsSection() {
  const supportedModels = getDisplayModels()
  return (
    <section className="py-20 px-6 bg-gray-50">
      <div className="max-w-4xl mx-auto">
        <h2 className="text-3xl font-bold text-center mb-12">Supported Models</h2>
        <div className="space-y-4">
          {supportedModels.map((p) => (
            <div
              key={p.provider}
              className="bg-white p-5 rounded-lg border border-gray-200 flex flex-col sm:flex-row sm:items-center gap-3"
            >
              <div className="font-semibold text-mipham-700 sm:w-40">{p.provider}</div>
              <div className="flex-1 text-gray-600 text-sm">{p.models.join(' · ')}</div>
              <span
                className={`text-xs font-medium px-2 py-1 rounded ${
                  p.status === 'Active'
                    ? 'bg-green-100 text-green-700'
                    : 'bg-yellow-100 text-yellow-700'
                }`}
              >
                {p.status}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
