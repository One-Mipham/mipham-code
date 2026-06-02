export default function DashboardPage() {
  return (
    <div className="max-w-4xl mx-auto py-16 px-6">
      <h1 className="text-4xl font-bold mb-8">Dashboard</h1>
      <div className="grid md:grid-cols-3 gap-6 mb-12">
        <div className="p-6 bg-white rounded-lg border border-gray-200">
          <div className="text-2xl font-bold text-mipham-600">—</div>
          <div className="text-sm text-gray-500">Sessions Today</div>
        </div>
        <div className="p-6 bg-white rounded-lg border border-gray-200">
          <div className="text-2xl font-bold text-mipham-600">—</div>
          <div className="text-sm text-gray-500">Tokens Used</div>
        </div>
        <div className="p-6 bg-white rounded-lg border border-gray-200">
          <div className="text-2xl font-bold text-mipham-600">—</div>
          <div className="text-sm text-gray-500">Active Skills</div>
        </div>
      </div>
      <p className="text-gray-500 text-center">
        Dashboard analytics available after first session.
      </p>
    </div>
  )
}
