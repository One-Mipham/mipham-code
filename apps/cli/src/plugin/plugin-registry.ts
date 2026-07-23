/**
 * Mipham Code — Community Plugin Registry
 *
 * Provides a discoverable list of community plugins installable via npm.
 * Mirrors the community skill registry pattern.
 */

export interface CommunityPlugin {
  /** Unique plugin name (kebab-case) */
  name: string
  /** One-line description */
  description: string
  /** npm package name */
  npmPackage: string
  /** Category for grouping */
  category: string
  /** Author */
  author: string
}

const COMMUNITY_PLUGINS: CommunityPlugin[] = [
  {
    name: 'notebooklm',
    description: 'Google NotebookLM integration — citation-backed Q&A, content generation, 31 tools',
    npmPackage: '@roomi-fields/notebooklm-mcp',
    category: 'AI & Data',
    author: 'roomi-fields',
  },
  {
    name: 'plugin-dev',
    description: 'Plugin development toolkit — scaffolding, testing, and build utilities',
    npmPackage: 'mipham-plugin-dev',
    category: 'Development',
    author: 'MiphamAI',
  },
  {
    name: 'security-scanner',
    description: 'Enhanced security scanning — dependency audit, SAST, secret detection',
    npmPackage: 'mipham-plugin-security',
    category: 'Security',
    author: 'MiphamAI',
  },
  {
    name: 'db-explorer',
    description: 'Database exploration — SQL generation, schema analysis, query optimization',
    npmPackage: 'mipham-plugin-db',
    category: 'Data',
    author: 'MiphamAI',
  },
  {
    name: 'i18n',
    description: 'Internationalization helper — translation, locale detection, i18n key management',
    npmPackage: 'mipham-plugin-i18n',
    category: 'Development',
    author: 'MiphamAI',
  },
]

export function getAvailablePlugins(): CommunityPlugin[] {
  return [...COMMUNITY_PLUGINS]
}

export function searchPlugins(query: string): CommunityPlugin[] {
  const q = query.toLowerCase()
  return COMMUNITY_PLUGINS.filter(
    (p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q),
  )
}
