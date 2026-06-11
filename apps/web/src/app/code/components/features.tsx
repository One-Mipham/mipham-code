const features = [
  {
    title: 'Multi-Model',
    description:
      'Connect to Claude, GPT, DeepSeek, Qwen, and more through a unified interface. Switch models on the fly.',
    icon: '🔄',
  },
  {
    title: 'Open-Core',
    description:
      'Free and open-source core with Apache 2.0 license. Extend with plugins, skills, and custom providers.',
    icon: '📖',
  },
  {
    title: 'Blazing Fast',
    description:
      'Built on Bun runtime with SSE streaming. Sub-millisecond tool execution. Zero-config startup.',
    icon: '⚡',
  },
  {
    title: '16 Built-in Tools',
    description:
      'File operations, shell commands, git, web search, MCP protocol, and agent orchestration.',
    icon: '🛠️',
  },
  {
    title: 'Skills System',
    description:
      'Extensible skill framework with dual-track runtime: open-standard SKILL.md and Mipham-exclusive capabilities.',
    icon: '🎯',
  },
  {
    title: 'Enterprise Ready',
    description:
      'Production security with TLS 1.3, AES-256-GCM encryption, and comprehensive permission system.',
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
