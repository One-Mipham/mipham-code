const supportedModels = [
  { provider: 'Anthropic', models: ['Claude Opus 4.8', 'Claude Sonnet 4.6', 'Claude Haiku 4.5'], status: 'Active' },
  { provider: 'OpenAI', models: ['GPT-5.5', 'GPT-5.4', 'GPT-5.4 Mini', 'GPT-5.3 Codex'], status: 'Active' },
  { provider: 'DeepSeek', models: ['DeepSeek V4 Pro', 'DeepSeek V4 Flash'], status: 'Active' },
  { provider: 'Qwen (通义千问)', models: ['Qwen Plus', 'Qwen Max'], status: 'Active' },
  { provider: 'MiphamAI', models: ['OM V5 Pro', 'OM V5 Flash', 'OM V5 Visual'], status: 'Upcoming' },
]

export function ModelsSection() {
  return (
    <section className="py-20 px-6 bg-gray-50">
      <div className="max-w-4xl mx-auto">
        <h2 className="text-3xl font-bold text-center mb-12">Supported Models</h2>
        <div className="space-y-4">
          {supportedModels.map(p => (
            <div
              key={p.provider}
              className="bg-white p-5 rounded-lg border border-gray-200 flex flex-col sm:flex-row sm:items-center gap-3"
            >
              <div className="font-semibold text-mipham-700 sm:w-40">{p.provider}</div>
              <div className="flex-1 text-gray-600 text-sm">
                {p.models.join(' · ')}
              </div>
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
