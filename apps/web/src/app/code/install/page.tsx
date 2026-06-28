import { PACKAGE_NAME, PACKAGE_VERSION, GITHUB_REPO } from '@mipham/shared'

const REL_DL = `${GITHUB_REPO}/releases/latest/download`

export default function InstallPage() {
  return (
    <div className="max-w-3xl mx-auto py-16 px-6">
      <h1 className="text-4xl font-bold mb-4">Installation</h1>
      <p className="text-gray-500 mb-4">
        Current version: <strong>v{PACKAGE_VERSION}</strong>. Choose your platform and preferred install method.
      </p>
      <p className="text-gray-500 mb-8">
        All methods install the same Mipham Code.
      </p>

      {/* Prerequisites */}
      <h2 className="text-2xl font-semibold mb-4">Prerequisites</h2>
      <ul className="list-disc pl-6 mb-8 space-y-2">
        <li>
          <strong>Bun 1.2+</strong> (recommended) or <strong>Node.js 22+</strong>
        </li>
        <li>macOS, Linux, or Windows (PowerShell)</li>
        <li>At least one AI provider API key (e.g., Anthropic, OpenAI)</li>
      </ul>

      {/* npm */}
      <h2 className="text-2xl font-semibold mb-4">1. npm Install (Recommended)</h2>
      <p className="mb-2 text-gray-600">Works on all platforms — macOS, Linux, Windows.</p>
      <pre className="bg-gray-100 dark:bg-gray-800 p-4 rounded-lg mb-8 overflow-x-auto">
        npm install -g {PACKAGE_NAME}
      </pre>

      {/* curl macOS/Linux */}
      <h2 className="text-2xl font-semibold mb-4">2. curl Install (macOS / Linux)</h2>
      <div className="mb-6">
        <h3 className="font-semibold mb-1">International · 国际站</h3>
        <pre className="bg-gray-100 dark:bg-gray-800 p-4 rounded-lg mb-2 overflow-x-auto">
          curl -fsSL https://mipham.ai/install.sh | bash
        </pre>
      </div>
      <div className="mb-8">
        <h3 className="font-semibold mb-1">中国大陆 · China mainland</h3>
        <pre className="bg-gray-100 dark:bg-gray-800 p-4 rounded-lg mb-2 overflow-x-auto">
          curl -fsSL https://onemipham.com/install.sh | bash
        </pre>
      </div>

      {/* PowerShell Windows */}
      <h2 className="text-2xl font-semibold mb-4">3. PowerShell Install (Windows)</h2>
      <div className="mb-6">
        <h3 className="font-semibold mb-1">International · 国际站</h3>
        <pre className="bg-gray-100 dark:bg-gray-800 p-4 rounded-lg mb-2 overflow-x-auto">
          irm https://mipham.ai/install.ps1 | iex
        </pre>
      </div>
      <div className="mb-8">
        <h3 className="font-semibold mb-1">中国大陆 · China mainland</h3>
        <pre className="bg-gray-100 dark:bg-gray-800 p-4 rounded-lg mb-2 overflow-x-auto">
          irm https://onemipham.com/install.ps1 | iex
        </pre>
      </div>

      {/* Direct Download */}
      <h2 className="text-2xl font-semibold mb-4">4. Direct Download</h2>
      <div className="overflow-x-auto mb-8">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b">
              <th className="py-2 pr-4">Platform</th>
              <th className="py-2">Download</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b">
              <td className="py-2 pr-4">macOS (Apple Silicon)</td>
              <td className="py-2">
                <a href={`${REL_DL}/mipham-darwin-arm64`} className="text-mipham-600 hover:underline font-mono text-sm">
                  mipham-darwin-arm64 ↓
                </a>
              </td>
            </tr>
            <tr className="border-b">
              <td className="py-2 pr-4">macOS (Intel)</td>
              <td className="py-2">
                <a href={`${REL_DL}/mipham-darwin-x64`} className="text-mipham-600 hover:underline font-mono text-sm">
                  mipham-darwin-x64 ↓
                </a>
              </td>
            </tr>
            <tr className="border-b">
              <td className="py-2 pr-4">Linux (x64)</td>
              <td className="py-2">
                <a href={`${REL_DL}/mipham-linux-x64`} className="text-mipham-600 hover:underline font-mono text-sm">
                  mipham-linux-x64 ↓
                </a>
              </td>
            </tr>
            <tr className="border-b">
              <td className="py-2 pr-4">Windows (x64)</td>
              <td className="py-2">
                <a href={`${REL_DL}/mipham-win-x64.exe`} className="text-mipham-600 hover:underline font-mono text-sm">
                  mipham-win-x64.exe ↓
                </a>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Verify */}
      <h2 className="text-2xl font-semibold mb-4">Verify Installation</h2>
      <pre className="bg-gray-100 dark:bg-gray-800 p-4 rounded-lg mb-8 overflow-x-auto">
        mipham --version
      </pre>

      {/* Start */}
      <h2 className="text-2xl font-semibold mb-4">Start Mipham Code</h2>
      <pre className="bg-gray-100 dark:bg-gray-800 p-4 rounded-lg mb-8 overflow-x-auto">mipham</pre>
      <p className="text-gray-600 mb-8">
        On first launch, the interactive setup wizard (<code>/setup</code>) will guide you through
        provider configuration, model selection, skills installation, and permissions.
      </p>

      {/* API Keys */}
      <h2 className="text-2xl font-semibold mb-4">Set API Keys</h2>
      <p className="mb-2 text-gray-600">Export your provider API keys as environment variables:</p>
      <pre className="bg-gray-100 dark:bg-gray-800 p-4 rounded-lg overflow-x-auto">
        {`export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
export DEEPSEEK_API_KEY="sk-..."
export QWEN_API_KEY="sk-..."
export DOUBAO_API_KEY="..."
export HUNYUAN_API_KEY="..."
export GEMINI_API_KEY="..."`}
      </pre>
    </div>
  )
}
