export default function DashboardPage() {
  return (
    <div className="max-w-4xl mx-auto py-16 px-6 text-center">
      <h1 className="text-4xl font-bold mb-8">Dashboard</h1>

      <div className="max-w-lg mx-auto mb-12">
        <div className="p-8 bg-gradient-to-br from-mipham-50 to-white rounded-2xl border border-mipham-100">
          <div className="text-6xl mb-4">🚧</div>
          <h2 className="text-2xl font-semibold text-mipham-800 mb-3">
            Coming Soon
          </h2>
          <p className="text-gray-600 leading-relaxed">
            The Mipham Code dashboard will show your usage analytics —
            session history, token consumption, most-used models and tools,
            and skill activity. We&apos;re building this now.
          </p>
        </div>
      </div>

      <div className="grid md:grid-cols-3 gap-6 max-w-2xl mx-auto">
        <div className="p-6 bg-white rounded-lg border border-gray-200 opacity-60">
          <div className="text-lg font-medium text-gray-400">Sessions</div>
          <div className="text-sm text-gray-400 mt-1">Session history &amp; stats</div>
        </div>
        <div className="p-6 bg-white rounded-lg border border-gray-200 opacity-60">
          <div className="text-lg font-medium text-gray-400">Tokens</div>
          <div className="text-sm text-gray-400 mt-1">Usage across providers</div>
        </div>
        <div className="p-6 bg-white rounded-lg border border-gray-200 opacity-60">
          <div className="text-lg font-medium text-gray-400">Skills</div>
          <div className="text-sm text-gray-400 mt-1">Active skill analytics</div>
        </div>
      </div>
    </div>
  )
}
