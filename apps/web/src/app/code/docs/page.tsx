export default function DocsPage() {
  return (
    <div className="max-w-3xl mx-auto py-16 px-6">
      <h1 className="text-4xl font-bold mb-8">Documentation</h1>
      <div className="prose max-w-none">
        <h2>Quick Start</h2>
        <pre className="bg-gray-100 p-4 rounded-lg">
          {`npm install -g mipham-code
mipham --model claude-sonnet-4-6`}
        </pre>

        <h2>Configuration</h2>
        <p>Create <code>~/.mipham/config.yml</code>:</p>
        <pre className="bg-gray-100 p-4 rounded-lg">
          {`version: "0.1.0"
defaultProvider: anthropic
defaultModel: claude-sonnet-4-6
permission: auto`}
        </pre>

        <h2>Commands</h2>
        <ul>
          <li><code>/help</code> — Show help</li>
          <li><code>/model</code> — Show current model</li>
          <li><code>/switch &lt;provider&gt; &lt;model&gt;</code> — Switch model</li>
          <li><code>/clear</code> — Clear conversation</li>
          <li><code>/exit</code> — Exit Mipham Code</li>
        </ul>
      </div>
    </div>
  )
}
