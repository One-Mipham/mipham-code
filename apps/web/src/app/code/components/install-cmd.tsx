export function InstallSection() {
  return (
    <section className="py-20 px-6 bg-mipham-900 text-white">
      <div className="max-w-3xl mx-auto text-center">
        <h2 className="text-3xl font-bold mb-6">Install in Seconds</h2>
        <p className="text-mipham-300 mb-8">
          Four ways to install — choose what works for your platform.
        </p>

        {/* npm */}
        <h3 className="text-lg font-semibold text-mipham-200 mb-2">npm (recommended)</h3>
        <div className="bg-mipham-950 rounded-lg p-4 font-mono text-sm text-left text-mipham-200 mb-6 max-w-md mx-auto overflow-x-auto">
          <span className="text-mipham-400">$</span> npm install -g @miphamai/cli
          <br />
          <span className="text-mipham-400">$</span> mipham
        </div>

        {/* macOS / Linux curl */}
        <h3 className="text-lg font-semibold text-mipham-200 mb-2">curl (macOS / Linux)</h3>
        <div className="bg-mipham-950 rounded-lg p-4 font-mono text-sm text-left text-mipham-200 mb-2 max-w-md mx-auto overflow-x-auto">
          <span className="text-mipham-400">$</span> curl -fsSL https://mipham.ai/install.sh | bash
        </div>
        <p className="text-mipham-500 text-xs mb-1">International · 国际站</p>
        <div className="bg-mipham-950 rounded-lg p-4 font-mono text-sm text-left text-mipham-200 mb-6 max-w-md mx-auto overflow-x-auto">
          <span className="text-mipham-400">$</span> curl -fsSL https://onemipham.com/install.sh |
          bash
        </div>
        <p className="text-mipham-500 text-xs mb-6">中国大陆 · China mainland</p>

        {/* Windows PowerShell */}
        <h3 className="text-lg font-semibold text-mipham-200 mb-2">PowerShell (Windows)</h3>
        <div className="bg-mipham-950 rounded-lg p-4 font-mono text-sm text-left text-mipham-200 mb-2 max-w-md mx-auto overflow-x-auto">
          <span className="text-mipham-400">&gt;</span> irm https://mipham.ai/install.ps1 | iex
        </div>
        <p className="text-mipham-500 text-xs mb-1">International · 国际站</p>
        <div className="bg-mipham-950 rounded-lg p-4 font-mono text-sm text-left text-mipham-200 mb-6 max-w-md mx-auto overflow-x-auto">
          <span className="text-mipham-400">&gt;</span> irm https://onemipham.com/install.ps1 | iex
        </div>
        <p className="text-mipham-500 text-xs mb-6">中国大陆 · China mainland</p>

        <p className="text-mipham-400 text-sm">
          Requires Bun 1.2+ or Node.js 22+. Supports macOS, Linux, Windows.{' '}
          <a href="/code/install" className="text-mipham-300 underline">
            Full installation guide
          </a>
        </p>
      </div>
    </section>
  )
}
