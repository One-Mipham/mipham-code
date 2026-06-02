export function InstallSection() {
  return (
    <section className="py-20 px-6 bg-mipham-900 text-white">
      <div className="max-w-3xl mx-auto text-center">
        <h2 className="text-3xl font-bold mb-6">Get Started in Seconds</h2>
        <p className="text-mipham-300 mb-8">
          Install globally via npm and start coding with any model.
        </p>
        <div className="bg-mipham-950 rounded-lg p-4 font-mono text-sm text-left text-mipham-200 mb-4 max-w-md mx-auto overflow-x-auto">
          <span className="text-mipham-400">$</span> npm install -g mipham-code
          <br />
          <span className="text-mipham-400">$</span> mipham --model claude-sonnet-4-6
        </div>
        <p className="text-mipham-400 text-sm">
          Requires Bun 1.2+ or Node.js 22+. See{' '}
          <a href="/code/install" className="text-mipham-300 underline">
            full installation guide
          </a>
          .
        </p>
      </div>
    </section>
  )
}
