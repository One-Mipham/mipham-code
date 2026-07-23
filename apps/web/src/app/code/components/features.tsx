const features = [
  {
    title: 'Multi-Model',
    description:
      'Connect to Claude, GPT, DeepSeek, Qwen, Kimi, and more through a unified interface. Switch models on the fly with Ctrl+P.',
    icon: '🔄',
  },
  {
    title: '85 Slash Commands',
    description:
      'Full Claude Code parity: /commit, /pr, /simplify, /lint, /loop init, /browse-plugins — all 85 commands with zero learning curve.',
    icon: '⚡',
  },
  {
    title: 'Plugin Marketplace',
    description:
      'Install plugins from npm or local paths. Discover community plugins including NotebookLM MCP integration.',
    icon: '📦',
  },
  {
    title: 'LoopKit Vault',
    description:
      '/loop init scaffolds a complete project structure: .mipham/ config, hooks, agents, 9-domain skills, .mcp.json, and more.',
    icon: '🏗️',
  },
  {
    title: 'MCP Protocol',
    description:
      'Full Model Context Protocol support with stdio transport. Connect to NotebookLM, filesystem, GitHub, and custom MCP servers.',
    icon: '🔌',
  },
  {
    title: 'Open-Core & Secure',
    description:
      'Apache 2.0 license. TLS 1.3, AES-256-GCM encryption, comprehensive permission system. Enterprise security out of the box.',
    icon: '🔒',
  },
]

export function FeaturesSection() {
  return (
    <section className="py-20 px-6 bg-white">
      <div className="max-w-6xl mx-auto">
        <h2 className="text-3xl font-bold text-center mb-12">Why Mipham Code?</h2>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
          {features.map((f) => (
            <div
              key={f.title}
              className="p-6 rounded-xl border border-gray-200 hover:border-mipham-300 hover:shadow-lg transition-all"
            >
              <div className="text-3xl mb-3">{f.icon}</div>
              <h3 className="text-xl font-semibold mb-2">{f.title}</h3>
              <p className="text-gray-600">{f.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
