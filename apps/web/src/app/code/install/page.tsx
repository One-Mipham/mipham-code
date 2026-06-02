export default function InstallPage() {
  return (
    <div className="max-w-3xl mx-auto py-16 px-6">
      <h1 className="text-4xl font-bold mb-8">Installation</h1>

      <h2 className="text-2xl font-semibold mb-4">Prerequisites</h2>
      <ul className="list-disc pl-6 mb-8 space-y-2">
        <li>Bun 1.2+ or Node.js 22+</li>
        <li>macOS, Linux, or WSL2 (Windows)</li>
      </ul>

      <h2 className="text-2xl font-semibold mb-4">Install via npm</h2>
      <pre className="bg-gray-100 p-4 rounded-lg mb-8">
        npm install -g mipham-code
      </pre>

      <h2 className="text-2xl font-semibold mb-4">Install via Homebrew</h2>
      <pre className="bg-gray-100 p-4 rounded-lg mb-8">
        brew install mipham-code
      </pre>

      <h2 className="text-2xl font-semibold mb-4">Verify Installation</h2>
      <pre className="bg-gray-100 p-4 rounded-lg mb-8">
        mipham --version
      </pre>

      <h2 className="text-2xl font-semibold mb-4">Set API Keys</h2>
      <pre className="bg-gray-100 p-4 rounded-lg">
        {`export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
export DEEPSEEK_API_KEY="sk-..."`}
      </pre>
    </div>
  )
}
